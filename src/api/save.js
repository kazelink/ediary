import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { cleanupImages, diaryMediaStatements } from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { UPSERT_DIARY_SQL } from '../lib/sql.js';

const router = new Hono();

const MAX_SAVE_CONTENT_LENGTH = 500_000;
const TMP_MEDIA_REGEX = /\/(img|video)\/tmp\/([a-zA-Z0-9.\-_]+)/g;
const MAX_PROMOTE_CONCURRENCY = 4;

async function runWithConcurrency(items, maxConcurrent, worker) {
  const workerCount = Math.max(1, Math.min(maxConcurrent, items.length));
  let idx = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (idx < items.length) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function promoteTempMedia(bucket, content) {
  const tmpMatches = [...content.matchAll(TMP_MEDIA_REGEX)];
  const tmpKeys = [...new Set(tmpMatches.map(m => m[2]))];
  
  if (tmpKeys.length === 0) {
    return { content, promotedKeys: [] };
  }

  if (!bucket) throw new Error('Storage not configured');

  const promoted = new Set();
  const promotedKeys = [];

  await runWithConcurrency(tmpKeys, MAX_PROMOTE_CONCURRENCY, async (key) => {
    const tmpKey = `tmp/${key}`;
    const obj = await bucket.get(tmpKey);
    if (!obj) return;
    await bucket.put(key, obj.body, { httpMetadata: obj.httpMetadata });
    promoted.add(key);
    promotedKeys.push(tmpKey);
  });

  const missing = tmpKeys.filter(key => !promoted.has(key));
  if (missing.length > 0) {
    throw new Error('Some temporary images are missing. Please re-upload and try again.');
  }

  const updatedContent = content.replace(TMP_MEDIA_REGEX, (full, route, key) => 
    promoted.has(key) ? `/${route}/${key}` : full
  );

  return { content: updatedContent, promotedKeys };
}

function parseAndValidateRequest(body) {
  const { id: clientId, date, content } = body;

  if (clientId && !V.isUUID(clientId)) throw new Error('Invalid client ID format');
  if (!V.isDateStr(date)) throw new Error('Invalid date format');
  if (!V.isNonEmpty(content)) throw new Error('Content required');
  if (content.length > MAX_SAVE_CONTENT_LENGTH) {
    const err = new Error('Content too large');
    err.status = 413;
    throw err;
  }

  return { id: clientId || crypto.randomUUID(), date, rawContent: content };
}

router.post('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  try {
    const { id, date, rawContent } = parseAndValidateRequest(body);
    
    let sanitizedContent = await sanitizeContent(rawContent);
    const previousEntry = body.id 
      ? await c.env.DB.prepare('SELECT content FROM diaries WHERE id = ?').bind(id).first() 
      : null;
    const previousContent = typeof previousEntry?.content === 'string' ? previousEntry.content : '';

    let promotedKeys = [];
    try {
      const promotionResult = await promoteTempMedia(c.env.IMG_BUCKET, sanitizedContent);
      sanitizedContent = promotionResult.content;
      promotedKeys = promotionResult.promotedKeys;
    } catch (e) {
      return jsonError(c, e.message, e.message.includes('missing') ? 409 : 500);
    }

    await c.env.DB.batch([
      c.env.DB.prepare(UPSERT_DIARY_SQL).bind(id, date, sanitizedContent),
      ...diaryMediaStatements(c.env.DB, id, sanitizedContent)
    ]);

    if (promotedKeys.length > 0) {
      const uniqueTmpKeys = [...new Set(promotedKeys)];
      c.executionCtx.waitUntil((async () => {
        await Promise.allSettled(uniqueTmpKeys.map(key => c.env.IMG_BUCKET.delete(key)));
      })());
    }

    if (previousContent) {
      c.executionCtx.waitUntil(
        cleanupImages(c.env.IMG_BUCKET, previousContent, sanitizedContent, c.env.DB).catch(e => {
          console.error('Image cleanup failed after save:', e);
        })
      );
    }

    return c.json({ success: true, id });

  } catch (e) {
    return jsonError(c, e.message, e.status || 400);
  }
});

export default router;
