// Escape HTML special characters to prevent XSS in template interpolation
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#x60;' };
const ESC_RE = /[&<>"'`]/g;
export const escapeHtml = (str) => str == null ? '' : String(str).replace(ESC_RE, c => ESC_MAP[c] || c);

// Unified HTMX-aware error response
export function respondError(c, msg, status) {
    if (c.req.header('HX-Request')) return c.html(`<div class="auth-err">${msg}</div>`, status);
    return c.json({ error: msg }, status);
}

export const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Format date string "YYYY-MM-DD" into { d, m, y } with month abbreviation
export const fmtDate = (s) => {
    if (!s) return { d: '', m: '', y: '' };
    const [y, m, d] = s.split('-');
    return { d, m: MONTHS_ABBR[+m - 1] || '', y };
};

// Extract local media keys from <img src="/img/..."> and <video src="/video/..."> tags.
const MEDIA_TAG_RE = /<(?:img|video)\b[^>]*>/gi;
const LOCAL_MEDIA_SRC_RE = /\bsrc\s*=\s*(["']?)\/(?:img|video)\/([^"'\s>]+)\1/i;
const PROTECTED_PREFIXES = ['backups/'];
const isProtectedKey = (key) => PROTECTED_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));

export const extractMediaKeys = (html) => {
    const text = String(html || '');
    const keys = new Set();
    for (const tag of text.matchAll(MEDIA_TAG_RE)) {
        const match = tag[0].match(LOCAL_MEDIA_SRC_RE);
        if (match && match[2]) {
            const key = match[2].split(/[?#]/)[0];
            if (key) keys.add(key);
        }
    }
    return [...keys];
};

// The diary_media index is consulted by media-cleanup decisions, so it must be
// updated in the same batch (transaction) as the content it mirrors.
export function diaryMediaStatements(db, id, content) {
    return [
        db.prepare('DELETE FROM diary_media WHERE diary_id = ?').bind(id),
        ...extractMediaKeys(content).map((key) =>
            db.prepare('INSERT OR IGNORE INTO diary_media (diary_id, media_key) VALUES (?, ?)').bind(id, key)
        )
    ];
}

// Use the diary_media table for fast media key lookup: a key referenced by any
// remaining entry must not be deleted, even if one referencing entry goes away.
async function filterUnusedMediaKeys(db, keys) {
    if (!db || !Array.isArray(keys) || keys.length === 0) return keys;

    const placeholders = keys.map(() => '?').join(', ');
    const usedResult = await db.prepare(`
        SELECT DISTINCT media_key
        FROM diary_media
        WHERE media_key IN (${placeholders})
    `).bind(...keys).all();

    const usedKeys = new Set((usedResult?.results || []).map(r => r.media_key));
    return keys.filter(key => !usedKeys.has(key));
}

export async function cleanupMediaKeys(bucket, keys, db = null) {
    if (!bucket || !Array.isArray(keys) || keys.length === 0) return;

    try {
        const deleteCandidates = [...new Set(
            keys
                .map((key) => String(key || '').trim())
                .filter((key) => key && !isProtectedKey(key))
        )];
        if (!deleteCandidates.length) return;

        const toDelete = await filterUnusedMediaKeys(db, deleteCandidates);
        if (toDelete.length) {
            await Promise.allSettled(toDelete.map((key) => bucket.delete(key)));
        }
    } catch (e) { console.error('Media cleanup failed:', e); }
}

// Delete orphaned media from bucket. If newHtml is omitted, deletes all media in oldHtml.
export async function cleanupImages(bucket, oldHtml, newHtml, db = null) {
    if (!bucket || !oldHtml) return;
    try {
        const oldKeys = extractMediaKeys(oldHtml).filter((k) => !isProtectedKey(k));
        if (!oldKeys.length) return;

        const keep = new Set(newHtml ? extractMediaKeys(newHtml) : []);
        const deleteCandidates = oldKeys.filter(k => !keep.has(k));
        await cleanupMediaKeys(bucket, deleteCandidates, db);
    } catch (e) { console.error('Media cleanup failed:', e); }
}
