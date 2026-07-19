import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError, getContentLength, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { createStreamingBackupParser } from '../lib/stream-parser.js';
import { V } from '../lib/validate.js';
import { diaryMediaStatements, escapeHtml } from '../lib/utils.js';
import { UPSERT_DIARY_SQL } from '../lib/sql.js';

const router = new Hono();
const MAX_RESTORE_FILE = 100 * 1024 * 1024;
const MAX_RESTORE_REQUEST = 4 * 1024 * 1024;
// Each restored entry contributes an upsert plus its diary_media statements,
// so keep the per-batch statement count comfortably inside D1 batch limits.
const RESTORE_CHUNK_SIZE = 50;
const SANITIZE_BATCH_SIZE = 10;
const EXPORT_PAGE_SIZE = 200;
const STREAM_RESTORE_HEADER = 'x-backup-upload';
const STREAM_RESTORE_MODE = 'file';

function normalizeRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!V.isUUID(entry.id) || !V.isDateStr(entry.date) || typeof entry.content !== 'string') return null;
  return { id: String(entry.id), date: entry.date, content: entry.content };
}

async function sanitizeEntriesInPlace(entries) {
  for (let i = 0; i < entries.length; i += SANITIZE_BATCH_SIZE) {
    const batch = entries.slice(i, i + SANITIZE_BATCH_SIZE);
    const sanitized = await Promise.all(batch.map((entry) => sanitizeContent(entry.content)));
    batch.forEach((entry, index) => { entry.content = sanitized[index]; });
  }
}

async function restoreEntryBatch(db, entries) {
  if (!entries.length) return;
  await sanitizeEntriesInPlace(entries);

  const upsert = db.prepare(UPSERT_DIARY_SQL);
  for (let i = 0; i < entries.length; i += RESTORE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + RESTORE_CHUNK_SIZE);
    await db.batch(chunk.flatMap((e) => [
      upsert.bind(e.id, e.date, e.content),
      ...diaryMediaStatements(db, e.id, e.content)
    ]));
  }
}

function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['diaries', 'entries', 'list']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return null;
}

function getDeclaredBackupSize(c, fallback) {
  const headerBytes = Number(c.req.header('X-Backup-Size'));
  return Number.isFinite(headerBytes) && headerBytes > 0 ? headerBytes : fallback;
}

function restoreErrorResponse(c, error) {
  const message = error?.message || 'Restore failed';
  const status = error?.status || (message.includes('too large') ? 413 : /^Invalid|^No data/i.test(message) ? 400 : 500);
  return jsonError(c, message, status);
}

// Stream the uploaded backup file: parse incrementally, sanitize and upsert in
// bounded batches. Neither the raw JSON nor the full entry list is ever held
// in memory at once.
async function restoreBackupStream(db, webBody, declaredBytes) {
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESTORE_FILE) {
    throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
  }
  if (!webBody) throw Object.assign(new Error('No data provided.'), { status: 400 });

  let count = 0;
  let skipped = 0;
  let receivedBytes = 0;
  let entryBatch = [];

  const flushEntries = async () => {
    if (!entryBatch.length) return;
    const batch = entryBatch;
    entryBatch = [];
    await restoreEntryBatch(db, batch);
  };

  const parser = createStreamingBackupParser({
    onEntry: async (rawEntry) => {
      const normalized = normalizeRestoreEntry(rawEntry);
      if (!normalized) { skipped += 1; return; }

      count += 1;
      entryBatch.push(normalized);
      if (entryBatch.length >= RESTORE_CHUNK_SIZE) await flushEntries();
    }
  });

  const decoder = new TextDecoder();
  const reader = webBody.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESTORE_FILE) {
        throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
      }
      await parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  await parser.push(decoder.decode());
  await parser.finish();
  await flushEntries();

  return { success: true, count, skipped };
}

function buildExportScope(from, to) {
  const conditions = [];
  const params = [];
  if (from) {
    conditions.push('date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('date <= ?');
    params.push(to);
  }
  return {
    where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

router.get('/export', authMiddleware, async (c) => {
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from && !V.isDateStr(from)) return jsonError(c, 'Invalid from date', 400);
    if (to && !V.isDateStr(to)) return jsonError(c, 'Invalid to date', 400);

    const { where, params } = buildExportScope(from, to);
    const db = c.env.DB;
    const total = Number(
      (await db.prepare(`SELECT COUNT(*) AS total FROM diaries${where}`).bind(...params).first())?.total ?? 0
    );

    // Stream the export page by page: the response starts immediately and the
    // Worker never materializes the whole backup JSON in memory.
    const encoder = new TextEncoder();
    let offset = 0;
    let emitted = 0;
    let openedEnvelope = false;

    const stream = new ReadableStream({
      async pull(controller) {
        if (!openedEnvelope) {
          openedEnvelope = true;
          controller.enqueue(encoder.encode(
            `{"exportedAt":${JSON.stringify(new Date().toISOString())},"count":${total},"diaries":[`
          ));
          return;
        }

        const { results } = await db.prepare(
          `SELECT id, date, content FROM diaries${where} ORDER BY date DESC, rowid DESC LIMIT ? OFFSET ?`
        ).bind(...params, EXPORT_PAGE_SIZE, offset).all();

        const rows = results || [];
        offset += rows.length;

        if (rows.length) {
          const piece = rows
            .map((row) => `${emitted++ ? ',' : ''}${JSON.stringify({ id: row.id, date: row.date, content: row.content })}`)
            .join('');
          controller.enqueue(encoder.encode(piece));
        }

        if (rows.length < EXPORT_PAGE_SIZE) {
          controller.enqueue(encoder.encode(']}'));
          controller.close();
        }
      }
    });

    const range = from || to ? `_${from || 'start'}_${to || 'now'}` : '';
    const filename = `diary-backup-${new Date().toISOString().split('T')[0]}${range}.json`;
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      }
    });
  } catch (e) {
    return jsonError(c, `Export Failed: ${escapeHtml(e.message)}`, 500);
  }
});

router.post('/restore', authMiddleware, async (c) => {
  // Preferred path: the client streams the raw backup file in one request.
  if (String(c.req.header(STREAM_RESTORE_HEADER) || '').toLowerCase() === STREAM_RESTORE_MODE) {
    try {
      const declaredBytes = getDeclaredBackupSize(c, getContentLength(c));
      const result = await restoreBackupStream(c.env.DB, c.req.raw.body, declaredBytes);
      return c.json(result);
    } catch (error) {
      return restoreErrorResponse(c, error);
    }
  }

  // Legacy path: client-side chunked JSON payloads.
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

    const validEntries = entries.map(normalizeRestoreEntry).filter(Boolean);
    const skipped = entries.length - validEntries.length;
    const count = validEntries.length;

    await restoreEntryBatch(c.env.DB, validEntries);
    return c.json({ success: true, count, skipped });
  } catch (error) {
    return restoreErrorResponse(c, error);
  }
});

export default router;
