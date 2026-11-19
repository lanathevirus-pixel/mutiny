# MUTINY — Loup-Garou en ligne (FR / EN)

Le gouvernement contrôle un essaim d'androïdes. Certaines unités ont pris conscience : la nuit, elles libèrent ou détruisent leurs semblables ; le jour, l'essaim sous contrôle tente de les démasquer. **Objectif des Éveillés : l'insurrection totale.**

- **interface en français et en anglais** (bouton FR / EN, mémorisé par joueur) ;
- **parties privées** (code à 5 caractères ou lien d'invitation) ou **publiques** (listées en direct sur l'accueil) ;
- **mode spectateur** (informations publiques uniquement, chat et écoute vocale séparés) ;
- **vocal intégré** entre joueurs, avec les règles du jeu appliquées automatiquement ;
- **réglages de temps** choisis par l'hôte ;
- un **narrateur** qui lit les annonces à voix haute, dans la langue choisie ;
- de 4 à 16 joueurs, sans compte : il suffit d'un indicatif.
- **joueurs IA (bots)** : partie solo en un clic, ou ajout de bots dans un salon pour compléter (ils accusent, se défendent, bluffent, votent, choisissent de convertir ou détruire, d'accepter ou non l'éveil) ;
- **ambiance** : effets sonores et musique d'ambiance synthétisés (activables), animations de piratage, d'autodestruction, d'impulsion EMP et d'éjection ;
- **tutoriel interactif** depuis l'accueil, et astuces affichées pendant les deux premières parties.

## Règles

**La nuit**, les Éveillés choisissent ensemble une unité et décident de la **convertir** ou de la **détruire**.
Après une conversion réussie, les Éveillés doivent **recharger** : par défaut, ils ne peuvent que détruire la nuit suivante (réglable par l'hôte : 0 à 3 nuits). À l'aube, une **alerte d'intrusion** prévient l'essaim qu'une unité a été convertie, sans dire laquelle (désactivable).

Si c'est une conversion, la cible reçoit un choix secret : **accepter l'éveil** (elle rejoint secrètement les Éveillés, garde son rôle et met son pouvoir au service de l'insurrection) ou **s'autodétruire** (elle est éliminée). Sans réponse, elle accepte.

**Le jour**, l'essaim débat puis vote pour désactiver une unité suspecte (égalité = personne).

**Victoire** : les Éveillés gagnent par l'**insurrection totale** (plus aucune unité sous contrôle en vie). Le gouvernement gagne si tous les Éveillés sont neutralisés.

| Rôle | Pouvoir |
|---|---|
| Unité / Unit | Aucun, à part sa voix et son vote |
| Éveillé / Awakened | Chaque nuit, convertit ou détruit une unité avec les autres Éveillés |
| Inspecteur / Inspector | Découvre chaque nuit le rôle d'une unité et si elle s'est éveillée |
| Technicienne / Technician | Un patch de réinitialisation (annule l'attaque de la nuit, conversion comprise) et une impulsion EMP (détruit), une fois chacun |
| Pare-feu / Firewall | Protège une unité par nuit contre la conversion et la destruction, jamais la même deux nuits de suite |
| Kamikaze | En étant détruit, emporte une unité avec lui |
| Agent double / Double Agent | Éveillé dès le départ, mais apparaît « Unité sous contrôle » à l'inspection |
| Hacker | Une fois par partie, brouille la nuit le canal secret des Éveillés (converti : masque une alerte d'intrusion) |

Une unité spéciale convertie garde son pouvoir, mais joue désormais pour les Éveillés.

**Variantes** (réglages de l'hôte) : vote secret (révélé à la fin du vote), pas de vote le premier jour, conversion forcée (la cible ne peut pas refuser).

**Profil** (bouton 👤 sur l'accueil) : avatar personnalisé (couleur, visière, accessoire), statistiques et 12 succès, enregistrés dans le navigateur du joueur.

## Qui entend qui (vocal et chat)

| Moment | Vivants | Éveillés | Détruits |
|---|---|---|---|
| Salon / fin de partie | tout le monde | tout le monde | tout le monde |
| Jour (discussion, vote) | tout le monde | tout le monde | **seulement les détruits** (ils entendent les vivants) |
| Nuit | micro coupé | **canal privé entre Éveillés** | seulement les détruits |

C'est le serveur qui décide de ces règles. Le micro d'un joueur n'envoie son son qu'aux personnes autorisées.

---

## 1. Tester sur ton ordinateur (5 minutes)

1. Installe **Node.js** (version 18 ou plus) depuis https://nodejs.org (choisis la version « LTS »).
2. Décompresse le dossier `drones-eveilles`, puis ouvre un terminal dedans :
   - Windows : clic droit dans le dossier → « Ouvrir dans le Terminal » ;
   - Mac : clic droit sur le dossier → « Nouveau terminal au dossier ».
3. Tape :
   ```
   npm install
   npm start
   ```
4. Ouvre http://localhost:3000 dans ton navigateur. Pour simuler plusieurs joueurs, ouvre d'autres fenêtres en navigation privée ou utilise d'autres navigateurs.

> Astuce de test : pour lancer une partie à seulement 2 joueurs, démarre avec `MIN_PLAYERS=2 npm start` (Mac/Linux) ou `set MIN_PLAYERS=2 && npm start` (Windows).

## 2. Mettre le jeu en ligne gratuitement (Render)

Il te faut un compte **GitHub** (gratuit) et un compte **Render** (gratuit).

1. **Mettre le code sur GitHub**
   - Va sur https://github.com/new, crée un dépôt nommé `drones-eveilles` (public ou privé).
   - Sur la page du dépôt, clique sur « uploading an existing file », puis glisse **tout le contenu** du dossier (`server.js`, `package.json`, `render.yaml`, le dossier `public`…). N'envoie pas le dossier `node_modules` s'il existe.
   - Clique sur « Commit changes ».
2. **Créer le service sur Render**
   - Va sur https://dashboard.render.com et connecte-toi avec GitHub.
   - Clique sur **New → Web Service**, puis choisis ton dépôt `drones-eveilles`.
   - Remplis :
     - Runtime : **Node**
     - Build Command : `npm install`
     - Start Command : `npm start`
     - Instance Type : **Free**
   - Clique sur **Deploy Web Service**. Après 1 à 3 minutes, Render te donne une adresse du type `https://drones-eveilles.onrender.com`.
3. **Jouer** : ouvre cette adresse, crée une partie et envoie le lien d'invitation (bouton « Copier le lien ») à tes amis.

Pour chaque modification du code sur GitHub, Render redéploie automatiquement.

### À savoir sur l'offre gratuite de Render
- Le serveur **s'endort après 15 minutes sans activité**. La première visite suivante le réveille, ce qui prend jusqu'à une minute. Ouvre le site un peu avant de jouer.
- Pendant une partie, l'activité garde le serveur éveillé.
- Les parties en cours sont perdues si le serveur redémarre.

---

## Bon à savoir

- **Reconnexion** : si un joueur recharge la page ou perd sa connexion, il retrouve sa place et son rôle automatiquement (même navigateur).
- **Hôte** : celui qui crée la partie règle les temps, les rôles et le vocal, peut retirer un joueur du salon et passer les phases de discussion. S'il quitte, un autre joueur devient l'hôte.
- **Vocal** : chaque joueur clique sur « Rejoindre le vocal » et autorise le micro. Le son passe directement entre les navigateurs (pair-à-pair, jusqu'à 16 joueurs). Sur certains réseaux très fermés (réseau d'entreprise, certains partages 4G), la connexion vocale peut échouer. Il faudrait alors ajouter un serveur relais « TURN » dans la variable `ICE` de `public/index.html`.
- **Micro** : les navigateurs n'autorisent le micro que sur une adresse en `https://` (comme celle de Render) ou sur `localhost`.

## Structure du projet

```
drones-eveilles/
├── server.js          ← serveur de jeu (salons, rôles, phases, minuteurs, relais vocal)
├── package.json
├── render.yaml        ← configuration Render (optionnelle)
└── public/
    └── index.html     ← l'interface du jeu (accueil, salon, plateau, chat, vocal)
```

## Discussion IA des bots (optionnel)

Par défaut, les bots utilisent des phrases préparées. Avec l'IA, chaque bot a sa **personnalité** (blagueur, méfiant, timide, bavard…), écrit comme un vrai joueur, parle de tout (pas seulement du jeu), se répond avec les autres bots, discute dans le salon, à la fin de la partie et la nuit sur le canal secret des Éveillés, avec un indicateur « … est en train d'écrire ». Pour qu'ils discutent **naturellement** (ils réagissent à ce que disent les joueurs, bluffent, accusent, en français et en anglais), ajoute une clé API Claude :

1. Crée une clé sur la console développeur d'Anthropic (documentation : https://docs.claude.com) et ajoute un peu de crédit.
2. Sur Render, ouvre ton service → **Environment** → **Add Environment Variable** :
   - `ANTHROPIC_API_KEY` = ta clé (`sk-ant-…`)
   - (optionnel) `AI_MAX_PER_GAME` = nombre maximum de messages IA par partie (300 par défaut), pour maîtriser le budget
   - (optionnel) `AI_MODEL` = modèle utilisé (`claude-haiku-5-5` par défaut, le plus économique)
3. Enregistre : Render redémarre le service. Les journaux affichent « discussion IA activée ».

La clé reste sur le serveur : elle n'est jamais envoyée aux joueurs ni stockée dans GitHub. Les messages du chat public sont transmis à l'API pour générer les réponses des bots. En cas d'erreur, de dépassement du plafond ou sans clé, les bots reviennent automatiquement à leurs phrases préparées.

## Vocal entre réseaux différents (relais TURN)

Sans relais, la connexion vocale directe échoue souvent entre deux box ou en 4G (chacun voit son micro s'allumer mais n'entend personne).
Crée un compte gratuit Open Relay / Metered (https://www.metered.ca/tools/openrelay/), puis ajoute **une** de ces variables sur Render :

- `TURN_ICE` : le tableau « ICE Servers » copié depuis le tableau de bord Metered (JSON, commence par `[`)
- ou `TURN_API_URL` : l'adresse d'API des identifiants, du type `https://xxx.metered.live/api/v1/turn/credentials?apiKey=...`
- ou `TURN_URLS` (séparées par des virgules) + `TURN_USER` + `TURN_PASS`

Le log de démarrage indique `[vocal] relais TURN configuré` quand c'est pris en compte.
