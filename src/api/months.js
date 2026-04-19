import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { MONTHS_ABBR } from '../lib/utils.js';

const router = new Hono();

function renderMonthButton(monthVal, activeMInt) {
  if (monthVal === 'all') {
    return `<span class="m-btn ${activeMInt === null ? 'active' : ''}" data-id="all" onclick="App.route({month:null,page:1})">ALL</span>`;
  }
  const monthNumber = +monthVal;
  return `<span class="m-btn ${activeMInt === monthNumber ? 'active' : ''}" data-id="${monthNumber}" onclick="App.route({month:${monthNumber},page:1})">${MONTHS_ABBR[monthNumber - 1]}</span>`;
}

router.get('/', authMiddleware, async (c) => {
  const year = c.req.query('year');
  let list = [];

  if (year) {
    const { results } = await c.env.DB.prepare('SELECT month FROM diary_stats WHERE year = ? ORDER BY month DESC').bind(year).all();
    list = (results || []).map(r => r.month);
  }

  if (c.req.header('HX-Request')) {
    const activeM = c.req.query('month');
    const mInt = activeM === 'all' ? null : (activeM ? parseInt(activeM, 10) : undefined);

    let html = list.map((monthValue) => renderMonthButton(monthValue, mInt)).join('');
    html += renderMonthButton('all', mInt);

    return c.html(html);
  }

  return c.json(list);
});

export default router;
