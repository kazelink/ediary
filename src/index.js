import { Hono } from 'hono';
import { scheduledBackup } from './lib/scheduled.js';
import { ensureSchema } from './lib/schema.js';
import { escapeHtml, respondError } from './lib/utils.js';

import imagesRouter from './api/images.js';
import loginRouter from './api/login.js';
import authStatusRouter from './api/auth-status.js';
import statsRouter from './api/stats.js';
import monthsRouter from './api/months.js';
import listRouter from './api/list.js';
import saveRouter from './api/save.js';
import deleteRouter from './api/delete.js';
import uploadRouter from './api/upload.js';
import backupRouter from './api/backup.js';

const app = new Hono();
const DB_API_PREFIXES = [
    '/api/stats',
    '/api/months',
    '/api/list',
    '/api/save',
    '/api/delete',
    '/api/backup'
];

app.use('/api/*', async (c, next) => {
    const needsDb = DB_API_PREFIXES.some((prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`));
    if (needsDb) {
        await ensureSchema(c.env);
    }
    await next();
});

app.onError((error, c) => {
    console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, error);
    const message = escapeHtml(error?.message || 'Internal Server Error');

    if (c.req.path.startsWith('/api/')) {
        return respondError(c, message, 500);
    }

    return c.text('Internal Server Error', 500);
});

app.get('/', (c) => c.redirect('/app.html'));
app.get('/index.html', (c) => c.redirect('/app.html'));
app.get('/backup', (c) => c.redirect('/app.html?view=backup'));

app.route('/img', imagesRouter);
app.route('/video', imagesRouter);

app.route('/api/login', loginRouter);
app.route('/api/auth-status', authStatusRouter);
app.route('/api/stats', statsRouter);
app.route('/api/months', monthsRouter);
app.route('/api/list', listRouter);
app.route('/api/save', saveRouter);
app.route('/api/delete', deleteRouter);
app.route('/api/upload', uploadRouter);
app.route('/api/backup', backupRouter);

app.all('*', (c) => c.json({ error: 'Not Found' }, 404));

export default {
    fetch: app.fetch,
    async scheduled(event, env, ctx) {
        await ensureSchema(env);
        ctx.waitUntil(scheduledBackup(env));
    }
};
