import fs from 'fs';
import path from 'path';
import { startSession } from './sessionManager.js';

const AUTH_DIR = path.resolve('./sessions');

/**
 * Au démarrage du worker/serveur, chaque dossier dans ./sessions correspond
 * à un utilisateur déjà lié (QR scanné précédemment). On relance sa session
 * automatiquement — Baileys réutilise les identifiants sauvegardés, pas besoin
 * de re-scanner sauf déconnexion explicite (logout) côté téléphone.
 */
export async function startAllSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;

  // Le volume monté par Railway (ext4) crée automatiquement un dossier
  // "lost+found" à sa racine — jamais un vrai userId, à ignorer.
  const userIds = fs.readdirSync(AUTH_DIR).filter((f) =>
    f !== 'lost+found' &&
    !f.startsWith('.') &&
    fs.statSync(path.join(AUTH_DIR, f)).isDirectory()
  );

  for (const userId of userIds) {
    console.log(`Reconnexion session WhatsApp pour l'utilisateur ${userId}...`);
    await startSession(userId, {
      onStatus: (uid, status) => console.log(`[${uid}] statut: ${status}`),
    });
  }
}
