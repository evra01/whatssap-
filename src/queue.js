import { sendMessage, isConnected } from './sessionManager.js';

// File d'attente en mémoire : suffisant pour un seul compte WhatsApp avec un
// volume modéré. Le prix à payer : la file est vidée si le process redémarre
// (contrairement à Redis/BullMQ qui persiste sur disque). Pour ce cas d'usage,
// c'est un compromis raisonnable — un redémarrage Render est rare et bref.
const queue = [];
let processing = false;

function randomDelay(minMs = 2000, maxMs = 8000) {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue[0];
    try {
      if (!isConnected(job.userId)) {
        throw new Error(`Session ${job.userId} non connectée`);
      }
      await sendMessage(job.userId, job.phoneNumber, job.text);
      console.log(`Message envoyé → ${job.phoneNumber}`);
      queue.shift();
      await randomDelay();
    } catch (e) {
      job.attempts = (job.attempts || 0) + 1;
      console.error(`Échec envoi (tentative ${job.attempts}/5) → ${job.phoneNumber}:`, e.message);
      if (job.attempts >= 5) {
        console.error(`Abandon définitif du message → ${job.phoneNumber}`);
        queue.shift();
      } else {
        // Backoff simple : on repousse ce job en fin de file et on attend
        // avant de retenter, plutôt que de bloquer toute la file dessus.
        queue.shift();
        queue.push(job);
        await new Promise((r) => setTimeout(r, 5000 * job.attempts));
      }
    }
  }
  processing = false;
}

export async function enqueueMessage({ userId, phoneNumber, text }) {
  queue.push({ userId, phoneNumber, text, attempts: 0 });
  processQueue(); // ne pas attendre : le traitement continue en arrière-plan
}

export const templates = {
  paiementValide: (nom, montant) =>
    `Bonjour ${nom}, votre paiement de ${montant} a bien été effectué. Merci !`,
  inscriptionValidee: (nom) =>
    `Bonjour ${nom}, votre inscription a été validée avec succès. Bienvenue !`,
};
