import { UI } from './ui.js';

export function authHeaders() {
    const n = sessionStorage.getItem('session_nonce');
    return n ? { 'X-Session-Nonce': n } : {};
}

export const API = {
    async checkAuth() {
        const res = await fetch('/api/auth-status', { headers: authHeaders() });
        return res.ok;
    },

    async req(endpoint, data = {}, method = 'GET') {
        let url = '/api/' + endpoint;
        const headers = { ...authHeaders() };
        let body = undefined;

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(data);
        } else {
            // Non-POST requests pass data through query params.
            const params = new URLSearchParams(Object.entries(data).filter(([_, value]) => value != null));
            if (params.toString()) url += `?${params}`;
        }

        const res = await fetch(url, { method, headers, body });
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        let payload = null;

        if (contentType.includes('application/json')) {
            payload = await res.json().catch(() => null);
        } else {
            const text = await res.text().catch(() => '');
            payload = text ? { error: text } : null;
        }

        if (res.status === 401) {
            sessionStorage.removeItem('session_nonce');
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
