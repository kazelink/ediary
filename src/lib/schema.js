const RETRY_DELAYS_MS = [0, 250, 750, 1500];
const REQUIRED_TABLES = ['diaries', 'diary_stats'];
const REQUIRED_TRIGGERS = ['t_insert_diary', 't_delete_diary', 't_update_diary'];

const SCHEMA_STATEMENTS = [
  `
CREATE TABLE IF NOT EXISTS diaries (
  id TEXT PRIMARY KEY,
  date TEXT,
  content TEXT
);
`.trim(),
  `
CREATE TABLE IF NOT EXISTS diary_stats (
  year TEXT,
  month TEXT,
  cnt INTEGER DEFAULT 0,
  PRIMARY KEY (year, month)
);
`.trim(),
  'CREATE INDEX IF NOT EXISTS idx_diaries_date_rowid ON diaries(date DESC);',
  'CREATE INDEX IF NOT EXISTS idx_diaries_month_expr ON diaries(substr(date, 1, 7));',
  'DROP TRIGGER IF EXISTS t_insert_diary;',
  'DROP TRIGGER IF EXISTS t_delete_diary;',
  'DROP TRIGGER IF EXISTS t_update_diary;',
  `
CREATE TRIGGER t_insert_diary AFTER INSERT ON diaries
BEGIN
  INSERT INTO diary_stats (year, month, cnt)
  VALUES (
    substr(NEW.date, 1, 4),
    substr(NEW.date, 6, 2),
    (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(NEW.date, 1, 7))
  )
  ON CONFLICT(year, month) DO UPDATE SET cnt =
    (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(NEW.date, 1, 7));
END;
`.trim(),
  `
CREATE TRIGGER t_delete_diary AFTER DELETE ON diaries
BEGIN
  UPDATE diary_stats
  SET cnt = (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(OLD.date, 1, 7))
  WHERE year = substr(OLD.date, 1, 4) AND month = substr(OLD.date, 6, 2);
  DELETE FROM diary_stats WHERE cnt <= 0;
END;
`.trim(),
  `
CREATE TRIGGER t_update_diary AFTER UPDATE ON diaries
WHEN OLD.date != NEW.date
BEGIN
  UPDATE diary_stats
  SET cnt = (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(OLD.date, 1, 7))
  WHERE year = substr(OLD.date, 1, 4) AND month = substr(OLD.date, 6, 2);

  INSERT INTO diary_stats (year, month, cnt)
  VALUES (
    substr(NEW.date, 1, 4),
    substr(NEW.date, 6, 2),
    (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(NEW.date, 1, 7))
  )
  ON CONFLICT(year, month) DO UPDATE SET cnt =
    (SELECT COUNT(*) FROM diaries WHERE substr(date, 1, 7) = substr(NEW.date, 1, 7));

  DELETE FROM diary_stats WHERE cnt <= 0;
END;
`.trim(),
];

let schemaReadyPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasRequiredObjects(db, type, names) {
  const placeholders = names.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = ? AND name IN (${placeholders})`
  ).bind(type, ...names).all();

  const found = new Set((results || []).map((row) => row.name));
  return names.every((name) => found.has(name));
}

async function hasRequiredSchema(db) {
  const [tablesReady, triggersReady] = await Promise.all([
    hasRequiredObjects(db, 'table', REQUIRED_TABLES),
    hasRequiredObjects(db, 'trigger', REQUIRED_TRIGGERS)
  ]);

  return tablesReady && triggersReady;
}

async function applySchema(db) {
  for (const [index, statement] of SCHEMA_STATEMENTS.entries()) {
    const sql = statement.trim().endsWith(';') ? statement.trim() : `${statement.trim()};`;

    try {
      await db.prepare(sql).run();
    } catch (error) {
      const preview = sql.replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(
        `Schema statement ${index + 1} failed: ${preview}${sql.length > 160 ? '...' : ''}. ${error?.message || error}`
      );
    }
  }
}

export async function ensureSchema(env) {
  if (!env?.DB) return;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    let lastError = null;

    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      try {
        if (await hasRequiredSchema(env.DB)) {
          return;
        }

        await applySchema(env.DB);

        if (await hasRequiredSchema(env.DB)) {
          return;
        }

        throw new Error('Database schema is still incomplete after initialization');
      } catch (error) {
        lastError = error;
        console.error('Schema initialization attempt failed:', error);
      }
    }

    throw lastError || new Error('Failed to initialize database schema');
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}
