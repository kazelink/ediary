import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError, getContentLength, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { V } from '../lib/validate.js';
import { escapeHtml } from '../lib/utils.js';
import { UPSERT_DIARY_SQL } from '../lib/sql.js';

const router = new Hono();
const MAX_RESTORE_FILE = 100 * 1024 * 1024;
const MAX_RESTORE_REQUEST = 4 * 1024 * 1024;
const RESTORE_CHUNK_SIZE = 100;
const SANITIZE_BATCH_SIZE = 10;

async function restoreInChunks(db, entries) {
  if (!entries.length) return;
  const stmt = db.prepare(UPSERT_DIARY_SQL);
  for (let i = 0; i < entries.length; i += RESTORE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + RESTORE_CHUNK_SIZE);
    await db.batch(chunk.map(e => stmt.bind(e.id, e.date, e.content)));
  }
}

function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.diaries)) return payload.diaries;
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.list)) return payload.list;
  }
  return null;
}

async function sanitizeRestoreEntries(entries) {
  let skipped = 0;
  const validEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    if (!V.isUUID(entry.id) || !V.isDateStr(entry.date) || typeof entry.content !== 'string') {
      skipped += 1;
      continue;
    }
    validEntries.push({
      id: String(entry.id),
      date: entry.date,
      content: entry.content
    });
  }

  for (let i = 0; i < validEntries.length; i += SANITIZE_BATCH_SIZE) {
    const batch = validEntries.slice(i, i + SANITIZE_BATCH_SIZE);
    const sanitized = await Promise.all(batch.map(entry => sanitizeContent(entry.content)));
    batch.forEach((entry, index) => {
      entry.content = sanitized[index];
    });
  }

  return { skipped, validEntries };
}

router.get('/export', authMiddleware, async (c) => {
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const conditions = [];
    const params = [];
    if (from) {
      if (!V.isDateStr(from)) return jsonError(c, 'Invalid from date', 400);
      conditions.push('date >= ?');
      params.push(from);
    }
    if (to) {
      if (!V.isDateStr(to)) return jsonError(c, 'Invalid to date', 400);
      conditions.push('date <= ?');
      params.push(to);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await c.env.DB.prepare(`SELECT * FROM diaries${where} ORDER BY date DESC`).bind(...params).all();
    const data = JSON.stringify(results || []);
    const filename = `diary-backup-${new Date().toISOString().split('T')[0]}.json`;
    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });
  } catch (e) {
    return jsonError(c, `Export Failed: ${escapeHtml(e.message)}`, 500);
  }
});

router.post('/restore', authMiddleware, async (c) => {
  const contentLength = getContentLength(c);
  if (contentLength != null && contentLength > MAX_RESTORE_REQUEST) {
    return jsonError(c, 'Restore payload too large. Please retry from the app.', 413);
  }

  try {
    const { value: parsed, response } = await parseJsonBody(c, 'Invalid JSON');
    if (response) return response;

    const totalBytes = Number(parsed?.totalBytes);
    if (Number.isFinite(totalBytes) && totalBytes > MAX_RESTORE_FILE) {
      return jsonError(c, 'Backup file too large (max 100MB)', 413);
    }

    const entries = extractRestoreEntries(parsed);
    if (!entries) {
      return jsonError(c, 'Invalid data format', 400);
    }

    const { skipped, validEntries } = await sanitizeRestoreEntries(entries);
    const count = validEntries.length;

    await restoreInChunks(c.env.DB, validEntries);
    return c.json({ success: true, count, skipped });
  } catch (e) {
    return jsonError(c, e?.message || 'Unknown error', 500);
  }
});

export default router;
