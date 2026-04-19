import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError } from '../lib/http.js';
import { cleanupImages } from '../lib/utils.js';
import { V } from '../lib/validate.js';

const router = new Hono();

router.delete('/', authMiddleware, async (c) => {
  const id = c.req.query('id');
  if (!id || !V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);

  const entry = await c.env.DB.prepare('SELECT content FROM diaries WHERE id = ?').bind(id).first();
  if (!entry) return jsonError(c, 'Not found', 404);

  await c.env.DB.prepare('DELETE FROM diaries WHERE id = ?').bind(id).run();
  // Only cleanup images after successful DB delete to prevent data inconsistency
  c.executionCtx.waitUntil(cleanupImages(c.env.IMG_BUCKET, entry.content));

  c.header('HX-Trigger', 'refresh-list, refresh-months, refresh-stats');
  return c.body(null, 200);
});

export default router;
