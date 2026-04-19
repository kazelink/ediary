import { Utils, State } from './dom.js';
import { API, authHeaders } from './api.js';
import { UI } from './ui.js';
import { swalConfirm, swalAlert } from './swal.js';
import { Editor } from './editor.js';
import { Auth } from './auth.js';

const MAX_RESTORE_FILE_BYTES = 100 * 1024 * 1024;
const RESTORE_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const RESTORE_REQUEST_TARGET_BYTES = 1024 * 1024;
const RESTORE_REQUEST_MAX_ENTRY_COUNT = 100;
const RESTORE_REQUEST_HARD_LIMIT_BYTES = RESTORE_REQUEST_MAX_BYTES - (64 * 1024);
const STATUS_RESET_DELAY_MS = 2000;
const textEncoder = new TextEncoder();
const REFRESH_EVENTS = ['refresh-stats', 'refresh-months', 'refresh-list'];

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// Restore flow helpers.
function getRestoreInput() {
    return Utils.$('restore-input');
}

function clearRestoreInput() {
    const input = getRestoreInput();
    if (input) input.value = '';
}

function showRestoreMessage(kind, text) {
    const box = Utils.$('restore-msg');
    if (!box) return;
    box.innerHTML = '';
    if (!text) return;

    const messageEl = document.createElement('div');
    messageEl.className = kind === 'error' ? 'auth-err' : 'auth-ok';
    messageEl.textContent = text;
    box.appendChild(messageEl);
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

function buildRestoreChunks(entries) {
    const chunks = [];
    let currentChunk = [];
    let currentBytes = 0;

    for (const entry of entries) {
        const entryBytes = textEncoder.encode(JSON.stringify(entry)).length;
        if (entryBytes > RESTORE_REQUEST_HARD_LIMIT_BYTES) {
            throw new Error('A diary entry is too large to restore safely.');
        }

        const nextBytes = currentBytes + entryBytes + (currentChunk.length ? 1 : 0);
        if (
            currentChunk.length &&
            (nextBytes > RESTORE_REQUEST_TARGET_BYTES || currentChunk.length >= RESTORE_REQUEST_MAX_ENTRY_COUNT)
        ) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentBytes = 0;
        }

        currentChunk.push(entry);
        currentBytes += entryBytes + (currentChunk.length > 1 ? 1 : 0);
    }

    if (currentChunk.length) chunks.push(currentChunk);
    return chunks;
}

// Routing and state helpers.
function dispatchBodyEvent(name, detail) {
    const event = detail ? new CustomEvent(name, { detail }) : new Event(name);
    document.body.dispatchEvent(event);
}

function syncStateFromLocation() {
    const params = new URLSearchParams(location.search);
    const monthParam = params.get('month');

    State.view = params.get('view') || 'index';
    State.year = params.get('year');
    State.month = monthParam === 'all' ? null : (monthParam ? parseInt(monthParam, 10) : undefined);
    State.page = parseInt(params.get('page') || '1', 10);
}

function applyActiveView(views, activeView) {
    if (views.index) views.index.classList.toggle('active', activeView === 'index');
    if (views.list) views.list.classList.toggle('active', activeView === 'list');
    if (views.backup) views.backup.classList.toggle('active', activeView === 'backup');
}

function resetStatusLater(statusKind) {
    setTimeout(() => {
        if (statusKind !== 'err' || !App._restoreInFlight) UI.setStatus('');
    }, STATUS_RESET_DELAY_MS);
}

const App = {
    _views: {}, _popstateHandler: null, _restoreInFlight: false,

    async init() {
        Auth.init();
        Editor.init();

        // Cache fixed DOM elements
        this._views = {
            index: Utils.$('v-index'),
            list: Utils.$('v-list'),
            backup: Utils.$('v-backup'),
            pgData: Utils.$('pg-data')
        };

        // Expose App early so login/inline handlers can call it during async init.
        window.App = this;

        // Global listener setup
        this._setupHtmxListeners();
        UI.initGlobalEvents();


        const footerYear = Utils.$('footer-year');
        if (footerYear) footerYear.textContent = String(new Date().getFullYear());

        const hasNonce = !!sessionStorage.getItem('session_nonce');
        const authed = hasNonce && await API.checkAuth().catch(() => false);
        if (authed) {
            await this.loadView();
        } else {
            sessionStorage.removeItem('session_nonce');
            UI.showAuth();
        }
        document.body.classList.add('ready');

        if (!this._popstateHandler) {
            this._popstateHandler = () => this.loadView();
            window.addEventListener('popstate', this._popstateHandler);
        }
    },

    // Public actions.

    route(nextState) {
        Object.assign(State, nextState);
        const params = new URLSearchParams();
        if (State.view !== 'index') {
            params.set('view', State.view);
            if (State.year) params.set('year', State.year);
            if (State.month === null) params.set('month', 'all');
            else if (State.month !== undefined) params.set('month', State.month);
            if (State.page > 1) params.set('page', State.page);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
        history.pushState(null, '', '?' + params.toString());
        this.loadView();
    },

    async loadView() {
        syncStateFromLocation();
        applyActiveView(this._views, State.view);

        UI.renderBreadcrumb();
        if (State.view === 'list') {
            const entryListEl = Utils.$('entry-list');
            if (entryListEl) entryListEl.innerHTML = '<div class="loading-hint">Loading...</div>';
            const paginationEl = Utils.$('pg-box');
            if (paginationEl) paginationEl.style.display = 'none';
        } else if (State.view !== 'backup') {
            State.lastLoadedYear = null;
        }

        if (State.view === 'backup') { UI.setStatus(''); return; }

        UI.setStatus('loading');
        try {
            if (State.view === 'index') {
                htmx.ajax('GET', '/api/stats', { target: '#year-grid', swap: 'innerHTML' });
            } else {
                await this._syncList();
            }
            UI.setStatus('');
        } catch {
            UI.setStatus('err');
        }
    },

    async _syncList() {
        if (State.year !== State.lastLoadedYear) {
            const monthFilterEl = Utils.$('month-filter');
            const entryListEl = Utils.$('entry-list');
            if (monthFilterEl) monthFilterEl.innerHTML = '';
            if (entryListEl) entryListEl.innerHTML = '<div class="loading-hint">Loading...</div>';
            State.lastLoadedYear = State.year;
            await this._autoSelectMonth();
            dispatchBodyEvent('refresh-months');
        } else {
            UI.updateMonthTabs(State.month);
        }
        dispatchBodyEvent('refresh-list');
    },

    async _autoSelectMonth() {
        if (State.month !== undefined) return;
        try {
            const months = await API.req('months', { year: State.year });
            if (!months?.length) return;
            State.month = months[0];
            const params = new URLSearchParams(location.search);
            params.set('month', months[0]);
            history.replaceState(null, '', '?' + params.toString());
        } catch (e) {
            console.error('Auto-select failed', e);
        }
    },

    toggleJump(show) {
        const pageTextEl = Utils.$('pg-status-txt');
        const pageInputEl = Utils.$('pg-input');
        if (show) {
            pageTextEl.style.display = 'none';
            pageInputEl.style.display = 'inline-block';
            pageInputEl.value = State.page;
            requestAnimationFrame(() => pageInputEl.focus({ preventScroll: true }));
        } else {
            pageTextEl.style.display = 'inline';
            pageInputEl.style.display = 'none';
            const nextPage = parseInt(pageInputEl.value, 10);
            if (nextPage && nextPage !== State.page && nextPage <= State.data.totalPg) {
                this.route({ page: nextPage });
            }
        }
    },

    async newEntry() { if (await Editor.close()) Editor.open('new', { date: Utils.today() }); },

    async editEntry(btn, id, date) {
        if (await Editor.close()) {
            const entryRow = btn?.closest('.d-item');
            const contentEl = entryRow?.querySelector('.dc-text');
            if (contentEl) {
                Editor.open('edit', { id, date, content: contentEl.innerHTML }, entryRow);
            }
        }
    },

    changePage(dir) {
        const next = State.page + dir;
        if (next >= 1 && next <= State.data.totalPg) this.route({ page: next });
    },

    async goBack() { if (await Editor.close()) this.route({ view: 'index', month: null, page: 1 }); },
    closeEditor: () => Editor.close(),

    pickRestoreFile() {
        const input = getRestoreInput();
        if (!input) return;
        try {
            if (typeof input.showPicker === 'function') input.showPicker();
            else input.click();
        } catch {
            input.click();
        }
    },

    async restoreBackup(file) {
        if (!file || this._restoreInFlight) return;

        this._restoreInFlight = true;
        UI.setStatus('loading');
        showRestoreMessage('info', 'Reading backup...');

        try {
            if (file.size > MAX_RESTORE_FILE_BYTES) {
                throw new Error('Backup file too large (max 100MB).');
            }

            await nextFrame();
            const rawText = await file.text();
            if (!rawText) throw new Error('No data provided.');

            showRestoreMessage('info', 'Parsing backup...');
            await nextFrame();

            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch {
                throw new Error('Invalid JSON.');
            }

            const entries = extractRestoreEntries(parsed);
            if (!entries) throw new Error('Invalid data format.');

            const chunks = buildRestoreChunks(entries);
            let count = 0;
            let skipped = 0;

            for (let i = 0; i < chunks.length; i += 1) {
                const percent = Math.round((i / Math.max(chunks.length, 1)) * 100);
                showRestoreMessage('info', `Restoring backup... ${percent}%`);
                const result = await API.req('backup/restore', {
                    entries: chunks[i],
                    totalBytes: file.size
                }, 'POST');
                count += Number(result?.count ?? 0);
                skipped += Number(result?.skipped ?? 0);
            }

            showRestoreMessage('success', `Restore Successful! Processed ${count} entries, skipped ${skipped} invalid entries.`);
            REFRESH_EVENTS.forEach((name) => dispatchBodyEvent(name));
            dispatchBodyEvent('restoreSuccess', { count, skipped });
        } catch (err) {
            const message = err?.message || 'Restore failed.';
            showRestoreMessage('error', `Restore Failed: ${message}`);
            UI.setStatus('err');
            resetStatusLater('err');
        } finally {
            clearRestoreInput();
            this._restoreInFlight = false;
        }
    },

    async downloadBackup() {
        UI.setStatus('loading');
        try {
            const from = document.getElementById('export-from')?.value || '';
            const to = document.getElementById('export-to')?.value || '';
            const params = new URLSearchParams();
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            const qs = params.toString();
            const url = '/api/backup/export' + (qs ? '?' + qs : '');
            const headers = authHeaders();
            const res = await fetch(url, Object.keys(headers).length ? { headers } : {});
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            const range = from || to ? `_${from || 'start'}_${to || 'now'}` : '';
            a.download = `diary-backup-${new Date().toISOString().slice(0, 10)}${range}.json`;
            a.click();
            URL.revokeObjectURL(blobUrl);
            UI.setStatus('');
        } catch {
            UI.setStatus('err');
        }
    },

    // Internal wiring.
    _setupHtmxListeners() {
        document.addEventListener('htmx:configRequest', (e) => {
            const sessionNonce = sessionStorage.getItem('session_nonce');
            if (sessionNonce) e.detail.headers['X-Session-Nonce'] = sessionNonce;

            const params = new URLSearchParams(location.search);
            if (params.has('year')) e.detail.parameters.year = params.get('year');
            if (params.has('month')) e.detail.parameters.month = params.get('month');
            if (params.has('page')) e.detail.parameters.page = params.get('page');
        });

        document.addEventListener('htmx:beforeRequest', (e) => {
            if (e.target.id !== 'auth-form') {
                UI.setStatus('loading');
            }
        });

        document.addEventListener('change', async (e) => {
            const input = e.target;
            if (!input || input.id !== 'restore-input') return;
            const file = input.files?.[0];
            if (!file) return;
            const ok = await swalConfirm('Restore Backup?', 'This will overwrite entries with matching IDs.');
            if (!ok) {
                input.value = '';
                return;
            }
            await this.restoreBackup(file);
        });

        document.addEventListener('htmx:afterOnLoad', () => {
            UI.setStatus('');

            // Swaps replace this element, so always re-read it from the DOM.
            const pgData = document.getElementById('pg-data');
            if (pgData) {
                this._views.pgData = pgData;
                State.data.totalPg = parseInt(pgData.dataset.total, 10) || 1;
            }
        });

        // Remove the fold UI when the rendered content is already short enough.
        document.addEventListener('htmx:afterSettle', (e) => {
            const items = (e.target || document).querySelectorAll('.content-folded');
            items.forEach(el => {
                if (el.scrollHeight <= el.clientHeight) {
                    el.classList.remove('content-folded');
                    const btn = el.nextElementSibling;
                    if (btn?.classList.contains('btn-read-more')) btn.style.display = 'none';
                }
            });
        });

        document.body.addEventListener('restoreSuccess', (e) => {
            const count = Number(e.detail?.count ?? 0);
            const skipped = Number(e.detail?.skipped ?? 0);
            UI.setStatus('ok');
            resetStatusLater('ok');
            swalAlert('Restore Complete', `Processed: ${count}\nSkipped: ${skipped}`, 'success');
        });
    }
};

// Initialize
App.init();
