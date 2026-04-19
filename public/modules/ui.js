import { Utils, State, RI_SVGS, loadScript } from './dom.js';

let _authFocusTimer = null;

const AUTH_ARROW_SVG = '<svg viewBox="0 0 24 24"><path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z"></path></svg>';

const STATUS_ICONS = {
    loading: RI_SVGS.loader,
    ok: '<i class="ri-check-line"></i>',
    err: '<i class="ri-close-line" style="color:var(--danger)"></i>'
};

// --- Private Helpers ---

function resetAuthUi() {
    const authForm = Utils.$('auth-form');
    const authBtn = authForm?.querySelector('.auth-btn');
    const authMsg = Utils.$('auth-messages');

    if (authMsg) authMsg.innerHTML = '';
    if (authBtn) {
        authBtn.innerHTML = AUTH_ARROW_SVG;
        authBtn.style.removeProperty('background');
    }
}

async function showFancybox(items, options = {}) {
    try {
        await loadScript('/assets/fancybox.umd.js');
        // explicitly checking and calling Fancybox.show
        if (typeof Fancybox !== 'undefined') {
            Fancybox.show(items, { showClass: false, Hash: false, ...options });
        }
    } catch (err) {
        console.error('Failed to load Fancybox:', err);
    }
}

function handleMediaClick(target, container) {
    if (target.tagName === 'IMG') {
        const imgs = Array.from(container.querySelectorAll('img'));
        const start = Math.max(0, imgs.indexOf(target));
        const gallery = imgs.map(img => ({ src: img.src, type: 'image' }));
        
        showFancybox(gallery, {
            startIndex: start,
            Carousel: { initialSlide: start },
            Images: { Panzoom: { maxScale: 4 } },
            Thumbs: { type: 'modern' },
            wheel: 'zoom'
        });
    } else if (target.tagName === 'VIDEO') {
        target.pause();
        showFancybox([{ src: target.src, type: 'html5video' }]);
    }
}

// --- Public UI API ---

export const UI = {
    setStatus(mode) {
        const statusEl = Utils.$('sync-stat');
        if (!statusEl) return;

        statusEl.className = `sync-stat active ${mode === 'ok' ? 'success' : ''}`.trim();
        statusEl.innerHTML = STATUS_ICONS[mode] || '';
    },

    renderBreadcrumb() {
        const titleEl = Utils.$('c-title-box');
        if (!titleEl) return;

        if (State.view === 'backup') {
            titleEl.textContent = 'BACKUP';
            return;
        }

        if (State.view === 'list' && State.year) {
            titleEl.innerHTML = '<span style="cursor:pointer" id="crumb-archive">ARCHIVE</span><span style="color:var(--txt-mut);margin:0 8px;font-weight:400">/</span><span id="crumb-year"></span>';
            Utils.$('crumb-archive').onclick = () => window.App.goBack();
            Utils.$('crumb-year').textContent = State.year;
        } else {
            titleEl.textContent = 'ARCHIVE';
        }
    },

    updateMonthTabs(activeM) {
        const monthFilterEl = Utils.$('month-filter');
        if (!monthFilterEl) return;

        const isAll = activeM === null || activeM === 'all';
        
        Array.from(monthFilterEl.children).forEach(button => {
            const isActive = isAll ? button.dataset.id === 'all' : button.dataset.id === String(activeM);
            button.className = `m-btn ${isActive ? 'active' : ''}`.trim();
        });
    },

    showAuth() {
        const overlay = Utils.$('auth-overlay');
        if (!overlay) return;

        overlay.classList.add('active');
        resetAuthUi();

        const inputEl = Utils.$('auth-input');
        if (inputEl) {
            inputEl.value = '';
            if (_authFocusTimer) clearTimeout(_authFocusTimer);
            _authFocusTimer = setTimeout(() => {
                _authFocusTimer = null;
                if (overlay.classList.contains('active')) inputEl.focus({ preventScroll: true });
            }, 300);
        }
    },

    hideAuth() {
        const overlay = Utils.$('auth-overlay');
        if (overlay) overlay.classList.remove('active');
        
        if (_authFocusTimer) {
            clearTimeout(_authFocusTimer);
            _authFocusTimer = null;
        }
    },

    initGlobalEvents() {
        document.addEventListener('click', e => {
            const dcText = e.target.closest('.dc-text');
            if (!dcText) return;

            const isMedia = e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO';
            if (isMedia) {
                e.preventDefault();
                handleMediaClick(e.target, dcText);
            }
        });
    }
};
