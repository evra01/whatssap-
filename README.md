# WhatsApp Notifier — v2.1 (Render, sans Redis, sans disque payant)

Système d'envoi automatique de messages WhatsApp déclenché par des événements
(paiement validé, inscription validée), pour un seul compte WhatsApp connecté
(la structure).

Les identifiants de connexion WhatsApp (session Baileys) sont stockés dans une
table Postgres (`wa_auth_state`) plutôt que sur un disque local — donc aucun
disque persistant payant n'est nécessaire. Réutilise la même base
Postgres/Supabase que ton app principale si tu en as déjà une, ou n'importe
quelle base Postgres gratuite.

⚠️ Utilise Baileys (librairie non-officielle) : risque réel de suspension de
numéro en cas d'envoi massif ou trop rapide — le code inclut des délais
aléatoires et un ordre de traitement séquentiel pour limiter ce risque.

## Déploiement sur Render

### 1. Créer le service

Render → **New** → **Web Service** → connecte ton repo GitHub
`whatsapp-notifier`.

- **Runtime** : Node
- **Build Command** : `npm install`
- **Start Command** : `npm start`

### 2. Variable d'environnement

```
DATABASE_URL=<ta connection string Postgres/Supabase>
```

Si tu as déjà une base Postgres pour un autre projet (ex: Maître de Maison),
tu peux réutiliser exactement la même valeur de `DATABASE_URL` — ce service
crée sa propre table (`wa_auth_state`) sans toucher aux tables existantes.

### 3. Récupérer l'URL publique

Render en génère une automatiquement (`https://ton-service.onrender.com`).

### 4. Connecter le compte WhatsApp

```bash
curl -X POST https://ton-service.onrender.com/connect/structure
curl https://ton-service.onrender.com/qr/structure
```

Génère l'image QR à partir de la chaîne renvoyée (scanne-la vite, elle expire
en 20-60 secondes), depuis WhatsApp > Appareils liés.

### 5. Brancher sur le serveur principal (Maître de Maison)

Variables d'env sur le service `maitre-de-maison-1` :
```
WHATSAPP_WEBHOOK_URL=https://ton-service.onrender.com
WHATSAPP_USER_ID=structure
```

## Notes

- File d'attente en mémoire (pas de Redis) : suffisant pour un compte à
  volume modéré. Si le service redémarre en pleine journée, les messages en
  attente à cet instant précis sont perdus (rare, et sans impact sur les
  paiements déjà enregistrés en base côté app principale).
- Web Service gratuit Render : le service se met en veille après 15 min
  d'inactivité et redémarre à la prochaine requête (délai de ~30-60s sur le
  premier appel). La session WhatsApp elle-même n'est PAS perdue à chaque
  réveil grâce au stockage en base — juste un léger délai de reconnexion.

## Sécurité anti-bannissement

- **Plafond quotidien progressif** : 15 messages/jour la première semaine,
  30/jour les 2e-3e semaines, puis le plafond configuré ensuite
  (`WHATSAPP_DAILY_CAP`, 40 par défaut). Persisté en base — survit aux
  redémarrages. Les messages en excès attendent le lendemain automatiquement.
- **Messages variés** : plusieurs formulations différentes par type
  d'événement (paiement/inscription), choisies aléatoirement — évite le
  pattern "texte identique en boucle" détecté par les systèmes anti-spam.
- **Délais aléatoires** entre chaque envoi (2-8s), déjà en place.
- Recommandé en plus (pas automatisable) : utiliser un compte WhatsApp
  Business avec un historique d'usage normal avant d'automatiser, surveiller
  les messages à 1 coche (non livrés) qui indiquent un problème.

Pour ajuster le plafond une fois le compte "chaud" (après plusieurs
semaines sans souci) :
```
WHATSAPP_DAILY_CAP=80
```
