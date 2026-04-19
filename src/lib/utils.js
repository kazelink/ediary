// Escape HTML special characters to prevent XSS in template interpolation
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#x60;' };
const ESC_RE = /[&<>"'`]/g;
export const escapeHtml = (str) => str == null ? '' : String(str).replace(ESC_RE, c => ESC_MAP[c]);

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

// Delete orphaned media from bucket. If newHtml is omitted, deletes all media in oldHtml.
export async function cleanupImages(bucket, oldHtml, newHtml) {
    if (!bucket || !oldHtml) return;
    try {
        const oldKeys = extractMediaKeys(oldHtml).filter((k) => !isProtectedKey(k));
        if (!oldKeys.length) return;
        
        const keep = new Set(newHtml ? extractMediaKeys(newHtml) : []);
        const toDelete = oldKeys.filter(k => !keep.has(k));
        
        if (toDelete.length) {
            await Promise.allSettled(toDelete.map(k => bucket.delete(k)));
        }
    } catch (e) { console.error('Media cleanup failed:', e); }
}
