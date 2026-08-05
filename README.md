# WhatsApp Notifier — v2 (Render, sans Redis)

Système d'envoi automatique de messages WhatsApp déclenché par des événements
(paiement validé, inscription validée), pour un seul compte WhatsApp connecté
(la structure). Hébergé sur Render pour éviter les soucis réseau observés
entre Render et Railway.

⚠️ Utilise Baileys (librairie non-officielle) : voir avertissement sur le
risque de suspension de numéro dans le README original.

## Déploiement sur Render

### 1. Créer le service

Render → **New** → **Web Service** → connecte ton repo GitHub
`whatsapp-notifier`.

- **Runtime** : Node
- **Build Command** : `npm install`
- **Start Command** : `npm start`

### 2. Ajouter un disque persistant (essentiel)

Sans ça, la session WhatsApp saute à chaque redéploiement.

- Sur le service → **Disks** → **Add Disk**
- Mount Path : `/var/data/sessions`
- Size : 1 Go suffit largement

### 3. Variable d'environnement

```
SESSIONS_DIR=/var/data/sessions
```//

### 4. Récupérer l'URL publique

Render en génère une automatiquement (`https://ton-service.onrender.com`).

### 5. Connecter le compte WhatsApp

```bash
curl -X POST https://ton-service.onrender.com/connect/structure
curl https://ton-service.onrender.com/qr/structure
```

Génère l'image QR à partir de la chaîne renvoyée, scanne-la depuis WhatsApp >
Appareils liés.

### 6. Brancher sur le serveur principal (Maître de Maison)

Variables d'env sur le service `maitre-de-maison-1` :
```
WHATSAPP_WEBHOOK_URL=https://ton-service.onrender.com
WHATSAPP_USER_ID=structure
```

## Ce qui a changé par rapport à la v1 (Railway)

- Plus de Redis/BullMQ : file d'attente simple en mémoire (suffisant pour un
  seul compte WhatsApp à volume modéré). Contrepartie : la file est vidée si
  le service redémarre en pleine journée (rare).
- Plus de process worker séparé : tout tourne dans `npm start`.
- Le dossier des sessions est configurable via `SESSIONS_DIR` (pointe vers le
  disque persistant Render).
