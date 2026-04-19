import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { jsonError } from '../lib/http.js';
import { V } from '../lib/validate.js';
import { fmtDate, escapeHtml } from '../lib/utils.js';

const router = new Hono();

function renderEntry(entry) {
  const formattedDate = fmtDate(entry.date);
  const safeId = escapeHtml(entry.id);
  const safeDate = escapeHtml(entry.date);
  
  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const content = rawContent.replace(/<img (?![^>]*\bloading=["']?lazy)/gi, '<img loading="lazy" ');
  
  return `
    <div class="d-item">
      <div class="d-item-header">
        <div class="d-date-box">
          <span class="dd-day">${formattedDate.d}</span>
          <div class="dd-info">
            <span class="dd-month">${formattedDate.m}</span>
            <span class="dd-year">${formattedDate.y}</span>
          </div>
        </div>
        <div class="item-actions">
          <span class="btn-icon-s edit" onclick="App.editEntry(this, '${safeId}', '${safeDate}')"><i class="ri-edit-line"></i></span>
          <span class="btn-del" hx-delete="/api/delete?id=${safeId}" hx-confirm="Delete?" hx-target="closest .d-item" hx-swap="outerHTML"><i class="ri-delete-bin-line"></i></span>
        </div>
      </div>
      <div class="dc-text content-folded" id="dc-${safeId}">${content}</div>
      <div class="btn-read-more" id="btn-${safeId}">
        <span class="btn-read-more-inner" onclick="document.getElementById('dc-${safeId}').classList.remove('content-folded');document.getElementById('btn-${safeId}').style.display='none'">
          <i class="ri-arrow-down-double-line"></i> READ MORE
        </span>
      </div>
    </div>`;
}

function renderPagination(currPg, totalPg) {
  const pgStyle = totalPg > 1 ? 'flex' : 'none';
  return `
    <div id="pg-box" class="pg-box" style="display:${pgStyle}" hx-swap-oob="true">
      <span class="pg-btn" onclick="App.changePage(-1)"><i class="ri-arrow-left-s-line"></i></span>
      <div class="pg-status">
        <span id="pg-status-txt" onclick="App.toggleJump(true)">${currPg}</span>
        <input type="number" id="pg-input" class="pg-inp" style="display:none"
          value="${currPg}"
          onblur="App.toggleJump(false)"
          onkeydown="if(event.key==='Enter')this.blur()">
        <span>/ <span id="pg-total">${totalPg}</span></span>
      </div>
      <span class="pg-btn" onclick="App.changePage(1)"><i class="ri-arrow-right-s-line"></i></span>
      <div id="pg-data" data-total="${totalPg}" style="display:none"></div>
    </div>
  `;
}

function buildQuery(year, month) {
  const conditions = [];
  const params = [];
  
  if (!year) return { conditions, params, invalidFilter: false, yInt: 0, mInt: 0 };
  
  const yInt = V.safeInt(year, 0, 1970, 9999);
  const mInt = (month && month !== 'null' && month !== 'all') ? V.safeInt(month, 0, 1, 12) : 0;
  
  if (!yInt || (month && month !== 'null' && month !== 'all' && !mInt)) {
    return { conditions: ['1=0'], params: [], invalidFilter: true, yInt, mInt };
  }

  if (mInt > 0) {
    const mStr = String(mInt).padStart(2, '0');
    const nextM = mInt === 12 ? `${yInt + 1}-01-01` : `${yInt}-${String(mInt + 1).padStart(2, '0')}-01`;
    conditions.push('date >= ? AND date < ?');
    params.push(`${yInt}-${mStr}-01`, nextM);
  } else {
    conditions.push('date >= ? AND date < ?');
    params.push(`${yInt}-01-01`, `${yInt + 1}-01-01`);
  }

  return { conditions, params, invalidFilter: false, yInt, mInt };
}

function getTotalCountQuery(env, yInt, mInt, invalidFilter) {
  if (invalidFilter) return env.DB.prepare('SELECT 0 AS total');
  if (yInt && mInt > 0) {
    return env.DB.prepare('SELECT COALESCE(cnt, 0) AS total FROM diary_stats WHERE year = ? AND month = ?')
      .bind(String(yInt), String(mInt).padStart(2, '0'));
  }
  if (yInt) {
    return env.DB.prepare('SELECT COALESCE(SUM(cnt), 0) AS total FROM diary_stats WHERE year = ?')
      .bind(String(yInt));
  }
  return env.DB.prepare('SELECT COALESCE(SUM(cnt), 0) AS total FROM diary_stats');
}

router.get('/', authMiddleware, async (c) => {
  const { page = '1', size = '10', year, month, id } = c.req.query();

  if (id) {
    if (!V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);
    const entry = await c.env.DB.prepare('SELECT * FROM diaries WHERE id = ?').bind(id).first();
    return c.json(entry || {});
  }

  const limit = V.safeInt(size, 10, 1, 50);
  const safePage = V.safeInt(page, 1, 1, 9999);
  const offset = (safePage - 1) * limit;

  const { conditions, params, invalidFilter, yInt, mInt } = buildQuery(year, month);
  const whereClause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  
  const listStmt = c.env.DB.prepare(
    `SELECT * FROM diaries${whereClause} ORDER BY date DESC, rowid DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset);

  const totalStmt = getTotalCountQuery(c.env, yInt, mInt, invalidFilter);
  const [lRes, tRes] = await c.env.DB.batch([listStmt, totalStmt]);

  const list = lRes.results ?? [];
  const total = tRes.results?.[0]?.total ?? 0;

  if (c.req.header('HX-Request')) {
    let html = list.length
      ? list.map(renderEntry).join('')
      : '<div class="loading-hint">No entries found.</div>';

    const totalPg = Math.ceil(total / limit);
    html += renderPagination(safePage, totalPg);

    return c.html(html);
  }

  return c.json({ list, total });
});

export default router;
