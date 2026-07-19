import { Hono } from 'hono';
import { cookieOnlyAuth } from '../lib/auth.js';
import { textError } from '../lib/http.js';

const SAFE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

function isSafeMediaKey(key) {
  return key
    && !key.includes('..')
    && !key.includes('\\')
    && !key.includes('\0')
    && !key.startsWith('/')
    // Prevent direct access to internal backup objects.
    && !key.startsWith('backups/');
}

export function createImagesRouter(routeBase) {
  const router = new Hono();

  router.get('/:key{.*}', cookieOnlyAuth, async (c) => {
    if (!c.env.IMG_BUCKET) return textError(c, 'Storage Not Configured', 500);

    const key = c.req.param('key');
    if (!isSafeMediaKey(key)) return textError(c, 'Bad Request', 400);

    const obj = await c.env.IMG_BUCKET.get(key);
    if (!obj) return textError(c, 'Not Found', 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    const cType = String(headers.get('Content-Type') || '').toLowerCase();
    if (!SAFE_MEDIA_TYPES.has(cType)) {
      return textError(c, 'Not Found', 404);
    }

    // Enforce the expected route for each media type.
    if (routeBase === 'img' && !cType.startsWith('image/')) return textError(c, 'Not Found', 404);
    if (routeBase === 'video' && !cType.startsWith('video/')) return textError(c, 'Not Found', 404);

    // Media keys are unique per upload and content never changes under a key,
    // so the browser can cache aggressively instead of refetching every view.
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    headers.set('Vary', 'Cookie');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(obj.body, { headers });
  });

  return router;
}
