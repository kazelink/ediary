export const UPSERT_DIARY_SQL = `
  INSERT INTO diaries (id, date, content)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    date = excluded.date,
    content = excluded.content
`;
