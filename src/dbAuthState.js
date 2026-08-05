import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

let tableReady = false;

async function ensureTable(pool) {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_auth_state (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, key)
    )
  `);
  tableReady = true;
}

/**
 * Remplace useMultiFileAuthState de Baileys par un stockage en base Postgres.
 * Évite d'avoir besoin d'un disque persistant (payant sur Render) : les
 * identifiants de connexion WhatsApp survivent aux redéploiements/redémarrages
 * du service tant que la base de données existe.
 */
export async function useDBAuthState(pool, userId) {
  await ensureTable(pool);

  async function readData(key) {
    const res = await pool.query(
      'SELECT value FROM wa_auth_state WHERE user_id=$1 AND key=$2',
      [userId, key]
    );
    if (res.rows.length === 0) return null;
    // Les clés de session contiennent des Buffer — BufferJSON les
    // sérialise/désérialise correctement (comme le fait Baileys en interne).
    return JSON.parse(JSON.stringify(res.rows[0].value), BufferJSON.reviver);
  }

  async function writeData(key, value) {
    const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO wa_auth_state (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, key, json]
    );
  }

  async function removeData(key) {
    await pool.query('DELETE FROM wa_auth_state WHERE user_id=$1 AND key=$2', [userId, key]);
  }

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(`${type}-${id}`);
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

/** Liste les userId ayant déjà une session enregistrée en base. */
export async function listStoredUserIds(pool) {
  await ensureTable(pool);
  const res = await pool.query(
    `SELECT DISTINCT user_id FROM wa_auth_state WHERE key = 'creds'`
  );
  return res.rows.map((r) => r.user_id);
}
