import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';

const router = new Hono();

function renderYearCard(yearSummary) {
  return `<div class="y-card" onclick="App.route({view:'list',year:${yearSummary.year},month:undefined})">
    <div class="y-num">${yearSummary.year}</div>
    <div class="y-count">${yearSummary.count} ${yearSummary.count == 1 ? 'Entry' : 'Entries'}</div>
  </div>`;
}

router.get('/', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT year, SUM(cnt) as count FROM diary_stats GROUP BY year ORDER BY year DESC').all();

  if (c.req.header('HX-Request')) {
    const html = (results ?? []).map(renderYearCard).join('');
    return c.html(html);
  }

  return c.json(results ?? []);
});

export default router;
