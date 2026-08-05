import baileysPkg from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileysPkg;

// Une session = un compte WhatsApp connecté = un utilisateur de ta plateforme.
// On garde toutes les sessions actives en mémoire, indexées par userId.
const sessions = new Map();

const AUTH_DIR = path.resolve('./sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

/**
 * Démarre (ou redémarre) la session WhatsApp d'un utilisateur.
 * onQr(userId, qr) est appelé quand un QR code doit être scanné.
 * onStatus(userId, status) est appelé à chaque changement d'état de connexion.
 */
export async function startSession(userId, { onQr, onStatus } = {}) {
  const authFolder = path.join(AUTH_DIR, userId);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

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
      onStatus?.(userId, 'connected');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      onStatus?.(userId, shouldReconnect ? 'reconnecting' : 'logged_out');

      if (shouldReconnect) {
        // Reconnexion automatique — Baileys se déconnecte régulièrement,
        // c'est normal, il faut toujours relancer sauf déconnexion explicite (logout).
        startSession(userId, { onQr, onStatus });
      } else {
        sessions.delete(userId);
      }
    }
  });

  sessions.set(userId, sock);
  return sock;
}

export function getSession(userId) {
  return sessions.get(userId);
}

export function isConnected(userId) {
  return sessions.has(userId);
}

/**
 * Envoie un message texte. Le numéro doit être au format international
 * sans "+" ni espaces, ex: "2250700000000".
 */
export async function sendMessage(userId, phoneNumber, text) {
  const sock = getSession(userId);
  if (!sock) {
    throw new Error(`Aucune session WhatsApp active pour l'utilisateur ${userId}`);
  }
  const jid = `${phoneNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}
