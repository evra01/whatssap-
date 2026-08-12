import { startSession } from './sessionManager.js';
import { listStoredUserIds } from './dbAuthState.js';
import { pool } from './db.js';
import { processQueue } from './queue.js';

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
      onStatus: (uid, status) => {
        console.log(`[${uid}] statut: ${status}`);
        // Dès qu'une session redevient connectée (démarrage, ou reconnexion
        // après coupure), on relance tout de suite le traitement de la file
        // plutôt que d'attendre le rappel périodique de 30s (voir queue.js)
        // — utile notamment après un redémarrage du service qui retrouve des
        // messages laissés en attente en base.
        if (status === 'connected') {
          processQueue().catch((e) => console.error('Erreur processQueue:', e.message));
        }
      },
    });
  }
}
