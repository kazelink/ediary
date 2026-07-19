import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError, getContentLength, parseFormBody } from '../lib/http.js';

const router = new Hono();
const MAX_UPLOAD = 100 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};
const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));

function normalizeMime(v) {
  const base = String(v || '').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

function hasAscii(bytes, offset, text) {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function detectMediaMime(bytes) {
  if (bytes.length < 4) return '';

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) return 'image/webp';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';

  if (bytes.length >= 12 && hasAscii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand.startsWith('qt') || ['moov', 'm4v ', 'fqt '].includes(brand)) {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }

  if (bytes.length >= 8 && (hasAscii(bytes, 4, 'moov') || hasAscii(bytes, 4, 'mdat'))) {
    return 'video/quicktime';
  }

  return '';
}

function validateUploadRequest(c, contentLength) {
  if (!c.env.IMG_BUCKET) throw new Error('Storage not configured');
  if (contentLength != null && contentLength > MAX_UPLOAD) {
    throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });
  }
}

async function validateFileContents(file) {
  if (!(file instanceof File)) throw new Error('File required');

  const declaredType = normalizeMime(file.type);
  if (!ALLOWED_MIME.has(declaredType)) throw new Error('Unsupported file type');
  if (file.size > MAX_UPLOAD) throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });

  const headerBytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const detectedType = detectMediaMime(headerBytes);

  if (!detectedType || !ALLOWED_MIME.has(detectedType)) throw new Error('Invalid file');
  if (detectedType !== declaredType) throw new Error('MIME type mismatch');

  return detectedType;
}

// Validate magic bytes and enforce the size cap while the body streams through,
// so raw uploads never have to be buffered in isolate memory.
function createUploadValidationStream(declaredType) {
  let headerBytes = new Uint8Array(0);
  let totalBytes = 0;
  let headerChecked = false;

  const validateHeader = () => {
    const detectedType = detectMediaMime(headerBytes);
    if (!detectedType || !ALLOWED_MIME.has(detectedType)) throw new Error('Invalid file');
    if (detectedType !== declaredType) throw new Error('MIME type mismatch');
  };

  return new TransformStream({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_UPLOAD) {
        throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });
      }

      if (!headerChecked) {
        const need = 32 - headerBytes.length;
        if (need > 0) {
          const take = chunk.subarray(0, need);
          const merged = new Uint8Array(headerBytes.length + take.length);
          merged.set(headerBytes);
          merged.set(take, headerBytes.length);
          headerBytes = merged;
        }
        if (headerBytes.length >= 32) {
          validateHeader();
          headerChecked = true;
        }
      }

      controller.enqueue(chunk);
    },
    flush() {
      if (totalBytes === 0) throw new Error('File required');
      if (!headerChecked) validateHeader();
    }
  });
}

function mediaUrl(filename, mime) {
  const routeBase = mime.startsWith('video/') ? 'video' : 'img';
  return `/${routeBase}/${filename}`;
}

// Raw-body upload: the client sends the file bytes directly with its MIME type
// as Content-Type. The body is piped to R2 through the validation stream — the
// file never sits fully in memory, unlike multipart parsing.
async function handleRawUpload(c, declaredType, contentLength) {
  if (!c.req.raw.body) throw new Error('File required');
  // R2 streaming writes need a known length; browser XHR/fetch always sets it.
  if (contentLength == null) {
    throw Object.assign(new Error('Content-Length required'), { status: 411 });
  }

  const ext = MIME_EXT[declaredType];
  const filename = `tmp/${crypto.randomUUID()}.${ext}`;

  const fixed = new FixedLengthStream(contentLength);
  const pipePromise = c.req.raw.body
    .pipeThrough(createUploadValidationStream(declaredType))
    .pipeTo(fixed.writable);
  const putPromise = c.env.IMG_BUCKET.put(filename, fixed.readable, {
    httpMetadata: { contentType: declaredType }
  });

  // A validation failure aborts the pipe, which aborts the R2 write — R2 only
  // creates the object on successful completion. Prefer the validation error.
  const [pipeResult, putResult] = await Promise.allSettled([pipePromise, putPromise]);
  if (pipeResult.status === 'rejected') throw pipeResult.reason;
  if (putResult.status === 'rejected') throw putResult.reason;

  return c.json({ url: mediaUrl(filename, declaredType) });
}

router.post('/', authMiddleware, async (c) => {
  try {
    const contentLength = getContentLength(c);
    const requestType = normalizeMime(c.req.header('Content-Type'));
    validateUploadRequest(c, contentLength);

    if (ALLOWED_MIME.has(requestType)) {
      return await handleRawUpload(c, requestType, contentLength);
    }

    if (!requestType.includes('multipart/form-data')) {
      throw new Error('Unsupported file type');
    }

    const { value: formData, response } = await parseFormBody(c, 'Invalid upload payload');
    if (response) return response;

    const file = formData.file;
    const detectedType = await validateFileContents(file);

    const ext = MIME_EXT[detectedType];
    const filename = `tmp/${crypto.randomUUID()}.${ext}`;
    await c.env.IMG_BUCKET.put(filename, file, { httpMetadata: { contentType: detectedType } });

    const url = mediaUrl(filename, detectedType);

    if (c.req.header('HX-Request')) {
      const isVideo = detectedType.startsWith('video/');
      const htmlTag = isVideo
        ? `<video src="${url}" controls preload="metadata"></video>`
        : `<img src="${url}" loading="lazy" />`;
      return c.html(htmlTag);
    }

    return c.json({ url });

  } catch (err) {
    return jsonError(c, err.message, err.status || 400);
  }
});

export default router;
