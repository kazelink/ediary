import { UI } from './ui.js';

// sessionStorage can throw (private mode, storage disabled); fall back to
// in-memory copies so auth still works for the life of the page.
let memNonce = null;
let memToken = null;

export const Nonce = {
    get() {
        try { return sessionStorage.getItem('session_nonce') || memNonce; }
        catch { return memNonce; }
    },
    set(val) {
        memNonce = val;
        try { sessionStorage.setItem('session_nonce', val); } catch { }
    },
    clear() {
        memNonce = null;
        try { sessionStorage.removeItem('session_nonce'); } catch { }
    }
};

export const Token = {
    get() {
        try { return sessionStorage.getItem('session_token') || memToken; }
        catch { return memToken; }
    },
    set(val) {
        memToken = val;
        try { sessionStorage.setItem('session_token', val); } catch { }
    },
    clear() {
        memToken = null;
        try { sessionStorage.removeItem('session_token'); } catch { }
    }
};

export function authHeaders(extra = {}) {
    const headers = { ...extra };
    const nonce = Nonce.get();
    if (nonce) headers['X-Session-Nonce'] = nonce;
    const token = Token.get();
    if (token) headers['X-Auth-Token'] = token;
    return headers;
}

export function clearSession() {
    Nonce.clear();
    Token.clear();
}

// Abort stalled requests so a dead connection surfaces as an error instead of
// an endless spinner. 60s accommodates slow links; uploads/downloads (which can
// legitimately run longer) use their own XHR/fetch paths without this signal.
const REQUEST_TIMEOUT_MS = 60000;

function requestSignal() {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;
}

async function fetchWithTimeout(url, options) {
    try {
        return await fetch(url, { ...options, signal: requestSignal() });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            const err = new Error('Request timed out. Check your connection.');
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    }
}

export const API = {
    async req(endpoint, data = {}, method = 'GET') {
        let url = '/api/' + endpoint;
        const headers = authHeaders();
        let body = undefined;

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(data);
        } else {
            // Non-POST requests pass data through query params.
            const params = new URLSearchParams(Object.entries(data).filter(([_, value]) => value != null));
            if (params.toString()) url += `?${params}`;
        }

        const res = await fetchWithTimeout(url, { method, headers, body, credentials: 'include', cache: 'no-store' });
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        let payload = null;

        if (contentType.includes('application/json')) {
            payload = await res.json().catch(() => null);
        } else {
            const text = await res.text().catch(() => '');
            payload = text ? { error: text } : null;
        }

        if (res.status === 401) {
            clearSession();
            UI.showAuth();
            const err = new Error(payload?.error || 'Unauthorized');
            err.code = 'UNAUTHORIZED';
            err.status = 401;
            throw err;
        }

        if (!res.ok) {
            const err = new Error(payload?.error || `API Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        return payload ?? {};
    }
};
