const DAY_MS = 24 * 60 * 60 * 1000;
const DIARY_PAGE_SIZE = 200;
// Keep each D1 batch comfortably sized: one page of rows can expand into many
// media statements, so flush in bounded slices.
const MEDIA_BATCH_STATEMENTS = 150;
import { diaryMediaStatements } from './utils.js';

function uploadedAtMs(obj) {
    const ts = obj?.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj?.uploaded || ''));
    return Number.isFinite(ts) ? ts : 0;
}

async function listAllObjects(bucket, prefix) {
    const objects = [];
    let cursor = undefined;
    while (true) {
        const listed = await bucket.list({ prefix, cursor });
        if (Array.isArray(listed?.objects) && listed.objects.length > 0) {
            objects.push(...listed.objects);
        }
        if (!listed?.truncated || !listed?.cursor) break;
        cursor = listed.cursor;
    }
    return objects;
}

function parseBackupDateMsFromKey(key) {
    const m = String(key || '').match(/^backups\/(\d{4})-(\d{2})-(\d{2})\.json$/);
    if (!m) return 0;
    const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isFinite(ts) ? ts : 0;
}

const MAX_BACKUPS_TO_KEEP = 5;

// Keep only the most recent N backups
function selectBackupKeysToDelete(objects) {
    if (!Array.isArray(objects) || objects.length <= MAX_BACKUPS_TO_KEEP) return [];

    const backups = objects
        .map(obj => ({
            key: String(obj?.key || ''),
            ts: parseBackupDateMsFromKey(obj?.key)
        }))
        .filter(b => b.ts > 0)
        .sort((a, b) => b.ts - a.ts); // Descending (newest first)

    // Return everything after the first MAX_BACKUPS_TO_KEEP
    return backups.slice(MAX_BACKUPS_TO_KEEP).map(b => b.key);
}

// Iterate all diary rows in bounded pages (keyset pagination on rowid) so a
// large database never has to fit into isolate memory all at once.
async function* iterateDiaries(db, columns) {
    let lastRowId = 0;
    while (true) {
        const { results } = await db.prepare(
            `SELECT rowid, ${columns} FROM diaries WHERE rowid > ? ORDER BY rowid LIMIT ?`
        ).bind(lastRowId, DIARY_PAGE_SIZE).all();

        const rows = results || [];
        if (!rows.length) return;
        lastRowId = rows[rows.length - 1].rowid;

        yield rows;
        if (rows.length < DIARY_PAGE_SIZE) return;
    }
}

// Scheduled backup handler (Cron Trigger)
export async function scheduledBackup(env) {
    if (!env.DB || !env.IMG_BUCKET) return;

    try {
        // 1) Stream diary rows in pages: build the backup JSON incrementally
        //    while syncing the diary_media index from the same read.
        const jsonPieces = [];
        let count = 0;

        for await (const rows of iterateDiaries(env.DB, 'id, date, content')) {
            let mediaStatements = [];
            const flushMedia = async () => {
                if (!mediaStatements.length) return;
                await env.DB.batch(mediaStatements);
                mediaStatements = [];
            };
            for (const row of rows) {
                jsonPieces.push(`${count ? ',' : ''}${JSON.stringify({ id: row.id, date: row.date, content: row.content })}`);
                count += 1;
                mediaStatements.push(...diaryMediaStatements(env.DB, row.id, row.content));
                if (mediaStatements.length >= MEDIA_BATCH_STATEMENTS) await flushMedia();
            }
            await flushMedia();
        }

        // Drop index rows for diaries that no longer exist (set-based, one query).
        await env.DB.prepare(
            'DELETE FROM diary_media WHERE diary_id NOT IN (SELECT id FROM diaries)'
        ).run();

        const backupData = `{"timestamp":${JSON.stringify(new Date().toISOString())},"count":${count},"diaries":[${jsonPieces.join('')}]}`;
        jsonPieces.length = 0;

        // 2) Write daily backup file.
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `backups/${dateStr}.json`;
        await env.IMG_BUCKET.put(fileName, backupData, {
            httpMetadata: { contentType: 'application/json' }
        });

        // 3) Retention policy: Keep simple N recent weekly backups.
        const backupObjects = await listAllObjects(env.IMG_BUCKET, 'backups/');
        const toDelete = selectBackupKeysToDelete(backupObjects);
        if (toDelete.length > 0) {
            console.log(`Backup retention: deleting ${toDelete.length} old backups.`);
            await Promise.allSettled(toDelete.map((key) => env.IMG_BUCKET.delete(key)));
        }

        // 4) Delete abandoned tmp uploads older than retention window.
        const tmpObjects = await listAllObjects(env.IMG_BUCKET, 'tmp/');
        const cutoff = Date.now() - DAY_MS;
        const staleTmp = tmpObjects.filter((obj) => {
            const ts = uploadedAtMs(obj);
            return ts > 0 && ts < cutoff;
        });
        if (staleTmp.length > 0) {
            await Promise.allSettled(staleTmp.map((obj) => env.IMG_BUCKET.delete(obj.key)));
        }

        // 5) Global media garbage collection driven by the freshly synced
        //    diary_media index — no second full-content read required.
        const { results: usedRows } = await env.DB.prepare('SELECT DISTINCT media_key FROM diary_media').all();
        const allActiveKeys = new Set((usedRows || []).map(r => r.media_key));

        const allMediaObjects = await listAllObjects(env.IMG_BUCKET, '');
        const toGc = allMediaObjects
            .map(obj => obj.key)
            .filter(key => {
                if (key.startsWith('backups/') || key.startsWith('tmp/')) return false; // Handled separately
                return !allActiveKeys.has(key);
            });

        if (toGc.length > 0) {
            console.log(`Media GC: deleting ${toGc.length} orphaned media files.`);
            await Promise.allSettled(toGc.map(key => env.IMG_BUCKET.delete(key)));
        }
    } catch (e) {
        console.error('Scheduled backup failed:', e);
    }
}
