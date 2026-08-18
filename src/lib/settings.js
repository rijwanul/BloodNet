// Site settings are stored as rows in D1 `settings` (key/value).
// getSettings() loads them all into a plain object; callers should fetch
// once per request and pass the object around rather than re-querying.

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const row of results) out[row.key] = row.value;
  return out;
}

export async function setSetting(db, key, value) {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value))
    .run();
}

export async function setSettings(db, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v))
  );
  if (stmts.length) await db.batch(stmts);
}

export function settingBool(settings, key, fallback = false) {
  if (!(key in settings)) return fallback;
  return settings[key] === "1" || settings[key] === "true";
}

export function settingInt(settings, key, fallback = 0) {
  const v = parseInt(settings[key], 10);
  return Number.isFinite(v) ? v : fallback;
}
