import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export const messageQueue = new Queue('whatsapp-messages', { connection });

/**
 * Ajoute un message à envoyer. Ne l'envoie JAMAIS directement depuis le webhook :
 * ça évite les envois en rafale et permet le retry si la session est down.
 */
export async function enqueueMessage({ userId, phoneNumber, text }) {
  await messageQueue.add(
    'send',
    { userId, phoneNumber, text },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );
}

// Petits gabarits de messages pour les deux cas mentionnés.
// Centraliser le texte ici évite de le dupliquer dans chaque route webhook.
export const templates = {
  paiementValide: (nom, montant) =>
    `Bonjour ${nom}, votre paiement de ${montant} a bien été effectué. Merci !`,
  inscriptionValidee: (nom) =>
    `Bonjour ${nom}, votre inscription a été validée avec succès. Bienvenue !`,
};
