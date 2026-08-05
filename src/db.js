import pg from 'pg';

// DATABASE_URL doit pointer vers la même base Postgres/Supabase que ton
// serveur principal (Maître de Maison) — ou toute autre base Postgres.
// On y stocke une table séparée (wa_auth_state), sans toucher aux tables
// existantes de ton app.
if (!process.env.DATABASE_URL) {
  console.error("⚠️  DATABASE_URL n'est pas définie — la connexion WhatsApp ne pourra pas être sauvegardée.");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined,
});
