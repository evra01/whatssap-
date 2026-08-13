import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { useDBAuthState, clearAuthState } from './dbAuthState.js';
import { pool } from './db.js';

// Une session = un compte WhatsApp connecté = un utilisateur de ta plateforme.
// On garde toutes les sessions actives en mémoire, indexées par userId.
const sessions = new Map();

// Contrairement à `sessions` (qui contient un socket dès qu'il est CRÉÉ, même
// avant que la connexion WebSocket soit réellement établie), cette Map ne
// reflète que l'état réel de connexion ("open" / "close") — c'est elle qu'il
// faut utiliser pour savoir si on peut envoyer un message maintenant.
// Sans ça, pendant une reconnexion (Baileys se déconnecte et se reconnecte
// régulièrement, c'est normal), l'ancien socket fermé restait dans `sessions`
// jusqu'à ce que le nouveau le remplace : isConnected() répondait "true" à
// tort, un message pouvait être envoyé sur ce socket mort, et
// sock.sendMessage() pouvait résoudre "avec succès" côté code (le message
// mis en buffer local) sans jamais atteindre réellement le serveur WhatsApp.
const connectionOpen = new Map();

// Horodatage du dernier passage à "open" par utilisateur. Sert à isStable()
// ci-dessous : juste après une (re)connexion — surtout après un conflit
// connectionReplaced — le socket répond "ouvert" avant d'être réellement
// prêt à envoyer de façon fiable. Envoyer dans cette fenêtre produit soit un
// rejet explicite de WhatsApp, soit un message qui part dans le vide sans
// aucun accusé de réception (les deux symptômes observés en prod).
const connectedSince = new Map();

// Délai de sécurité avant d'autoriser un envoi après une (re)connexion.
const STABILITY_DELAY_MS = 8000;

/** true seulement si la connexion est ouverte ET stable depuis au moins
 * STABILITY_DELAY_MS — à utiliser avant tout envoi, en plus de isConnected(). */
export function isStable(userId) {
  const since = connectedSince.get(userId);
  return isConnected(userId) && since != null && (Date.now() - since) >= STABILITY_DELAY_MS;
}

// Sérialise les appels startSession() par utilisateur, et garantit qu'on
// ferme proprement toute session déjà active avant d'en ouvrir une nouvelle.
// Cause classique des erreurs "Bad MAC" chez Baileys : deux sockets actifs
// en parallèle sur les mêmes identifiants (ex. /connect/:userId appelé une
// deuxième fois manuellement alors que startAllSessions() avait déjà
// reconnecté ce compte au démarrage du service) corrompent l'état de
// chiffrement Signal (le "ratchet") partagé avec WhatsApp — d'où les erreurs
// de déchiffrement en boucle. Une seule connexion à la fois, point.
const startLocks = new Map();

/* ---- Verrou Postgres inter-processus (pg_advisory_lock) ----
   startLocks (ci-dessus) empêche deux connexions en parallèle DANS le même
   processus Node. Mais un connectionReplaced (statusCode 440) prouve qu'un
   AUTRE processus (l'ancienne instance Render pas encore éteinte pendant un
   redéploiement, un test lancé en local en parallèle de la prod, un service
   dupliqué...) tenait la même session au même moment — startLocks ne peut
   rien contre ça, il ne voit pas les autres processus.
   pg_advisory_lock résout ça au niveau de la base : un seul processus au
   monde peut tenir le verrou pour un userId donné. Le verrou est tenu par
   une connexion Postgres dédiée (pas via le pool, qui recycle ses clients) :
   tant que cette connexion reste ouverte, personne d'autre ne peut
   l'acquérir — et si le processus crashe brutalement, Postgres libère le
   verrou tout seul à la coupure de la connexion (pas de verrou "collé"
   après un crash). */
const lockClients = new Map(); // userId -> client pg dédié tenant le verrou

function lockKeyForUser(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return hash;
}

async function acquireSessionLock(userId) {
  if (lockClients.has(userId)) return true; // déjà tenu par ce processus
  const client = await pool.connect();
  const key = lockKeyForUser(userId);
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (res.rows[0].locked) {
      lockClients.set(userId, client);
      return true;
    }
    client.release();
    return false;
  } catch (e) {
    client.release();
    throw e;
  }
}

async function releaseSessionLock(userId) {
  const client = lockClients.get(userId);
  if (!client) return;
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKeyForUser(userId)]);
  } catch (e) {
    // Rien de plus à faire — si la requête échoue, le verrou tombera de
    // toute façon quand ce client sera relâché/fermé.
  } finally {
    client.release();
    lockClients.delete(userId);
  }
}

/**
 * Ferme proprement un socket existant (s'il y en a un) pour cet utilisateur,
 * avant qu'un nouveau ne soit créé. Ne déclenche jamais la reconnexion
 * automatique de l'ancien socket (on retire ses listeners d'abord).
 */
async function fermerSessionExistante(userId) {
  const existing = sessions.get(userId);
  if (!existing) return;
  console.log(`[${userId}] Session déjà présente en mémoire — fermeture propre avant reconnexion.`);
  try {
    existing.ev.removeAllListeners();
    existing.end?.(new Error('Remplacée par une nouvelle connexion'));
  } catch (e) {
    console.error(`[${userId}] Erreur en fermant l'ancienne session :`, e.message);
  }
  sessions.delete(userId);
  connectionOpen.set(userId, false);
  connectedSince.delete(userId);
}

/**
 * Démarre (ou redémarre) la session WhatsApp d'un utilisateur.
 * onQr(userId, qr) est appelé quand un QR code doit être scanné.
 * onStatus(userId, status) est appelé à chaque changement d'état de connexion.
 *
 * Sûr à appeler plusieurs fois pour le même userId, y compris en parallèle :
 * les appels sont mis en file (startLocks) et chacun ferme proprement la
 * session précédente avant d'en ouvrir une nouvelle — jamais deux sockets
 * actifs en même temps pour un même compte.
 */
export async function startSession(userId, { onQr, onStatus } = {}) {
  const previous = startLocks.get(userId) || Promise.resolve();
  const next = previous
    .catch(() => {}) // une erreur sur la tentative précédente ne doit pas bloquer celle-ci
    .then(() => demarrerSessionInterne(userId, { onQr, onStatus }));
  startLocks.set(userId, next);
  return next;
}

async function demarrerSessionInterne(userId, { onQr, onStatus } = {}) {
  await fermerSessionExistante(userId);

  const gotLock = await acquireSessionLock(userId);
  if (!gotLock) {
    // Un autre processus tient déjà cette session (chevauchement de
    // déploiement Render, test en local en parallèle, etc.) — se connecter
    // quand même provoquerait exactement le connectionReplaced observé.
    // On patiente et on retente, plutôt que de rentrer en conflit.
    console.error(
      `[${userId}] Verrou de session déjà tenu par un autre processus — ` +
      `nouvelle tentative dans 20s (vérifie qu'une seule instance du service tourne).`
    );
    onStatus?.(userId, 'lock_held_elsewhere');
    setTimeout(() => { startSession(userId, { onQr, onStatus }); }, 20000);
    return null;
  }

  // Le nouveau socket n'est pas encore ouvert : tant que 'connection.update'
  // n'a pas signalé "open", on ne doit pas considérer l'utilisateur comme
  // connecté (voir isConnected ci-dessous), même si `sessions` contient déjà
  // une référence à ce socket.
  connectionOpen.set(userId, false);
  connectedSince.delete(userId);

  const { state, saveCreds } = await useDBAuthState(pool, userId);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // évite un flood de logs Baileys en prod
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }); // debug local
      onQr?.(userId, qr); // à toi de renvoyer ce QR vers ton frontend pour affichage
    }

    if (connection === 'open') {
      connectionOpen.set(userId, true);
      // Horodatage du moment de connexion réelle — isStable() s'en sert pour
      // interdire les envois pendant les quelques secondes qui suivent,
      // fenêtre où le socket répond "ouvert" sans être encore fiable pour
      // envoyer (surtout après un connectionReplaced juste avant).
      connectedSince.set(userId, Date.now());
      onStatus?.(userId, 'connected');
    }

    if (connection === 'close') {
      // Dès qu'on détecte la coupure, on bloque les envois pour cet
      // utilisateur — avant même de savoir si on va se reconnecter — pour
      // ne jamais laisser un message partir sur ce socket mourant.
      connectionOpen.set(userId, false);
      connectedSince.delete(userId);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Toujours logguer la vraie raison renvoyée par WhatsApp/Baileys — sans
      // ça, un logged_out final est impossible à diagnostiquer après coup
      // (on ne sait pas s'il vient d'un vrai logout depuis le téléphone ou
      // d'un enchaînement d'erreurs qui y a mené).
      console.error(
        `[${userId}] connection close — statusCode=${statusCode ?? '?'} ` +
        `(${Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === statusCode) || 'inconnu'}) ` +
        `message=${lastDisconnect?.error?.message || '?'}`
      );

      // connectionReplaced (440) = une AUTRE session vient de prendre la main
      // sur ces mêmes identifiants (deux instances actives en parallèle, ex.
      // pendant un redéploiement Render qui chevauche brièvement l'ancienne
      // et la nouvelle instance, ou un double /connect). Se reconnecter
      // automatiquement dans ce cas relance la bagarre entre les deux
      // sessions, corrompt le chiffrement, et finit typiquement par un vrai
      // logged_out de WhatsApp (exactement le symptôme observé). On
      // n'auto-reconnecte donc PAS dans ce cas — il faut d'abord s'assurer
      // qu'une seule instance du service tourne, puis relancer /connect à la main.
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.connectionReplaced;

      onStatus?.(
        userId,
        statusCode === DisconnectReason.connectionReplaced
          ? 'connection_replaced'
          : (shouldReconnect ? 'reconnecting' : 'logged_out')
      );

      if (shouldReconnect) {
        // Reconnexion automatique — Baileys se déconnecte régulièrement,
        // c'est normal, il faut toujours relancer sauf déconnexion explicite (logout).
        // On garde le verrou pg (même processus, pas besoin de le relâcher
        // puis le reprendre à chaque coupure transitoire).
        startSession(userId, { onQr, onStatus });
      } else {
        sessions.delete(userId);
        connectionOpen.delete(userId);
        // Arrêt réel (logout, ou conflit avec un autre processus qui a
        // gagné entre-temps) : on libère le verrou, quelqu'un d'autre
        // (ou une reconnexion manuelle plus tard) pourra le reprendre.
        releaseSessionLock(userId);
      }
    }
  });

  // Suivi des accusés de réception WhatsApp : sendMessage() peut résoudre
  // "avec succès" côté code sans que le message soit réellement délivré
  // (numéro invalide/pas sur WhatsApp, serveur WA qui rejette après coup...).
  // On logge ces échecs pour qu'ils soient visibles dans les logs Render,
  // même si le code appelant ne peut rien faire de plus à ce stade.
  // Suivi des accusés de réception WhatsApp : sendMessage() peut résoudre
  // "avec succès" côté code sans que le message soit réellement délivré
  // (numéro invalide/pas sur WhatsApp, serveur WA qui rejette après coup...).
  // IMPORTANT : le statut "erreur" du protocole Baileys (proto
  // WebMessageInfoStatus) vaut 0 (ERROR), jamais -1 — l'ancien code testait
  // -1 et ne s'est donc JAMAIS déclenché sur un vrai échec, ce qui expliquait
  // des envois silencieusement perdus sans aucune trace dans les logs.
  // PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const status = u.update?.status;
      if (status === undefined) continue;
      if (status === 0) {
        console.error(
          `⚠️  Message ${u.key?.id || '?'} vers ${u.key?.remoteJid || '?'} rejeté par WhatsApp après envoi (numéro invalide, pas sur WhatsApp, ou blocage anti-spam).`
        );
      } else {
        // Log de visibilité (SERVER_ACK=2 est déjà un signe que ça part
        // réellement côté serveur WhatsApp, pas juste "accepté localement").
        console.log(`[${userId}] accusé de réception message ${u.key?.id || '?'} : statut=${status}`);
      }
    }
  });

  sessions.set(userId, sock);
  return sock;
}

export function getSession(userId) {
  return sessions.get(userId);
}

/**
 * Déconnecte complètement un compte : délie l'appareil côté WhatsApp
 * (sock.logout() — équivalent à le supprimer soi-même depuis le téléphone
 * dans "Appareils liés", pas besoin de le faire à la main), puis efface
 * toute trace de la session en base. Le compte repart à zéro : un nouveau
 * /connect/:userId générera un nouveau QR à scanner.
 */
export async function endSession(userId) {
  const sock = sessions.get(userId);
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      console.error(`[${userId}] Erreur lors du logout WhatsApp (on continue quand même) :`, e.message);
    }
    try {
      sock.ev.removeAllListeners();
      sock.end?.(new Error('Session supprimée depuis l\'admin'));
    } catch (e) {
      // rien de plus à faire, le socket est de toute façon abandonné ci-dessous
    }
  }
  sessions.delete(userId);
  connectionOpen.delete(userId);
  await clearAuthState(pool, userId);
  await releaseSessionLock(userId);
}

/**
 * true seulement si la connexion WebSocket avec WhatsApp est réellement
 * ouverte en ce moment (pas juste "un socket existe en mémoire" — voir le
 * commentaire sur connectionOpen plus haut).
 */
export function isConnected(userId) {
  return connectionOpen.get(userId) === true;
}

/**
 * Envoie un message texte. Le numéro doit être au format international
 * sans "+" ni espaces, ex: "2250700000000".
 */
export async function sendMessage(userId, phoneNumber, text) {
  const sock = getSession(userId);
  if (!sock || !isConnected(userId)) {
    throw new Error(`Aucune session WhatsApp active pour l'utilisateur ${userId}`);
  }
  // Défense en profondeur : si un numéro arrive avec des espaces, des tirets
  // ou un "+" (formats courants côté frontend), on les retire plutôt que
  // d'envoyer un JID invalide que Baileys accepterait sans erreur mais qui
  // n'atteindrait jamais personne.
  const numeroPropre = String(phoneNumber).replace(/[^\d]/g, '');
  const jid = `${numeroPropre}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text });
  console.log(`[${userId}] envoyé au socket, id=${result?.key?.id || '?'} vers ${jid} — en attente d'accusé de réception.`);
}

// À l'arrêt du processus (redéploiement Render, redémarrage manuel), on
// libère tout de suite les verrous pg tenus par ce processus — sinon la
// prochaine instance doit attendre que Postgres détecte tout seul la
// coupure de connexion (généralement rapide, mais autant ne pas laisser de
// fenêtre où le nouveau déploiement se croit bloqué pour rien).
async function releaseAllLocksOnShutdown() {
  const userIds = Array.from(lockClients.keys());
  await Promise.all(userIds.map((id) => releaseSessionLock(id)));
}
process.on('SIGTERM', () => { releaseAllLocksOnShutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { releaseAllLocksOnShutdown().finally(() => process.exit(0)); });
