import { sendMessage, isConnected } from './sessionManager.js';
import { canSendToday, incrementTodayCount } from './rateLimit.js';

// File d'attente en mémoire : suffisant pour un seul compte WhatsApp avec un
// volume modéré. Le prix à payer : la file est vidée si le process redémarre
// (contrairement à Redis/BullMQ qui persiste sur disque). Pour ce cas d'usage,
// c'est un compromis raisonnable — un redémarrage Render est rare et bref.
const queue = [];
let processing = false;

function randomDelay(minMs = 2000, maxMs = 8000) {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

// Si le plafond du jour est atteint, on attend avant de revérifier plutôt
// que de bloquer la file indéfiniment ou d'abandonner les messages.
function waitBeforeRecheck() {
  return new Promise((resolve) => setTimeout(resolve, 15 * 60 * 1000)); // 15 min
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue[0];

    const peutEnvoyer = await canSendToday();
    if (!peutEnvoyer) {
      console.log('→ Plafond quotidien WhatsApp atteint, message en attente jusqu\'à demain.');
      processing = false;
      // On relance la boucle plus tard sans bloquer le reste du serveur.
      setTimeout(() => processQueue(), 15 * 60 * 1000);
      return;
    }

    try {
      if (!isConnected(job.userId)) {
        throw new Error(`Session ${job.userId} non connectée`);
      }
      await sendMessage(job.userId, job.phoneNumber, job.text);
      await incrementTodayCount();
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

function pickRandom(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

// Plusieurs variantes par événement : un texte identique envoyé à l'identique
// à chaque fois est un signal reconnaissable par les systèmes anti-spam.
// Émojis en petite quantité (pas de surcharge, qui ferait "spam" à l'inverse).
export const templates = {
  paiementValide: (nom, montant) =>
    pickRandom([
      `Bonjour ${nom} ✅ Votre paiement de ${montant} a bien été reçu. Merci !`,
      `Salut ${nom} 👋 Paiement de ${montant} confirmé, tout est en ordre. Merci !`,
      `Bonjour ${nom}, on confirme la réception de votre paiement (${montant}) ✅ Merci de votre confiance.`,
      `${nom}, votre paiement de ${montant} est bien validé ✅ À bientôt !`,
    ]),
  inscriptionValidee: (nom) =>
    pickRandom([
      `Bonjour ${nom} 🎉 Votre inscription est validée. Bienvenue parmi nous !`,
      `Bienvenue ${nom} ✅ Votre dossier est confirmé, on est ravis de vous compter avec nous 🙌`,
      `Bonjour ${nom}, c'est confirmé : votre inscription a été validée ✅ Bienvenue !`,
      `${nom}, tout est bon de notre côté 🎉 Votre inscription est validée. À bientôt !`,
    ]),
  maitreChoisi: (nomMaitre, parentNom, enfantPrenom) =>
    pickRandom([
      `Bonjour ${nomMaitre} 🎉 Vous avez été choisi(e) par ${parentNom} pour accompagner ${enfantPrenom}. Connectez-vous à votre espace pour voir les détails.`,
      `Bonne nouvelle ${nomMaitre} ✅ ${parentNom} vous a sélectionné(e) pour ${enfantPrenom}. Retrouvez toutes les infos dans votre espace maître.`,
      `${nomMaitre}, une famille vous a choisi(e) ! 🙌 ${parentNom} souhaite vous confier le suivi de ${enfantPrenom}. Détails dans votre espace.`,
    ]),
};
