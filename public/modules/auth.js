import { Utils, RI_SVGS } from './dom.js';
import { UI } from './ui.js';

export const Auth = {
    init() {
        const authForm = Utils.$('auth-form');
        if (!authForm) return;

        const authBtn = authForm.querySelector('.auth-btn');
        const authInp = Utils.$('auth-input');
        const authMsg = Utils.$('auth-messages');
        let origBtnHtml = '';

        // Clear error when user starts typing
        if (authInp) {
            authInp.addEventListener('input', () => {
                if (authMsg) authMsg.innerHTML = '';
            });
        }

        authForm.addEventListener('htmx:beforeRequest', () => {
            if (authBtn) {
                origBtnHtml = authBtn.innerHTML;
                authBtn.innerHTML = RI_SVGS.loader;
            }
            if (authMsg) authMsg.innerHTML = '';
        });

        // Allow HTMX to swap error responses into #auth-messages.
        // beforeSwap fires on the swap target, which is #auth-messages (a sibling of #auth-form).
        if (authMsg) {
            authMsg.addEventListener('htmx:beforeSwap', (e) => {
                if (e.detail.xhr.status >= 400) {
                    e.detail.shouldSwap = true;
                    e.detail.isError = false;
                }
            });
        }

        authForm.addEventListener('htmx:afterRequest', (e) => {
            if (e.detail.failed || e.detail.xhr.status >= 400) {
                if (authBtn && origBtnHtml) authBtn.innerHTML = origBtnHtml;
                if (authInp) {
                    authInp.value = '';
                    requestAnimationFrame(() => authInp.focus({ preventScroll: true }));
                }
                // Fallback: if HTMX swap didn't happen, manually set from response
                if (authMsg && !authMsg.innerHTML.trim()) {
                    authMsg.innerHTML = e.detail.xhr.responseText || '<div class="auth-err">ERROR</div>';
                }
            }
        });

        // Handle login success via HX-Trigger from backend
        document.body.addEventListener('loginSuccess', async (e) => {
            const nonce = e.detail?.nonce;
            if (nonce) sessionStorage.setItem('session_nonce', nonce);
            if (authBtn) {
                authBtn.innerHTML = '<i class="ri-check-line" style="font-size:24px"></i>';
                authBtn.style.background = 'var(--success)';
            }
            if (authMsg) authMsg.innerHTML = '';
            UI.hideAuth();

            // If editor is hidden, reload view. If open, user creates/edits entry, so don't reload.
            const wrapper = document.getElementById('editor-wrapper-dom');
            if (wrapper && wrapper.style.display === 'none') {
                if (window.App) await window.App.loadView();
            }
        });
    }
};
