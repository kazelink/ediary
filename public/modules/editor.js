import { Utils, State } from './dom.js';
import { API } from './api.js';
import { UI } from './ui.js';
import { swalAlert, swalUnsaved } from './swal.js';
import { Upload } from './upload.js';

const SEL = { text: '.dc-text', actions: '.item-actions', readMore: '.btn-read-more' };

function getSel() {
    return window.getSelection();
}

function anchorBlock(sel, selectors = 'p, div, h1, h2, blockquote') {
    if (!sel?.rangeCount) return null;
    const n = sel.anchorNode;
    const block = (n.nodeType === 3 ? n.parentNode : n).closest(selectors);
    if (block && block.id === 'd-text') return null;
    return block;
}

function toggleDisplay(el, condition) {
    if (el) el.style.display = condition ? '' : 'none';
}

function execCmd(cmd, val = null) {
    document.execCommand(cmd, false, val);
}

export const Editor = {
    el: {}, wrapper: null, newContainer: null,
    savedRange: null, currImg: null, activeRow: null,
    _vpHandler: null, _loadTimer: null, _scrollY: null, _mainContainer: null, _preventScroll: null,
    _savePromise: null, _sessionId: 0, _activeUploads: new Set(), _toolbarRaf: null, _imgToolbarRaf: null,
    _beforeUnloadHandler: null,

    init() {
        const ids = [
            'toolbar', 'd-text', 'd-date', 'd-save', 'save-txt', 'date-text',
            'img-input', 'vid-input', 'date-label', 'btn-img', 'btn-vid', 'btn-hr', 'btn-color',
            'color-dropdown', 'img-toolbar', 'btn-time'
        ];
        
        ids.forEach(id => {
            const element = Utils.$(id);
            if (element) {
                // to camelCase
                const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                this.el[key] = element;
            }
        });

        this.wrapper = Utils.$('editor-wrapper-dom');
        this.newContainer = Utils.$('editor-card');

        if (!this.wrapper || !this.newContainer || !this.el.dText || !this.el.toolbar || !this.el.dDate) return;

        this._bindUnsavedGuard();
        this._bindContent();
        this._bindKeyboard();
        this._bindToolbar();
        this._bindColor();
        this._bindImage();
        this._bindVideo();
        this._bindDate();
        this._bindUpload();

        if (this.el.dSave) {
            this.el.dSave.onclick = () => this.save();
        }
    },

    async save() {
        if (this._savePromise) return this._savePromise;
        this._savePromise = this._doSave();
        try {
            return await this._savePromise;
        } finally {
            this._savePromise = null;
        }
    },

    async _doSave() {
        const { dText, dSave, dDate } = this.el;
        if (!dText || !dDate) return false;
        
        if (!this.hasContent()) {
            swalAlert('Empty Content', '', 'warning');
            return false;
        }

        if (dSave) {
            dSave.classList.add('sending');
            dSave.disabled = true;
        }

        try {
            const isNewEntry = !State.editingId;
            await API.req('save', {
                id: State.editingId,
                date: dDate.value,
                content: dText.innerHTML
            }, 'POST');

            State.originalContent = dText.innerHTML;
            await this.close(true);

            if (isNewEntry) {
                const [year, mStr] = dDate.value.split('-');
                State.lastLoadedYear = null;
                window.App.route({ view: 'list', year, month: parseInt(mStr, 10), page: 1 });
            } else {
                window.App.loadView();
            }

            UI.setStatus('ok');
            setTimeout(() => UI.setStatus(''), 2000);
            return true;
        } catch (e) {
            if (e?.code !== 'UNAUTHORIZED') {
                swalAlert('Save Failed', e?.message || 'Unknown error', 'error');
            }
            return false;
        } finally {
            if (dSave) {
                dSave.classList.remove('sending');
                dSave.disabled = false;
            }
        }
    },

    _bindUnsavedGuard() {
        if (this._beforeUnloadHandler) return;
        this._beforeUnloadHandler = (e) => {
            if (this.hasContent() && this.el.dText.innerHTML !== State.originalContent && this.wrapper.style.display !== 'none') {
                e.preventDefault();
                e.returnValue = 'Unsaved changes';
                return 'Unsaved changes';
            }
            return undefined;
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
    },

    _bindContent() {
        const { dText } = this.el;
        if (!dText) return;

        dText.addEventListener('click', e => {
            if (e.target.tagName === 'IMG') {
                this.selectImg(e.target);
                e.stopPropagation();
            } else {
                this.deselectImg();
            }
        });

        this._triggerInput = () => {
            if (dText.oninput) dText.oninput();
        };

        dText.addEventListener('scroll', () => this._schedulePositionImgToolbar());
        dText.ondragover = e => e.preventDefault();

        const handleMediaFile = (e, files) => {
            const file = [...(files || [])].find(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
            if (file) {
                e.preventDefault();
                this._uploadAndInsertMedia(file, file.type.startsWith('image/') ? 'image' : 'video');
                return true;
            }
            return false;
        };

        dText.addEventListener('drop', e => handleMediaFile(e, e.dataTransfer?.files));

        dText.addEventListener('paste', e => {
            if (handleMediaFile(e, e.clipboardData?.files)) return;
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            execCmd('insertText', text);
        });

        dText.oninput = () => {
            this._scheduleSyncToolbarState();
            this.deselectImg();
        };
    },

    _bindKeyboard() {
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                if (this.wrapper && this.wrapper.style.display !== 'none') {
                    e.preventDefault();
                    if (!this._savePromise) this.save();
                }
            }
        });

        if (!this.el.dText) return;
        this.el.dText.onkeydown = e => {
            if (e.key === 'Backspace') this._handleBackspace(e);
            else if (e.key === 'Enter') this._handleEnter(e);
        };
    },

    _handleBackspace(e) {
        const sel = getSel();
        if (!sel.rangeCount || !sel.isCollapsed) return;
        const block = anchorBlock(sel);
        if (!block) return;

        const range = sel.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(block);
        preCaretRange.setEnd(range.startContainer, range.startOffset);

        if (preCaretRange.toString().length > 0) return;

        if (block.style.textAlign === 'center') {
            execCmd('justifyLeft');
            this._scheduleSyncToolbarState();
            e.preventDefault();
            return;
        }

        if (block.classList.contains('indent')) {
            block.classList.remove('indent');
            this._scheduleSyncToolbarState();
            this._triggerInput();
            e.preventDefault();
        }
    },

    _handleEnter(e) {
        const sel = getSel();
        if (!sel.rangeCount) return;

        const block = anchorBlock(sel, 'blockquote, h1, h2');
        if (block) {
            setTimeout(() => execCmd('formatBlock', 'p'), 0);
        }
        setTimeout(() => this._scheduleSyncToolbarState(), 0);
    },

    _handleToolbarAction(cmd, val) {
        switch (cmd) {
            case 'justifyCenter': {
                const parent = this.currImg?.parentElement;
                if (parent) {
                    parent.style.textAlign = parent.style.textAlign === 'center' ? 'left' : 'center';
                    this._schedulePositionImgToolbar();
                    this._triggerInput();
                    return;
                }
                const isCentered = document.queryCommandState('justifyCenter');
                execCmd(isCentered ? 'justifyLeft' : 'justifyCenter');
                break;
            }
            case 'justifyFull': {
                const isJustified = document.queryCommandState('justifyFull');
                execCmd(isJustified ? 'justifyLeft' : 'justifyFull');
                break;
            }
            case 'indentClass': {
                const sel = getSel();
                if (!sel.rangeCount) return;
                
                const { dText } = this.el;
                const anchor = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
                if (anchor === dText) execCmd('formatBlock', 'p');

                let targets = Array.from(dText.querySelectorAll('p, div, h1, h2, blockquote'))
                    .filter(b => sel.containsNode(b, true));

                if (!targets.length) {
                    const fallbackBlock = anchorBlock(sel);
                    if (!fallbackBlock) {
                        execCmd('formatBlock', 'p');
                    }
                    const finalBlock = anchorBlock(getSel(), 'p, div');
                    if (finalBlock) targets = [finalBlock];
                }

                const shouldIndent = targets.some(b => !b.classList.contains('indent'));
                targets.forEach(b => b.classList.toggle('indent', shouldIndent));
                this._triggerInput();
                break;
            }
            case 'formatBlock': {
                const current = document.queryCommandValue('formatBlock');
                const isSame = current && current.toLowerCase() === val.toLowerCase();
                execCmd('formatBlock', isSame ? 'p' : val);
                break;
            }
            default:
                execCmd(cmd, val);
        }
    },

    _bindToolbar() {
        const { toolbar, dText, btnHr, btnTime } = this.el;
        if (!toolbar || !dText) return;

        const IGNORED_BTNS = ['btn-img', 'btn-vid', 'btn-color', 'btn-hr', 'btn-time'];

        const moreWrapper = toolbar.querySelector('.tb-more-wrapper');
        const moreTrigger = toolbar.querySelector('.tb-more-trigger');
        const morePanel = toolbar.querySelector('.tb-more-panel');
        if (moreTrigger && moreWrapper && morePanel) {
            const positionPanel = () => {
                morePanel.style.left = '100%';
                morePanel.style.right = 'auto';
                requestAnimationFrame(() => {
                    const rect = morePanel.getBoundingClientRect();
                    if (rect.right > window.innerWidth - 10) {
                        morePanel.style.left = 'auto';
                        morePanel.style.right = '100%';
                    }
                });
            };
            moreWrapper.addEventListener('mouseenter', positionPanel);
            moreTrigger.onmousedown = (e) => {
                e.preventDefault();
                const isActive = moreWrapper.classList.contains('active');
                if (!isActive) positionPanel();
                moreWrapper.classList.toggle('active');
            };
            document.addEventListener('mousedown', (e) => {
                if (!moreWrapper.contains(e.target)) {
                    moreWrapper.classList.remove('active');
                }
            });
        }

        toolbar.onmousedown = e => {
            if (e.target.closest('.tb-more-trigger')) return;
            const btn = e.target.closest('.tb-btn');
            if (!btn || IGNORED_BTNS.includes(btn.id)) return;
            
            e.preventDefault();
            this.ensureFocus();
            
            this._handleToolbarAction(btn.dataset.cmd, btn.dataset.val);
            setTimeout(() => this._scheduleSyncToolbarState(), 0);
        };

        toolbar.addEventListener('click', () => setTimeout(() => this._schedulePositionImgToolbar(), 10));

        if (btnHr) {
            btnHr.onclick = () => {
                this.ensureFocus();
                execCmd('insertHTML', '<hr contenteditable="false"><p><br></p>');
            };
        }

        if (btnTime) {
            btnTime.onclick = () => {
                this.ensureFocus();
                const now = new Date();
                const hh = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                execCmd('insertHTML', `<span style="color: var(--m-blu, #6a8caf);">${hh}:${mm}</span>&nbsp;`);
                this._triggerInput();
            };
        }
    },

    _bindColor() {
        const { btnColor, colorDropdown } = this.el;
        if (!btnColor || !colorDropdown) return;

        btnColor.onmousedown = e => {
            e.preventDefault();
            e.stopPropagation();
            this.ensureFocus();
            const sel = getSel();
            this.savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            colorDropdown.classList.toggle('show');
        };

        colorDropdown.onmousedown = e => {
            e.preventDefault();
            e.stopPropagation();
            const opt = e.target.closest('.color-option');
            if (!opt) return;

            if (this.savedRange) {
                const s = getSel();
                s.removeAllRanges();
                s.addRange(this.savedRange);
            }
            execCmd('foreColor', opt.dataset.color);
            colorDropdown.classList.remove('show');
        };

        document.addEventListener('mousedown', e => {
            if (!e.target.closest('.color-picker-wrapper')) {
                colorDropdown.classList.remove('show');
            }
        });
    },

    _bindImage() {
        const { btnImg, imgInput, imgToolbar } = this.el;
        if (!btnImg || !imgInput || !imgToolbar) return;
        
        btnImg.onclick = () => imgInput.click();

        imgToolbar.addEventListener('click', e => {
            if (e.target.classList.contains('it-btn') && this.currImg) {
                e.preventDefault();
                e.stopPropagation();
                this.currImg.style.width = e.target.dataset.w + '%';
                this._schedulePositionImgToolbar();
                this._triggerInput();
            }
        });
    },

    _bindVideo() {
        const { btnVid, vidInput } = this.el;
        if (!btnVid || !vidInput) return;
        btnVid.onclick = () => vidInput.click();
    },

    _bindDate() {
        const { dateLabel, dDate, dateText } = this.el;
        if (!dateLabel || !dDate || !dateText) return;
        
        dateLabel.onclick = () => dDate.showPicker();
        
        dDate.onchange = e => {
            if (!e.target.value) e.target.value = Utils.today();
            dateText.innerText = Utils.prettyDate(e.target.value);
            this._triggerInput();
        };
    },

    _bindUpload() {
        const { imgInput, vidInput } = this.el;
        
        const attachUpload = (inputElem, type) => {
            if (!inputElem) return;
            inputElem.onchange = () => {
                const file = inputElem.files[0];
                if (file) this._uploadAndInsertMedia(file, type);
                inputElem.value = '';
            };
        };

        attachUpload(imgInput, 'image');
        attachUpload(vidInput, 'video');
    },

    selectImg(img) {
        if (this.currImg === img) return;
        this.deselectImg();
        this.currImg = img;
        img.classList.add('img-selected');
        
        if (this.el.imgToolbar) this.el.imgToolbar.classList.add('show');

        const parent = img.parentElement;
        if (parent) {
            Utils.$('btn-center')?.classList.toggle('active', parent.style.textAlign === 'center');
        }
        this._schedulePositionImgToolbar();
    },

    deselectImg() {
        if (!this.currImg) return;
        this.currImg.classList.remove('img-selected');
        this.currImg = null;
        if (this.el.imgToolbar) {
            this.el.imgToolbar.classList.remove('show');
        }
    },

    ensureFocus() {
        const { dText } = this.el;
        if (!dText) return;
        
        const sel = getSel();
        if (sel.rangeCount && dText.contains(sel.anchorNode)) {
            this._scheduleSyncToolbarState();
            return;
        }

        dText.focus();
        const r = document.createRange();
        r.selectNodeContents(dText);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        this._scheduleSyncToolbarState();
    },

    hasContent() {
        const { dText } = this.el;
        if (!dText) return false;
        return dText.innerText.trim().length > 0 || !!dText.querySelector('img') || !!dText.querySelector('video');
    },

    _positionImgToolbar() {
        if (!this.currImg || !this.wrapper || !this.el.imgToolbar) return;
        const er = this.wrapper.getBoundingClientRect();
        const ir = this.currImg.getBoundingClientRect();
        this.el.imgToolbar.style.top = `${ir.bottom - er.top - 50}px`;
        this.el.imgToolbar.style.left = `${(ir.left + ir.width / 2) - er.left}px`;
    },

    _schedulePositionImgToolbar() {
        if (this._imgToolbarRaf) return;
        this._imgToolbarRaf = requestAnimationFrame(() => {
            this._imgToolbarRaf = null;
            this._positionImgToolbar();
        });
    },

    _syncToolbarState() {
        const { toolbar } = this.el;
        if (!toolbar) return;
        
        Array.from(toolbar.children).forEach(btn => {
            const cmd = btn.dataset.cmd;
            if (cmd && !['indentClass', 'justifyCenter'].includes(cmd)) {
                try { 
                    btn.classList.toggle('active', document.queryCommandState(cmd)); 
                } catch { } // Error thrown on mobile browsers for unsupported queries
            }
        });

        const block = anchorBlock(getSel());
        let isCentered = this.currImg?.parentElement?.style.textAlign === 'center'
            || document.queryCommandState('justifyCenter');

        if (block && block.style.textAlign === 'center') isCentered = true;

        Utils.$('btn-center')?.classList.toggle('active', isCentered);
        toolbar.querySelector('[data-cmd="indentClass"]')?.classList.toggle('active', !!block?.classList.contains('indent'));
    },

    _scheduleSyncToolbarState() {
        if (this._toolbarRaf) return;
        this._toolbarRaf = requestAnimationFrame(() => {
            this._toolbarRaf = null;
            this._syncToolbarState();
        });
    },

    open(mode, data, anchorEl) {
        this._sessionId += 1;
        this._setupMobileContext();

        const { dText, dDate, dateText } = this.el;
        if (!dText || !dDate || !dateText || !this.wrapper) return;
        
        this.wrapper.style.display = 'flex';
        dText.innerHTML = data.content || '';

        if (mode === 'new') {
            this._openNew();
        } else {
            this._openExisting(data, anchorEl);
        }

        const openDate = data.date;
        dDate.value = openDate;
        dateText.innerText = Utils.prettyDate(openDate);
        State.originalContent = dText.innerHTML;

        setTimeout(() => {
            this.ensureFocus();
            if (mode === 'new') {
                execCmd('justifyLeft');
                Array.from(this.el.toolbar.querySelectorAll('.active')).forEach(b => b.classList.remove('active'));
            }
        }, 150);
    },

    _setupMobileContext() {
        if (window.innerWidth > 600) return;
        
        this.wrapper.classList.add('editor-fullscreen', 'editor-loading');
        this._scrollY = window.scrollY;
        
        this._mainContainer = document.querySelector('.d-container');
        toggleDisplay(this._mainContainer, false);
        
        this._startViewportSync();
        document.body.appendChild(this.wrapper);

        this._preventScroll = e => {
            if (!e.target.closest('.editor-box')) e.preventDefault();
        };
        document.addEventListener('touchmove', this._preventScroll, { passive: false });
    },

    _openNew() {
        const { saveTxt } = this.el;
        State.editingId = null;
        if (saveTxt) saveTxt.innerText = 'PUBLISH';
        
        this.wrapper.classList.add('editor-in-new');
        this.newContainer.style.display = 'block';

        const mainCard = this.newContainer.parentElement?.querySelector('.main-card');
        if (mainCard) mainCard.style.display = 'none';

        if (window.innerWidth > 600) {
            this.newContainer.appendChild(this.wrapper);
        }
    },

    _openExisting(data, anchorEl) {
        State.editingId = data.id;
        if (this.el.saveTxt) this.el.saveTxt.innerText = 'SAVE';
        this.activeRow = anchorEl;

        if (!this.activeRow) return;

        toggleDisplay(this.activeRow.querySelector(SEL.text), false);
        toggleDisplay(this.activeRow.querySelector(SEL.actions), false);
        toggleDisplay(this.activeRow.querySelector(SEL.readMore), false);

        if (window.innerWidth > 600) {
            this.wrapper.classList.add('editor-in-card');
            this.activeRow.appendChild(this.wrapper);
        }
    },

    async close(force) {
        this.deselectImg();
        const contentChanged = this.el.dText.innerHTML !== State.originalContent;
        const wasNewEntry = State.editingId === null;

        if (!force && this.hasContent() && contentChanged) {
            const savedOrDiscarded = await swalUnsaved(() => this.save());
            if (savedOrDiscarded === false) return false;
            if (savedOrDiscarded === true && this.el.dText.innerHTML === State.originalContent) return true;
        }

        this._cleanupContext();
        this.newContainer.appendChild(this.wrapper);

        if (wasNewEntry) {
            this._restoreNewView();
        } else if (this.activeRow) {
            this._restoreExistingView();
        }

        State.editingId = null;
        State.originalContent = '';
        return true;
    },

    _cleanupContext() {
        this.el.dText.innerHTML = '';
        this.wrapper.style.display = 'none';
        this.wrapper.classList.remove('editor-fullscreen', 'editor-loading', 'editor-in-card', 'editor-in-new');
        
        this._sessionId += 1;
        this._activeUploads.forEach(xhr => xhr.abort());
        this._activeUploads.clear();
        
        if (this._toolbarRaf) {
            cancelAnimationFrame(this._toolbarRaf);
            this._toolbarRaf = null;
        }
        if (this._imgToolbarRaf) {
            cancelAnimationFrame(this._imgToolbarRaf);
            this._imgToolbarRaf = null;
        }
        if (this._loadTimer) clearTimeout(this._loadTimer);

        if (this._mainContainer) {
            toggleDisplay(this._mainContainer, true);
            this._mainContainer = null;
        }
        if (this._scrollY != null) {
            window.scrollTo(0, this._scrollY);
            this._scrollY = null;
        }

        this._stopViewportSync();
        if (this._preventScroll) {
            document.removeEventListener('touchmove', this._preventScroll);
            this._preventScroll = null;
        }
    },

    _restoreNewView() {
        this.newContainer.style.display = 'none';
        const mainCard = this.newContainer.parentElement?.querySelector('.main-card');
        if (mainCard) mainCard.style.display = '';
    },

    _restoreExistingView() {
        const textEl = this.activeRow.querySelector(SEL.text);
        toggleDisplay(textEl, true);
        toggleDisplay(this.activeRow.querySelector(SEL.actions), true);

        const readMore = this.activeRow.querySelector(SEL.readMore);
        toggleDisplay(readMore, textEl?.classList.contains('content-folded'));

        this.activeRow = null;
    },

    _startViewportSync() {
        if (!window.visualViewport) return;
        this._vpHandler = () => {
            const vv = window.visualViewport;
            requestAnimationFrame(() => {
                this.wrapper.style.height = `${vv.height}px`;
                this.wrapper.style.top = `${vv.offsetTop}px`;
            });
            if (this.wrapper.classList.contains('editor-loading')) {
                if (this._loadTimer) clearTimeout(this._loadTimer);
                this._loadTimer = setTimeout(() => {
                    this.wrapper.classList.remove('editor-loading');
                }, 150);
            }
        };
        this._vpHandler();
        window.visualViewport.addEventListener('resize', this._vpHandler);
        window.visualViewport.addEventListener('scroll', this._vpHandler);
    },

    _stopViewportSync() {
        if (this._vpHandler && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._vpHandler);
            window.visualViewport.removeEventListener('scroll', this._vpHandler);
        }
        this._vpHandler = null;
        this.wrapper.style.height = '';
        this.wrapper.style.top = '';
    },

    _uploadAndInsertMedia(file, type) {
        const sessionId = this._sessionId;
        const xhr = Upload.file(file, this.wrapper, (url) => {
            if (sessionId !== this._sessionId || !this.wrapper || this.wrapper.style.display === 'none') return;
            if (!/^\/(img|video)\//.test(url)) return;
            
            this.ensureFocus();
            if (type === 'video') {
                execCmd('insertHTML', `<video src="${url}" controls preload="metadata"></video><p><br></p>`);
            } else {
                execCmd('insertHTML', `<img src="${url}" loading="lazy" />`);
            }
            this._triggerInput();
        }, () => {
            this._activeUploads.delete(xhr);
        });
        if (xhr) this._activeUploads.add(xhr);
    }
};
