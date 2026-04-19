const POLICY = {
  ALLOWED_TAGS: new Set([
    'p', 'div', 'h1', 'h2', 'blockquote', 'hr', 'br',
    'span', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre',
    'ul', 'ol', 'li', 'a', 'img', 'video'
  ]),
  
  STRIP_WITH_CONTENT: new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
    'template', 'noscript', 'form', 'base', 'link', 'meta'
  ]),

  BLOCK_ALIGN_TAGS: new Set(['p', 'div', 'h1', 'h2', 'blockquote']),
  INDENT_TAGS: new Set(['p', 'div', 'h1', 'h2', 'blockquote']),
  ALIGN_VALUES: new Set(['left', 'center', 'right', 'justify']),
  
  SAFE_COLOR_RE: /^(#[0-9a-f]{3,8}|rgb(a)?\(\s*[\d.\s,%]+\)|hsl(a)?\(\s*[\d.\s,%]+\)|[a-z]{1,20}|var\(\s*--[a-z0-9_-]+\s*(,\s*(#[0-9a-f]{3,8}|rgb(a)?\(\s*[\d.\s,%]+\)|hsl(a)?\(\s*[\d.\s,%]+\)))?\s*\))$/i,
  SAFE_DATA_IMAGE_RE: /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i,

  isAttrAllowed(tag, attr) {
    if (attr === 'class') return this.INDENT_TAGS.has(tag);
    if (attr === 'style') return tag === 'span' || tag === 'img' || this.BLOCK_ALIGN_TAGS.has(tag);
    if (tag === 'img') return ['src', 'loading', 'alt', 'title'].includes(attr);
    if (tag === 'video') return ['src', 'controls', 'preload', 'loading'].includes(attr);
    if (tag === 'a') return ['href', 'target', 'rel', 'title'].includes(attr);
    return false;
  },

  sanitizeClass(tag, value) {
    if (!this.INDENT_TAGS.has(tag) || typeof value !== 'string') return '';
    return value.split(/\s+/).filter(Boolean).includes('indent') ? 'indent' : '';
  },

  sanitizeStyle(tag, value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    if (/url\s*\(|expression\s*\(/i.test(value)) return '';
    
    const safeRules = [];
    for (const rawRule of value.split(';')) {
      const idx = rawRule.indexOf(':');
      if (idx === -1) continue;
      
      const prop = rawRule.slice(0, idx).trim().toLowerCase();
      const rawVal = rawRule.slice(idx + 1).trim();
      if (!prop || !rawVal) continue;

      if (prop === 'text-align' && this.BLOCK_ALIGN_TAGS.has(tag)) {
        if (this.ALIGN_VALUES.has(rawVal.toLowerCase())) safeRules.push(`text-align:${rawVal.toLowerCase()}`);
      } else if (prop === 'color' && tag === 'span') {
        if (this.SAFE_COLOR_RE.test(rawVal)) safeRules.push(`color:${rawVal}`);
      } else if (prop === 'width' && tag === 'img') {
        const compact = rawVal.replace(/\s+/g, '');
        const m = compact.match(/^(\d{1,3})%$/);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 100) safeRules.push(`width:${Number(m[1])}%`);
      }
    }
    return safeRules.join(';');
  },

  isSafeHref(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const compact = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
    
    if (compact.startsWith('javascript:') || compact.startsWith('vbscript:') || compact.startsWith('data:text/html')) {
      return false;
    }
    return /^https?:\/\//.test(compact) || 
           compact.startsWith('/') || 
           compact.startsWith('mailto:') || 
           compact.startsWith('tel:');
  },

  isSafeMediaSrc(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    
    const compact = trimmed.replace(/\s+/g, '');
    const lower = compact.toLowerCase();

    if (lower.startsWith('/img/backups/') || lower.startsWith('/video/backups/')) return false;
    if (lower.startsWith('/img/') || lower.startsWith('/video/')) return true;
    if (lower.startsWith('https://') || lower.startsWith('http://')) return true;
    return this.SAFE_DATA_IMAGE_RE.test(compact);
  },

  sanitizeRel(relValue) {
    const tokens = new Set(String(relValue || '').toLowerCase().split(/\s+/).filter(Boolean));
    tokens.add('noopener').add('noreferrer');
    return [...tokens].join(' ');
  }
};

class SanitizeHandler {
  element(el) {
    const tag = el.tagName.toLowerCase();
    
    // 1. Tag filtering
    if (!POLICY.ALLOWED_TAGS.has(tag)) {
      if (POLICY.STRIP_WITH_CONTENT.has(tag)) el.remove();
      else if (typeof el.removeAndKeepContent === 'function') el.removeAndKeepContent();
      else el.remove();
      return;
    }

    // 2. Attribute processing
    const attrs = Array.from(el.attributes).map(a => [a.name.toLowerCase(), a.value]);
    
    for (const [name, value] of attrs) {
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'xlink:href'].includes(name)) {
        el.removeAttribute(name);
        continue;
      }

      if (!POLICY.isAttrAllowed(tag, name)) {
        el.removeAttribute(name);
        continue;
      }

      this._processSpecificAttributes(el, tag, name, value);
    }

    // 3. Post-processing tags
    this._postProcessTags(el, tag);
  }

  _processSpecificAttributes(el, tag, name, value) {
    if (name === 'class') {
      const cls = POLICY.sanitizeClass(tag, value);
      if (cls) el.setAttribute('class', cls);
      else el.removeAttribute('class');
    } else if (name === 'style') {
      const style = POLICY.sanitizeStyle(tag, value);
      if (style) el.setAttribute('style', style);
      else el.removeAttribute('style');
    } else if ((tag === 'img' || tag === 'video') && name === 'src' && !POLICY.isSafeMediaSrc(value)) {
      el.remove();
    } else if (tag === 'a' && name === 'href' && !POLICY.isSafeHref(value)) {
      el.removeAttribute('href');
    } else if (tag === 'a' && name === 'target') {
      if (String(value).toLowerCase() !== '_blank') el.removeAttribute('target');
      else el.setAttribute('target', '_blank');
    }
  }

  _postProcessTags(el, tag) {
    if (tag === 'img' && el.hasAttribute('src')) {
      const loading = String(el.getAttribute('loading') || '').toLowerCase();
      if (!['lazy', 'eager', 'auto'].includes(loading)) el.setAttribute('loading', 'lazy');
    } else if (tag === 'video' && el.hasAttribute('src')) {
      el.setAttribute('controls', '');
      el.setAttribute('preload', 'none');
    } else if (tag === 'a') {
      if (!el.hasAttribute('href')) {
        el.removeAttribute('target');
        el.removeAttribute('rel');
      } else if (String(el.getAttribute('target') || '').toLowerCase() === '_blank') {
        el.setAttribute('rel', POLICY.sanitizeRel(el.getAttribute('rel')));
      } else {
        el.removeAttribute('rel');
      }
    }
  }
}

async function sanitizeHtmlRewriter(html) {
  const response = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return new HTMLRewriter().on('*', new SanitizeHandler()).transform(response).text();
}

function sanitizeRegexFallback(html) {
  let s = html;
  const badTags = '(script|iframe|object|embed|form|base|link|meta|style|svg|math|noscript|template)';
  s = s.replace(new RegExp(`<\\s*${badTags}\\b[^>]*>[\\s\\S]*?<\\s*\/\\s*\\1\\s*>`, 'gim'), '');
  s = s.replace(new RegExp(`<\\s*${badTags}\\b[^>]*>`, 'gim'), '');
  s = s.replace(new RegExp(`<\\s*\/\\s*${badTags}\\s*>`, 'gim'), '');
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi, '');
  s = s.replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
  s = s.replace(/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
  s = s.replace(/data\s*:\s*text\/html/gi, '');
  
  s = s.replace(/<(img|video)\s+([^>]*?)src=["']?([^"'\s>]+)["']?([^>]*?)>/gi, (match, tag, _pre, src) => {
    if (!POLICY.isSafeMediaSrc(src)) return '';
    return tag.toLowerCase() === 'video' ? `<video src="${src}" controls preload="none">` : match;
  });
  
  return s.replace(/\s+(srcdoc|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

export async function sanitizeContent(html) {
  if (typeof html !== 'string') return '';
  if (typeof HTMLRewriter === 'function') {
    try {
      return await sanitizeHtmlRewriter(html);
    } catch (e) {
      console.error('HTMLRewriter failed, using fallback:', e);
    }
  }
  return sanitizeRegexFallback(html);
}
