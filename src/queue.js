import { sendMessage, isConnected } from './sessionManager.js';
import { canSendToday, incrementTodayCount } from './rateLimit.js';
import { pool } from './db.js';

// File d'attente persistée en base Postgres (et non plus en mémoire) : un
// message mis en attente doit finir par partir, même si le service redémarre
// entre-temps (veille Render, redéploiement, crash). En cas d'échec, on
// retente avec un délai croissant (backoff), plafonné pour ne pas marteler
// WhatsApp — et au-delà de MAX_ATTEMPTS tentatives (voir plus bas), le
// message est abandonné plutôt que retenté indéfiniment.
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_message_queue (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      text TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wa_message_queue_next_attempt_idx
    ON wa_message_queue (next_attempt_at)
  `);
  tableReady = true;
}

let processing = false;

function randomDelay(minMs = 2000, maxMs = 8000) {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

// 5s, 10s, 20s, 40s... plafonné à 30 min. Après MAX_ATTEMPTS tentatives sans
// succès, le message est abandonné (voir processQueue) plutôt que retenté
// indéfiniment — évite qu'un numéro invalide ou une session cassée depuis
// des jours ne s'accumule silencieusement en base pour toujours.
const MAX_ATTEMPTS = 20;

function backoffMs(attempts) {
  const base = 5000 * Math.pow(2, attempts);
  return Math.min(base, 30 * 60 * 1000);
}

async function nextJob() {
  const { rows } = await pool.query(
    `SELECT * FROM wa_message_queue WHERE next_attempt_at <= now() ORDER BY created_at ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function deleteJob(id) {
  await pool.query(`DELETE FROM wa_message_queue WHERE id=$1`, [id]);
}

async function rescheduleJob(id, attempts) {
  const delayMs = backoffMs(attempts);
  await pool.query(
    `UPDATE wa_message_queue
     SET attempts=$2, next_attempt_at = now() + ($3 * interval '1 millisecond')
     WHERE id=$1`,
    [id, attempts, delayMs]
  );
}

/**
 * Traite la file tant qu'il y a des messages prêts à partir (next_attempt_at
 * <= maintenant) et que le plafond quotidien le permet. Sûr à appeler
 * plusieurs fois en parallèle (le flag `processing` évite les doublons) —
 * appelé après chaque enqueueMessage() ET toutes les 30s (voir en bas de
 * fichier) pour reprendre automatiquement les messages en attente : après
 * une reconnexion WhatsApp, un plafond quotidien qui se libère à minuit, ou
 * un redémarrage du service qui retrouve une file non vide en base.
 */
export async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    await ensureTable();
    while (true) {
      const job = await nextJob();
      if (!job) break; // rien à envoyer pour l'instant

      const peutEnvoyer = await canSendToday();
      if (!peutEnvoyer) {
        console.log("→ Plafond quotidien WhatsApp atteint, message(s) en attente jusqu'à demain.");
        break;
      }

      try {
        if (!isConnected(job.user_id)) {
          throw new Error(`Session ${job.user_id} non connectée`);
        }
        await sendMessage(job.user_id, job.phone_number, job.text);
        await incrementTodayCount();
        console.log(`Message envoyé → ${job.phone_number}`);
        await deleteJob(job.id);
        await randomDelay();
      } catch (e) {
        const attempts = (job.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          console.error(
            `❌ Abandon définitif après ${attempts} tentatives → ${job.phone_number} ` +
            `(dernier échec : ${e.message}). Message supprimé de la file.`
          );
          await deleteJob(job.id);
          // On continue la boucle : un job abandonné ne doit pas bloquer les
          // suivants, contrairement à un échec normal (voir le `break` plus bas).
          continue;
        }
        const prochaineTentativeDans = Math.round(backoffMs(attempts) / 1000);
        console.error(
          `Échec envoi (tentative ${attempts}/${MAX_ATTEMPTS}) → ${job.phone_number}: ${e.message} ` +
          `— nouvelle tentative dans ~${prochaineTentativeDans}s.`
        );
        await rescheduleJob(job.id, attempts);
        // On s'arrête là pour ce passage plutôt que de reboucler tout de
        // suite sur un job qui vient d'échouer : le prochain message prêt
        // (ou le rappel périodique ci-dessous) reprendra le traitement.
        break;
      }
    }
  } finally {
    processing = false;
  }
}

export async function enqueueMessage({ userId, phoneNumber, text }) {
  await ensureTable();
  await pool.query(
    `INSERT INTO wa_message_queue (user_id, phone_number, text) VALUES ($1, $2, $3)`,
    [userId, phoneNumber, text]
  );
  processQueue(); // ne pas attendre : le traitement continue en arrière-plan
}

// Filet de sécurité : reprend le traitement toutes les 30s, indépendamment de
// tout nouvel enqueueMessage() — couvre la reconnexion WhatsApp après coupure,
// le plafond quotidien qui se libère, et les messages laissés en base par un
// redémarrage du service pendant qu'ils étaient en attente.
setInterval(() => {
  processQueue().catch((e) => console.error('Erreur processQueue:', e.message));
}, 30 * 1000);

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
  candidatureMaitre: (nomMaitre, resultat) =>
    resultat === "acceptee"
      ? pickRandom([
          `Bonjour ${nomMaitre} 🎉 Votre candidature a été acceptée ! Bienvenue chez Maître de Maison. Connectez-vous à votre espace pour compléter votre profil.`,
          `Félicitations ${nomMaitre} ✅ Votre candidature est validée. On est ravis de vous compter parmi nos maîtres de maison !`,
          `${nomMaitre}, bonne nouvelle 🙌 Votre candidature a été acceptée. Bienvenue dans l'équipe !`,
        ])
      : pickRandom([
          `Bonjour ${nomMaitre}, après étude de votre candidature, nous ne pouvons malheureusement pas y donner suite pour le moment. Merci de votre intérêt pour Maître de Maison.`,
          `Bonjour ${nomMaitre}, votre candidature n'a pas été retenue cette fois-ci. Nous vous remercions pour votre démarche.`,
        ]),
};
