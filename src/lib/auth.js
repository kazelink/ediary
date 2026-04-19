import { verifyToken } from './jwt.js';
import { respondError } from './utils.js';

const COOKIE_RE = /(?:^|;\s*)diary_auth=([^;]*)/;

// Full auth requires both the JWT cookie and the session nonce header.
export async function authMiddleware(c, next) {
    const secret = c.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    const token = parseCookie(c.req.header('Cookie'));
    const nonce = c.req.header('X-Session-Nonce');
    if (!token || !nonce) {
        return respondError(c, 'Unauthorized', 401);
    }

    const payload = await verifyToken(token, secret);
    if (!payload || payload.nonce !== nonce) {
        return respondError(c, 'Unauthorized', 401);
    }

    await next();
}

// Cookie-only auth is used for browser-native media requests that cannot attach custom headers.
export async function cookieOnlyAuth(c, next) {
    const secret = c.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    const token = parseCookie(c.req.header('Cookie'));
    if (!token || !(await verifyToken(token, secret))) {
        return respondError(c, 'Unauthorized', 401);
    }

    await next();
}

function parseCookie(cookieStr) {
    if (!cookieStr) return null;
    const match = cookieStr.match(COOKIE_RE);
    return match ? match[1] : null;
}
