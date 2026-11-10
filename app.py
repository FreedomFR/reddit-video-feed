"""Reddit Video Feed.

Petit serveur Flask qui :
  * sert l'interface plein écran (dossier static/) ;
  * interroge Reddit à la place du navigateur (le JSON de Reddit n'autorise pas le CORS) ;
  * ne renvoie que les posts vidéo du subreddit demandé, prêts à être lus.
"""
import os
import re
import threading
import time
import xml.etree.ElementTree as ET

import requests
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="/static")

# ---------------------------------------------------------------- configuration
USER_AGENT = os.environ.get(
    "REDDIT_USER_AGENT", "python:reddit-video-feed:1.0 (visionneuse perso auto-hébergée)"
)
CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
FEED_TTL = int(os.environ.get("CACHE_TTL", "60"))  # secondes
TARGET_ITEMS = 10  # vidéos visées par appel /api/feed
MAX_PAGES = 5  # pages Reddit (100 posts) lues au maximum par appel

SORTS = {"hot", "new", "top", "rising", "controversial"}
TIMES = {"hour", "day", "week", "month", "year", "all"}
SUB_RE = re.compile(r"^[A-Za-z0-9_]{2,21}(\+[A-Za-z0-9_]{2,21}){0,24}$")
AFTER_RE = re.compile(r"^t3_[a-z0-9]{4,12}$")
VIDEO_ID_RE = re.compile(r"^[a-z0-9]{6,20}$")

http = requests.Session()
http.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

_MISSING = object()


class TTLCache:
    """Cache mémoire minimaliste, thread-safe."""

    def __init__(self, maxsize=300):
        self._data = {}
        self._lock = threading.Lock()
        self._maxsize = maxsize

    def get(self, key):
        with self._lock:
            hit = self._data.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            self._data.pop(key, None)
        return _MISSING

    def set(self, key, value, ttl):
        with self._lock:
            if len(self._data) >= self._maxsize:
                now = time.time()
                for k in [k for k, (exp, _) in self._data.items() if exp <= now]:
                    del self._data[k]
                if len(self._data) >= self._maxsize:
                    self._data.pop(next(iter(self._data)))
            self._data[key] = (time.time() + ttl, value)


feed_cache = TTLCache()
audio_cache = TTLCache()


class RedditError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------- OAuth (optionnel)
_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()


def get_token():
    """Jeton « application seule » si REDDIT_CLIENT_ID est défini, sinon None."""
    if not CLIENT_ID:
        return None
    with _token_lock:
        if _token["value"] and time.time() < _token["expires"] - 60:
            return _token["value"]
        if CLIENT_SECRET:
            data = {"grant_type": "client_credentials"}
        else:
            data = {
                "grant_type": "https://oauth.reddit.com/grants/installed_client",
                "device_id": "DO_NOT_TRACK_THIS_DEVICE",
            }
        try:
            r = http.post(
                "https://www.reddit.com/api/v1/access_token",
                auth=(CLIENT_ID, CLIENT_SECRET),
                data=data,
                timeout=10,
            )
            r.raise_for_status()
            payload = r.json()
            _token["value"] = payload["access_token"]
            _token["expires"] = time.time() + int(payload.get("expires_in", 3600))
        except (requests.RequestException, ValueError, KeyError) as exc:
            raise RedditError(
                f"Connexion OAuth à Reddit impossible ({exc.__class__.__name__}). "
                "Vérifie REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.",
                502,
            )
        return _token["value"]


# ---------------------------------------------------------------- lecture de Reddit
def fetch_page(sub, sort, t, after):
    params = {"raw_json": 1, "limit": 100}
    if after:
        params["after"] = after
    if sort in ("top", "controversial"):
        params["t"] = t
    path = f"/r/{sub}/{sort}"

    token = get_token()
    if token:
        attempts = [("https://oauth.reddit.com" + path, {"Authorization": f"bearer {token}"})]
    else:
        attempts = [
            (f"https://www.reddit.com{path}.json", {}),
            (f"https://old.reddit.com{path}.json", {}),
        ]

    last = "inconnue"
    for url, headers in attempts:
        try:
            r = http.get(
                url, params=params, headers=headers, cookies={"over18": "1"}, timeout=15
            )
        except requests.RequestException as exc:
            last = f"réseau : {exc.__class__.__name__}"
            continue

        if r.status_code == 200:
            if "/subreddits/search" in r.url:  # Reddit redirige quand le sub n'existe pas
                raise RedditError("Subreddit introuvable.", 404)
            try:
                return r.json()
            except ValueError:
                last = "réponse non JSON"
                continue
        if r.status_code == 404:
            raise RedditError("Subreddit introuvable.", 404)
        if r.status_code == 429:
            raise RedditError(
                "Reddit limite temporairement les requêtes (429). Réessaie dans une minute.", 429
            )
        if r.status_code == 403:
            reason = ""
            try:
                reason = r.json().get("reason", "")
            except ValueError:
                pass
            if reason in ("private", "banned", "quarantined", "gated"):
                raise RedditError(f"Subreddit inaccessible ({reason}).", 403)
        last = f"HTTP {r.status_code}"

    raise RedditError(
        f"Reddit a refusé la requête ({last}). Si ça persiste, renseigne "
        "REDDIT_CLIENT_ID et REDDIT_CLIENT_SECRET (voir le README).",
        502,
    )


def _poster(d):
    images = (d.get("preview") or {}).get("images") or []
    if not images:
        thumb = d.get("thumbnail") or ""
        return thumb if thumb.startswith("http") else None
    wanted = next(
        (r for r in images[0].get("resolutions", []) if r.get("width", 0) >= 640), None
    )
    return (wanted or images[0].get("source") or {}).get("url")


def find_media(d):
    """Retourne (média, type, post_source) ou None.

    type == "video" : vidéo Reddit (v.redd.it), le son est dans un fichier séparé.
    type == "gif"   : boucle muette (gif converti en mp4 par Reddit).
    Les crossposts sont suivis jusqu'au post d'origine.
    """
    candidates = [d] + list((d.get("crosspost_parent_list") or [])[:1])
    for post in candidates:
        container = post.get("secure_media") or post.get("media") or {}
        video = container.get("reddit_video")
        if video and video.get("fallback_url"):
            return video, "video", post

        preview = post.get("preview") or {}
        gif = preview.get("reddit_video_preview")
        if gif and gif.get("fallback_url"):
            return gif, "gif", post

        images = preview.get("images") or []
        mp4 = ((images[0].get("variants") or {}).get("mp4") or {}).get("source") if images else None
        if mp4 and mp4.get("url"):
            return {"fallback_url": mp4["url"], "width": mp4.get("width"), "height": mp4.get("height")}, "gif", post
    return None


def to_item(d):
    found = find_media(d)
    if not found:
        return None
    media, kind, owner = found
    src = media.get("fallback_url") or ""
    if not src.startswith("https://"):
        return None

    audio_id = None
    if kind == "video" and media.get("has_audio", True):
        m = re.search(r"v\.redd\.it/([a-z0-9]+)/", src)
        audio_id = m.group(1) if m else None

    return {
        "id": d.get("name"),
        "title": d.get("title", ""),
        "sub": d.get("subreddit", ""),
        "author": d.get("author", "[supprimé]"),
        "score": d.get("score", 0),
        "comments": d.get("num_comments", 0),
        "created": int(d.get("created_utc") or 0),
        "permalink": "https://www.reddit.com" + d.get("permalink", ""),
        "nsfw": bool(d.get("over_18")),
        "kind": kind,
        "src": src,
        "audio_id": audio_id,
        "poster": _poster(owner) or _poster(d),
        "width": media.get("width"),
        "height": media.get("height"),
        "duration": media.get("duration"),
    }


def collect(sub, sort, t, after, nsfw):
    items, hidden_nsfw, cursor, pages = [], 0, after, 0
    while pages < MAX_PAGES and len(items) < TARGET_ITEMS:
        try:
            listing = fetch_page(sub, sort, t, cursor)["data"]
            children = listing["children"]
        except (KeyError, TypeError):
            raise RedditError("Réponse inattendue de Reddit.", 502)
        cursor = listing.get("after")
        pages += 1
        for child in children:
            if child.get("kind") != "t3":
                continue
            item = to_item(child["data"])
            if not item:
                continue
            if item["nsfw"] and not nsfw:
                hidden_nsfw += 1
                continue
            items.append(item)
        if not cursor:
            break
    return {"items": items, "after": cursor, "hidden_nsfw": hidden_nsfw}


# ---------------------------------------------------------------- audio des vidéos Reddit
def find_audio(video_id):
    base = f"https://v.redd.it/{video_id}/"
    try:
        r = http.get(base + "DASHPlaylist.mpd", timeout=8)
        if r.ok:
            root = ET.fromstring(r.content)
            parents = {child: parent for parent in root.iter() for child in parent}
            for rep in root.iter():
                if not rep.tag.endswith("Representation"):
                    continue
                parent = parents.get(rep)
                hint = " ".join(
                    filter(
                        None,
                        [
                            rep.get("mimeType"),
                            parent.get("mimeType") if parent is not None else None,
                            parent.get("contentType") if parent is not None else None,
                        ],
                    )
                )
                if "audio" not in hint:
                    continue
                for el in rep.iter():
                    if el.tag.endswith("BaseURL") and (el.text or "").strip():
                        return base + el.text.strip()
    except (requests.RequestException, ET.ParseError):
        pass

    for name in ("DASH_AUDIO_128.mp4", "DASH_audio.mp4", "DASH_AUDIO_64.mp4"):
        try:
            if http.head(base + name, timeout=6, allow_redirects=True).ok:
                return base + name
        except requests.RequestException:
            continue
    return None


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


@app.get("/api/feed")
def api_feed():
    sub = re.sub(r"^/?r/", "", request.args.get("sub", "").strip(), flags=re.I)
    sort = request.args.get("sort", "hot")
    t = request.args.get("t", "day")
    after = request.args.get("after") or None
    nsfw = request.args.get("nsfw") == "1"

    if not SUB_RE.match(sub):
        return jsonify(error="Nom de subreddit invalide."), 400
    if sort not in SORTS or t not in TIMES:
        return jsonify(error="Paramètres de tri invalides."), 400
    if after and not AFTER_RE.match(after):
        return jsonify(error="Curseur invalide."), 400

    key = (sub.lower(), sort, t, after or "", nsfw)
    cached = feed_cache.get(key)
    if cached is not _MISSING:
        return jsonify(cached)
    try:
        result = collect(sub, sort, t, after, nsfw)
    except RedditError as exc:
        return jsonify(error=exc.message), exc.status
    feed_cache.set(key, result, FEED_TTL)
    return jsonify(result)


@app.get("/api/audio/<video_id>")
def api_audio(video_id):
    if not VIDEO_ID_RE.match(video_id):
        return jsonify(error="Identifiant invalide."), 400
    cached = audio_cache.get(video_id)
    if cached is _MISSING:
        cached = find_audio(video_id)
        audio_cache.set(video_id, cached, 3600 if cached else 600)
    return jsonify(url=cached)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), threaded=True)
