import { startSession } from './sessionManager.js';
import { listStoredUserIds } from './dbAuthState.js';
import { pool } from './db.js';

/**
 * Au démarrage du service, chaque userId ayant des identifiants enregistrés
 * en base est reconnecté automatiquement — Baileys réutilise les identifiants
 * sauvegardés, pas besoin de re-scanner sauf déconnexion explicite (logout).
 */
export async function startAllSessions() {
  const userIds = await listStoredUserIds(pool);

  for (const userId of userIds) {
    console.log(`Reconnexion session WhatsApp pour l'utilisateur ${userId}...`);
    await startSession(userId, {
      onStatus: (uid, status) => console.log(`[${uid}] statut: ${status}`),
    });
  }
}
