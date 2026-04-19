const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const RI_SVGS = {
    loader: '<svg class="ri-icon spin" viewBox="0 0 24 24"><path d="M18.364 5.636L16.95 7.05A7 7 0 1 0 19 12h2a9 9 0 1 1-2.636-6.364z"></path></svg>'
};

export const State = {
    view: 'index', year: null, month: null, page: 1,
    lastLoadedYear: null,
    editingId: null, originalContent: '',
    data: { totalPg: 1 }
};

// Lazy-load a script by URL. Returns a cached promise; auto-retries on failure.
const _scriptCache = new Map();
export function loadScript(src, timeout = 8000) {
    if (_scriptCache.has(src)) return _scriptCache.get(src);
    const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        const timer = setTimeout(() => {
            cleanup();
            _scriptCache.delete(src);
            reject(new Error(`Script load timeout: ${src}`));
        }, timeout);
        const cleanup = () => { s.onload = s.onerror = null; clearTimeout(timer); };
        s.onload = () => { cleanup(); resolve(); };
        s.onerror = () => {
            cleanup();
            _scriptCache.delete(src);
            reject(new Error(`Script load failed: ${src}`));
        };
        document.head.appendChild(s);
    });
    _scriptCache.set(src, p);
    return p;
}

export const Utils = {
    $: id => document.getElementById(id),
    fmtDate: s => {
        if (!s) return { d: '', m: '', y: '' };
        const [y, m, d] = s.split('-');
        return { d, m: MONTHS[+m - 1] || '', y };
    },
    prettyDate: s => {
        if (!s) return '';
        const d = Utils.fmtDate(s);
        return `${d.m} ${d.d}, ${d.y}`;
    },
    today: () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
};
