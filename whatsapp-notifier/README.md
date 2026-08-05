# WhatsApp Notifier — Starter

Système d'envoi automatique de messages WhatsApp déclenché par des événements
(paiement validé, inscription validée, etc.), pour une plateforme
multi-utilisateurs où chaque personne connecte son propre compte WhatsApp.

⚠️ **Ceci utilise Baileys, une librairie non-officielle.** Il n'y a pas d'API
publique WhatsApp gratuite pour ce cas d'usage : Baileys simule un client
WhatsApp Web connecté au compte de l'utilisateur. Ça marche bien, mais WhatsApp
peut suspendre un numéro s'il détecte un comportement de spam (trop de
messages, trop vite, contenu trop répétitif). Le code inclut des délais
aléatoires et un plafond de débit pour limiter ce risque, mais le risque zéro
n'existe pas avec cette approche.

## Architecture

```
Webhook (paiement/inscription) → Queue (Redis/BullMQ) → Worker → Session Baileys → WhatsApp
```

Le webhook ne fait qu'ajouter le message à une file d'attente : il ne l'envoie
jamais directement. Le worker consomme cette file avec un débit contrôlé.

## Installation

```bash
npm install
```

Il te faut aussi un serveur Redis (local ou hébergé, ex: Upstash, Railway).

```bash
export REDIS_URL="redis://localhost:6379"
```

## Lancement

Deux process séparés à faire tourner en parallèle :

```bash
npm start    # serveur webhook (src/index.js)
npm run worker  # worker d'envoi (src/worker.js)
```

## Connecter un utilisateur à WhatsApp

```bash
curl -X POST http://localhost:3000/connect/user123
curl http://localhost:3000/qr/user123
```

Affiche le QR renvoyé dans ton frontend (génère une image QR à partir de la
chaîne, ex: avec la lib `qrcode` côté frontend). L'utilisateur scanne depuis
WhatsApp > Appareils liés. La session est ensuite sauvegardée dans
`./sessions/user123/` et rechargée automatiquement au redémarrage.

## Déclencher un message

```bash
curl -X POST http://localhost:3000/webhook/paiement-valide \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123","telephoneClient":"2250700000000","nomClient":"Awa","montant":"5000 FCFA"}'
```

## À adapter avant la prod

- **Persistance des `userId` actifs** : `sessionStore.js` relit le dossier
  `./sessions` au démarrage — ça marche mais passe par une vraie table en
  base si tu as beaucoup d'utilisateurs.
- **Sécuriser les webhooks** : ajoute une vérification de signature ou un
  token secret, sinon n'importe qui peut déclencher l'envoi de messages via
  tes utilisateurs connectés.
- **Format des numéros** : valide/normalise le format international avant
  de mettre en queue (ex: lib `libphonenumber-js`).
- **Monitoring des sessions** : expose un endpoint `/status/:userId` pour
  que ton frontend affiche si la session est connectée, déconnectée, ou en
  attente de scan.
