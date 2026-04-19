import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';

const router = new Hono();

router.get('/', authMiddleware, (c) => c.json({ authenticated: true }));

export default router;
