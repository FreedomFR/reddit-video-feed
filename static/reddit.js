/* Mode « direct » : le navigateur interroge Reddit lui-même, sans le serveur Flask.
 *
 * Sert quand l'interface est hébergée en statique (GitHub Pages). Le JSON anonyme de Reddit
 * refuse le CORS, mais l'API officielle (oauth.reddit.com) l'accepte : on y accède avec un jeton
 * « application seule » obtenu à partir de l'identifiant d'une app Reddit de type « installed app »
 * (identifiant public par conception, pas de secret). Même logique que app.py.
 */
window.RedditDirect = (() => {
  'use strict';

  const TARGET_ITEMS = 10;
  const MAX_PAGES = 5;
  const SUB_RE = /^[A-Za-z0-9_]{2,21}(\+[A-Za-z0-9_]{2,21}){0,24}$/;
  const SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial']);
  const TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
  const KEY = 'rvf.clientId';

  class RedditError extends Error {}

  const clientId = {
    get() { try { return (localStorage.getItem(KEY) || '').trim(); } catch { return ''; } },
    set(value) {
      token = { value: null, expires: 0 };
      try { value ? localStorage.setItem(KEY, value.trim()) : localStorage.removeItem(KEY); } catch { /* ignoré */ }
    },
  };

  // Identifiant d'appareil aléatoire, exigé par le type de jeton « installed_client ».
  function deviceId() {
    try {
      let id = localStorage.getItem('rvf.deviceId');
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('rvf.deviceId', id);
      }
      return id;
    } catch { return 'DO_NOT_TRACK_THIS_DEVICE'; }
  }

  /* ---------------------------------------------------------------- jeton OAuth */
  let token = { value: null, expires: 0 };
  let pendingToken = null;

  async function getToken() {
    const id = clientId.get();
    if (!id) {
      throw new RedditError("Renseigne l'identifiant de ton app Reddit dans les réglages (voir le README).");
    }
    if (token.value && Date.now() < token.expires - 60000) return token.value;
    if (!pendingToken) {
      pendingToken = (async () => {
        let res;
        try {
          res = await fetch('https://www.reddit.com/api/v1/access_token', {
            method: 'POST',
            headers: { Authorization: 'Basic ' + btoa(id + ':') },
            body: new URLSearchParams({
              grant_type: 'https://oauth.reddit.com/grants/installed_client',
              device_id: deviceId(),
            }),
          });
        } catch {
          throw new RedditError('Connexion à Reddit impossible (réseau).');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
          throw new RedditError(
            `Reddit refuse l'identifiant d'app (${data.error || 'HTTP ' + res.status}). ` +
            "Vérifie qu'il s'agit d'une app de type « installed app ».",
          );
        }
        token = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
        return token.value;
      })().finally(() => { pendingToken = null; });
    }
    return pendingToken;
  }

  /* ---------------------------------------------------------------- lecture de Reddit */
  async function fetchPage(sub, sort, t, after, retried = false) {
    const params = new URLSearchParams({ raw_json: '1', limit: '100' });
    if (after) params.set('after', after);
    if (sort === 'top' || sort === 'controversial') params.set('t', t);

    const bearer = await getToken();
    let res;
    try {
      res = await fetch(`https://oauth.reddit.com/r/${sub}/${sort}?${params}`, {
        headers: { Authorization: 'bearer ' + bearer },
      });
    } catch {
      // Un sub inexistant redirige vers la recherche, sans en-têtes CORS : le fetch échoue.
      throw new RedditError('Subreddit introuvable, ou Reddit injoignable.');
    }
    if (res.status === 401 && !retried) {
      token = { value: null, expires: 0 };
      return fetchPage(sub, sort, t, after, true);
    }
    if (res.ok) {
      if (res.url.includes('/subreddits/search')) throw new RedditError('Subreddit introuvable.');
      const data = await res.json().catch(() => null);
      if (data) return data;
      throw new RedditError('Réponse non JSON de Reddit.');
    }
    if (res.status === 404) throw new RedditError('Subreddit introuvable.');
    if (res.status === 429) throw new RedditError('Reddit limite temporairement les requêtes (429). Réessaie dans une minute.');
    if (res.status === 403) {
      const reason = (await res.json().catch(() => ({}))).reason || '';
      if (['private', 'banned', 'quarantined', 'gated'].includes(reason)) {
        throw new RedditError(`Subreddit inaccessible (${reason}).`);
      }
    }
    throw new RedditError(`Reddit a refusé la requête (HTTP ${res.status}).`);
  }

  function poster(d) {
    const images = d.preview?.images || [];
    if (!images.length) {
      const thumb = d.thumbnail || '';
      return thumb.startsWith('http') ? thumb : null;
    }
    const wanted = (images[0].resolutions || []).find((r) => (r.width || 0) >= 640);
    return (wanted || images[0].source || {}).url || null;
  }

  function findMedia(d) {
    const candidates = [d, ...(d.crosspost_parent_list || []).slice(0, 1)];
    for (const post of candidates) {
      const container = post.secure_media || post.media || {};
      const video = container.reddit_video;
      if (video?.fallback_url) return [video, 'video', post];

      const preview = post.preview || {};
      const gif = preview.reddit_video_preview;
      if (gif?.fallback_url) return [gif, 'gif', post];

      const mp4 = preview.images?.[0]?.variants?.mp4?.source;
      if (mp4?.url) return [{ fallback_url: mp4.url, width: mp4.width, height: mp4.height }, 'gif', post];
    }
    return null;
  }

  function toItem(d) {
    const found = findMedia(d);
    if (!found) return null;
    const [media, kind, owner] = found;
    const src = media.fallback_url || '';
    if (!src.startsWith('https://')) return null;

    let audioId = null;
    if (kind === 'video' && media.has_audio !== false) {
      const m = /v\.redd\.it\/([a-z0-9]+)\//.exec(src);
      audioId = m ? m[1] : null;
    }
    return {
      id: d.name,
      title: d.title || '',
      sub: d.subreddit || '',
      author: d.author || '[supprimé]',
      score: d.score || 0,
      comments: d.num_comments || 0,
      created: Math.trunc(d.created_utc || 0),
      permalink: 'https://www.reddit.com' + (d.permalink || ''),
      nsfw: Boolean(d.over_18),
      kind,
      src,
      audio_id: audioId,
      poster: poster(owner) || poster(d),
      width: media.width,
      height: media.height,
      duration: media.duration,
    };
  }

  async function feed({ sub, sort, t, after, nsfw }) {
    sub = String(sub || '').trim().replace(/^\/?r\//i, '');
    if (!SUB_RE.test(sub)) throw new RedditError('Nom de subreddit invalide.');
    if (!SORTS.has(sort) || !TIMES.has(t)) throw new RedditError('Paramètres de tri invalides.');

    const items = [];
    let hiddenNsfw = 0;
    let cursor = after || null;
    let pages = 0;
    while (pages < MAX_PAGES && items.length < TARGET_ITEMS) {
      const listing = (await fetchPage(sub, sort, t, cursor))?.data;
      if (!listing || !Array.isArray(listing.children)) throw new RedditError('Réponse inattendue de Reddit.');
      cursor = listing.after || null;
      pages += 1;
      for (const child of listing.children) {
        if (child.kind !== 't3') continue;
        const item = toItem(child.data);
        if (!item) continue;
        if (item.nsfw && !nsfw) { hiddenNsfw += 1; continue; }
        items.push(item);
      }
      if (!cursor) break;
    }
    return { items, after: cursor, hidden_nsfw: hiddenNsfw };
  }

  /* ---------------------------------------------------------------- audio des vidéos Reddit */
  async function audio(videoId) {
    if (!/^[a-z0-9]{6,20}$/.test(videoId)) return null;
    const base = `https://v.redd.it/${videoId}/`;
    try {
      const res = await fetch(base + 'DASHPlaylist.mpd');
      if (res.ok) {
        const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
        for (const rep of doc.getElementsByTagNameNS('*', 'Representation')) {
          const parent = rep.parentElement;
          const hint = [rep.getAttribute('mimeType'), parent?.getAttribute('mimeType'), parent?.getAttribute('contentType')].join(' ');
          if (!hint.includes('audio')) continue;
          const baseUrl = rep.getElementsByTagNameNS('*', 'BaseURL')[0]?.textContent.trim();
          if (baseUrl) return base + baseUrl;
        }
      }
    } catch { /* on tente les noms habituels */ }

    for (const name of ['DASH_AUDIO_128.mp4', 'DASH_audio.mp4', 'DASH_AUDIO_64.mp4']) {
      try {
        if ((await fetch(base + name, { method: 'HEAD' })).ok) return base + name;
      } catch { /* suivant */ }
    }
    return null;
  }

  return { feed, audio, clientId };
})();
