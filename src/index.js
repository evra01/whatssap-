import express from 'express';
import { startSession, isConnected } from './sessionManager.js';
import { enqueueMessage, templates } from './queue.js';
import { startAllSessions } from './sessionStore.js';
import {
  getEffectiveDailyCap,
  getTodayCount,
  getDailyCapOverride,
  setDailyCapOverride,
} from './rateLimit.js';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let lastQrByUser = {}; // stockage temporaire en mémoire — remplace par Redis/DB en prod

app.get('/', (req, res) => res.json({ status: 'ok', message: 'whatsapp-notifier actif' }));

app.get('/status/:userId', (req, res) => {
  res.json({ connected: isConnected(req.params.userId) });
});

app.get('/config/:userId', async (req, res) => {
  try {
    const [effectiveCap, todayCount, override] = await Promise.all([
      getEffectiveDailyCap(),
      getTodayCount(),
      getDailyCapOverride(),
    ]);
    res.json({ effectiveCap, todayCount, override });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/config/:userId', async (req, res) => {
  try {
    const { dailyCapOverride } = req.body;
    // dailyCapOverride: nombre pour forcer un plafond, ou null pour revenir
    // à la montée en charge automatique.
    await setDailyCapOverride(
      dailyCapOverride === null || dailyCapOverride === undefined || dailyCapOverride === ''
        ? null
        : parseInt(dailyCapOverride, 10)
    );
    const [effectiveCap, todayCount, override] = await Promise.all([
      getEffectiveDailyCap(),
      getTodayCount(),
      getDailyCapOverride(),
    ]);
    res.json({ effectiveCap, todayCount, override });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 1) Connexion d'un utilisateur de ta plateforme à son compte WhatsApp.
 * Le frontend appelle ça une fois, affiche le QR renvoyé, l'utilisateur scanne.
 */
app.post('/connect/:userId', async (req, res) => {
  const { userId } = req.params;

  await startSession(userId, {
    onQr: (uid, qr) => {
      lastQrByUser[uid] = qr;
    },
    onStatus: (uid, status) => {
      console.log(`[${uid}] statut: ${status}`);
      if (status === 'connected') delete lastQrByUser[uid];
    },
  });

  res.json({ message: 'Session en cours de démarrage, récupère le QR via /qr/:userId' });
});

app.get('/qr/:userId', (req, res) => {
  const qr = lastQrByUser[req.params.userId];
  if (!qr) return res.status(404).json({ message: 'Pas de QR en attente (déjà connecté ?)' });
  res.json({ qr });
});

/**
 * 2) Webhook déclenché par ta plateforme quand un paiement est validé.
 * Adapte le payload à ce que ton système envoie réellement.
 */
app.post('/webhook/paiement-valide', async (req, res) => {
  const { userId, telephoneClient, nomClient, montant } = req.body;

  if (!userId || !telephoneClient) {
    return res.status(400).json({ error: 'userId et telephoneClient sont requis' });
  }

  await enqueueMessage({
    userId,
    phoneNumber: telephoneClient,
    text: templates.paiementValide(nomClient || 'client', montant),
  });

  res.json({ message: 'Message mis en file d\'attente' });
});

/**
 * 3) Webhook déclenché quand une inscription est validée.
 */
app.post('/webhook/inscription-validee', async (req, res) => {
  const { userId, telephoneClient, nomClient } = req.body;

  if (!userId || !telephoneClient) {
    return res.status(400).json({ error: 'userId et telephoneClient sont requis' });
  }

  await enqueueMessage({
    userId,
    phoneNumber: telephoneClient,
    text: templates.inscriptionValidee(nomClient || 'utilisateur'),
  });

  res.json({ message: 'Message mis en file d\'attente' });
});

const PORT = process.env.PORT || 3000;
startAllSessions()
  .catch((e) => {
    console.error('Erreur au rechargement des sessions WhatsApp existantes :', e.message);
    console.error('Le serveur démarre quand même — /connect/:userId reste utilisable.');
  })
  .finally(() => {
    app.listen(PORT, () => console.log(`Serveur webhook lancé sur le port ${PORT}`));
  });
