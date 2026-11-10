# Reddit Video Feed

Un lecteur de vidéos Reddit plein écran, façon TikTok, **qui reste dans le subreddit choisi** :
tu scrolles de vidéo en vidéo, uniquement celles du sub, sans recommandations venues d'ailleurs.

## Lancer

En local :

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Puis ouvre <http://localhost:8080>.

Avec Docker (par exemple sur le serveur Unraid) :

```bash
docker compose up -d --build
```

Puis ouvre `http://IP-DU-SERVEUR:8080`, y compris depuis le téléphone sur le même réseau.

### Sur GitHub Pages (sans serveur)

L'interface est aussi publiée sur <https://freedomfr.github.io/reddit-video-feed/>, à chaque push sur `main`
(workflow `.github/workflows/pages.yml`). Sans serveur, c'est le navigateur qui interroge Reddit, et Reddit
n'accepte ça que via son API officielle. Il faut donc une fois :

1. Sur <https://www.reddit.com/prefs/apps>, « create another app… », type **installed app**,
   redirect uri `http://localhost` (non utilisée).
2. Copier le code affiché sous le nom de l'app (le `client_id`) et le coller dans le champ
   « Identifiant de ton app Reddit » des réglages de la page (il s'ouvre tout seul au premier lancement).

L'identifiant reste dans le navigateur (à refaire sur chaque appareil). Il n'y a pas de secret pour ce type
d'app. Le serveur Docker, lui, n'en a pas besoin et reste utilisable tel quel : la page détecte toute seule
si elle a un serveur derrière elle.

## Utilisation

- Touche la pastille en haut à gauche (ou `/`) pour choisir un subreddit, le tri et la période.
- Plusieurs subs d'un coup : `funny+aww`.
- L'adresse mémorise l'état (`?r=videos&s=top&t=week`), donc tu peux la mettre en favori.

| Action | Clavier | Tactile / souris |
|---|---|---|
| Vidéo suivante / précédente | `J` / `K` ou `↓` / `↑` | glisser verticalement, molette, flèches à droite |
| Pause | `Espace` | toucher la vidéo |
| Son | `M` | bouton haut-parleur |
| Ouvrir le post sur Reddit | `O` | bouton à droite |
| Aller à un endroit de la vidéo | | cliquer ou glisser sur la barre en bas |

Les navigateurs interdisent le son tant que tu n'as pas touché la page : le premier clic ou la première
touche l'active.

Réglages : son par défaut, passage automatique à la vidéo suivante (sinon la vidéo boucle), affichage du NSFW
(masqué par défaut).

## Ce qui est lu

Vidéos hébergées par Reddit (avec leur son), GIF convertis en vidéo par Reddit, et crossposts de ces médias.
Les liens vers YouTube, RedGifs, Streamable, etc. sont ignorés : ils ne sont pas lisibles proprement
en plein écran.

## Si Reddit refuse les requêtes

Reddit bloque parfois les requêtes anonymes (erreur 403 ou 429). Depuis une connexion résidentielle ça passe
en général. Sinon, crée une app sur <https://www.reddit.com/prefs/apps> (type « script » ou « installed app ») et passe
ses identifiants au serveur :

```bash
REDDIT_CLIENT_ID=xxxx REDDIT_CLIENT_SECRET=yyyy python app.py
```

(ou dans `docker-compose.yml`). Le serveur utilise alors l'API officielle en lecture seule, sans compte utilisateur.

Autres variables : `PORT` (8080 par défaut, hors Docker), `CACHE_TTL` (durée du cache en secondes, 60 par défaut),
`REDDIT_USER_AGENT`.

## Structure

- `app.py` : serveur Flask. `/api/feed` interroge Reddit et ne garde que les vidéos ; `/api/audio/<id>`
  retrouve le fichier son d'une vidéo Reddit (image et son sont séparés chez eux).
- `static/` : l'interface (HTML, CSS, JS sans dépendance ni étape de build). `static/reddit.js` reprend la
  logique de `app.py` côté navigateur pour la version GitHub Pages.
