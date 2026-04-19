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

function validateUploadRequest(c, contentLength, requestType) {
  if (!c.env.IMG_BUCKET) throw new Error('Storage not configured');
  if (contentLength != null && contentLength > MAX_UPLOAD) {
    throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });
  }
  if (!requestType.includes('multipart/form-data')) {
    throw new Error('multipart/form-data required');
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

router.post('/', authMiddleware, async (c) => {
  try {
    const contentLength = getContentLength(c);
    const requestType = (c.req.header('Content-Type') || '').toLowerCase();
    validateUploadRequest(c, contentLength, requestType);

    const { value: formData, response } = await parseFormBody(c, 'Invalid upload payload');
    if (response) return response;

    const file = formData.file;
    const detectedType = await validateFileContents(file);

    const ext = MIME_EXT[detectedType];
    const filename = `tmp/${crypto.randomUUID()}.${ext}`;
    await c.env.IMG_BUCKET.put(filename, file, { httpMetadata: { contentType: detectedType } });

    const routeBase = detectedType.startsWith('video/') ? 'video' : 'img';
    const mediaUrl = `/${routeBase}/${filename}`;

    if (c.req.header('HX-Request')) {
      const isVideo = detectedType.startsWith('video/');
      const htmlTag = isVideo 
        ? `<video src="${mediaUrl}" controls preload="metadata"></video>`
        : `<img src="${mediaUrl}" loading="lazy" />`;
      return c.html(htmlTag);
    }
    
    return c.json({ url: mediaUrl });

  } catch (err) {
    return jsonError(c, err.message, err.status || 400);
  }
});

export default router;
