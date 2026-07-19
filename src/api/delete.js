import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError } from '../lib/http.js';
import { cleanupMediaKeys, extractMediaKeys } from '../lib/utils.js';
import { V } from '../lib/validate.js';

const router = new Hono();

router.delete('/', authMiddleware, async (c) => {
  const id = c.req.query('id');
  if (!id || !V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);

  const entry = await c.env.DB.prepare('SELECT content FROM diaries WHERE id = ?').bind(id).first();
  if (!entry) return jsonError(c, 'Not found', 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM diaries WHERE id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM diary_media WHERE diary_id = ?').bind(id)
  ]);
  // Only cleanup images after successful DB delete to prevent data inconsistency.
  // The diary_media index protects media still referenced by other entries.
  c.executionCtx.waitUntil(cleanupMediaKeys(c.env.IMG_BUCKET, extractMediaKeys(entry.content), c.env.DB));

  c.header('HX-Trigger', 'refresh-list, refresh-months, refresh-stats');
  return c.body(null, 200);
});

export default router;
