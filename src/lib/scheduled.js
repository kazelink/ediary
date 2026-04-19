const DAY_MS = 24 * 60 * 60 * 1000;
import { extractMediaKeys } from './utils.js';

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

// Scheduled backup handler (Cron Trigger)
export async function scheduledBackup(env) {
    if (!env.DB || !env.IMG_BUCKET) return;

    try {
        // 1) Fetch notes and all cleanup candidates concurrently.
        const [dbRes, backupObjects, tmpObjects, allMediaObjects] = await Promise.all([
            env.DB.prepare('SELECT id, date, content FROM diaries').all(),
            listAllObjects(env.IMG_BUCKET, 'backups/'),
            listAllObjects(env.IMG_BUCKET, 'tmp/'),
            listAllObjects(env.IMG_BUCKET, '') // List all for GC
        ]);

        const backupData = JSON.stringify({
            timestamp: new Date().toISOString(),
            count: dbRes.results?.length || 0,
            diaries: dbRes.results || []
        });

        // 2) Write daily backup file.
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `backups/${dateStr}.json`;
        await env.IMG_BUCKET.put(fileName, backupData, {
            httpMetadata: { contentType: 'application/json' }
        });

        // 3) Retention policy: Keep simple N recent weekly backups.
        const toDelete = selectBackupKeysToDelete(backupObjects);
        if (toDelete.length > 0) {
            console.log(`Backup retention: deleting ${toDelete.length} old backups.`);
            await Promise.allSettled(toDelete.map((key) => env.IMG_BUCKET.delete(key)));
        }

        // 4) Delete abandoned tmp uploads older than retention window.
        const cutoff = Date.now() - DAY_MS;
        const staleTmp = tmpObjects.filter((obj) => {
            const ts = uploadedAtMs(obj);
            return ts > 0 && ts < cutoff;
        });
        if (staleTmp.length > 0) {
            await Promise.allSettled(staleTmp.map((obj) => env.IMG_BUCKET.delete(obj.key)));
        }

        // 5) Global Media Garbage Collection
        // Compare all real media files in R2 against all media referenced in the database.
        const allActiveKeys = new Set();
        if (dbRes.results) {
            for (const row of dbRes.results) {
                const keys = extractMediaKeys(row.content);
                keys.forEach(k => allActiveKeys.add(k));
            }
        }

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
