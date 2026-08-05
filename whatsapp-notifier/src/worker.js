import { Worker } from 'bullmq';
import { connection } from './queue.js';
import { sendMessage, isConnected } from './sessionManager.js';
import { startAllSessions } from './sessionStore.js';

// Délai aléatoire entre deux envois pour un même utilisateur : évite le pattern
// "robotique" qui fait flag les comptes WhatsApp. Ajuste selon ton volume réel.
function randomDelay(minMs = 2000, maxMs = 8000) {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

async function boot() {
  // Recharge toutes les sessions existantes au démarrage du worker
  // (sinon un redémarrage du process déconnecte tout le monde).
  await startAllSessions();

  const worker = new Worker(
    'whatsapp-messages',
    async (job) => {
      const { userId, phoneNumber, text } = job.data;

      if (!isConnected(userId)) {
        // Session pas encore prête (ex: process qui vient de redémarrer) →
        // on relance une erreur pour déclencher le retry/backoff de BullMQ.
        throw new Error(`Session ${userId} non connectée, nouvelle tentative programmée`);
      }

      await sendMessage(userId, phoneNumber, text);
      await randomDelay();
    },
    {
      connection,
      concurrency: 5, // nombre de messages traités en parallèle, tous utilisateurs confondus
      limiter: {
        max: 20,       // ex: max 20 messages
        duration: 60000, // par minute, tous utilisateurs confondus — à ajuster selon ta volumétrie
      },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Échec envoi message (job ${job.id}):`, err.message);
  });

  worker.on('completed', (job) => {
    console.log(`Message envoyé (job ${job.id}) → ${job.data.phoneNumber}`);
  });
}

boot();
