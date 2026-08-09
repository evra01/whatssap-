import { pool } from './db.js';

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_daily_counter (
      day DATE PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  tableReady = true;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Date du tout premier message envoyé (persistée). Sert à calculer une
 * montée en charge progressive : un compte WhatsApp neuf qui se met à
 * envoyer beaucoup de messages dès le premier jour est un signal d'alerte
 * classique pour les systèmes anti-spam de WhatsApp.
 */
async function getFirstSendDate() {
  await ensureTable();
  const res = await pool.query("SELECT value FROM wa_meta WHERE key = 'first_send_date'");
  if (res.rows.length > 0) return res.rows[0].value;
  const today = todayISO();
  await pool.query(
    `INSERT INTO wa_meta (key, value) VALUES ('first_send_date', $1) ON CONFLICT (key) DO NOTHING`,
    [today]
  );
  return today;
}

/**
 * Calcule le plafond du jour selon l'ancienneté du compte :
 *  - Semaine 1  : 15 messages/jour max
 *  - Semaines 2-3 : 30 messages/jour max
 *  - Ensuite : le plafond configuré (WHATSAPP_DAILY_CAP, 40 par défaut)
 * Un numéro WhatsApp Business déjà "chaud" peut ignorer cette prudence en
 * augmentant directement WHATSAPP_DAILY_CAP, mais la montée en charge
 * progressive reste la meilleure protection pour un compte neuf.
 */
/**
 * Plafond réglé manuellement depuis l'admin (prioritaire sur le calcul
 * automatique de montée en charge). null = pas de réglage manuel, on utilise
 * la montée en charge progressive normale.
 */
export async function getDailyCapOverride() {
  await ensureTable();
  const res = await pool.query("SELECT value FROM wa_meta WHERE key = 'daily_cap_override'");
  if (res.rows.length === 0 || res.rows[0].value === "") return null;
  const n = parseInt(res.rows[0].value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setDailyCapOverride(value) {
  await ensureTable();
  if (value === null || value === undefined) {
    await pool.query("DELETE FROM wa_meta WHERE key = 'daily_cap_override'");
    return;
  }
  await pool.query(
    `INSERT INTO wa_meta (key, value) VALUES ('daily_cap_override', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(value)]
  );
}

export async function getEffectiveDailyCap() {
  const override = await getDailyCapOverride();
  if (override !== null) return override;
  const configuredCap = parseInt(process.env.WHATSAPP_DAILY_CAP || '40', 10);
  const firstSend = await getFirstSendDate();
  const daysActive = Math.floor((Date.now() - new Date(firstSend).getTime()) / 86400000);
  if (daysActive < 7) return Math.min(15, configuredCap);
  if (daysActive < 21) return Math.min(30, configuredCap);
  return configuredCap;
}

/** Nombre de messages déjà envoyés aujourd'hui. */
export async function getTodayCount() {
  await ensureTable();
  const res = await pool.query('SELECT count FROM wa_daily_counter WHERE day = $1', [todayISO()]);
  return res.rows.length > 0 ? res.rows[0].count : 0;
}

/** Incrémente le compteur du jour (appelé après un envoi réussi). */
export async function incrementTodayCount() {
  await ensureTable();
  await pool.query(
    `INSERT INTO wa_daily_counter (day, count) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET count = wa_daily_counter.count + 1`,
    [todayISO()]
  );
}

/** true si on peut encore envoyer un message aujourd'hui. */
export async function canSendToday() {
  const [cap, count] = await Promise.all([getEffectiveDailyCap(), getTodayCount()]);
  return count < cap;
}
