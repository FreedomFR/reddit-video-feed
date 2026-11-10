(() => {
  'use strict';

  /* ================================================================ utilitaires */
  const $ = (sel, root = document) => root.querySelector(sel);
  const feed = $('#feed');
  const panel = $('#panel');
  const scrim = $('#scrim');

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('rvf.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('rvf.' + key, JSON.stringify(value)); } catch { /* ignoré */ }
    },
  };

  const settings = {
    sound: store.get('sound', true),
    autonext: store.get('autonext', false),
    nsfw: store.get('nsfw', false),
  };

  const ICONS = {
    up: '<polyline points="18 15 12 9 6 15"/>',
    down: '<polyline points="6 9 12 15 18 9"/>',
    volumeOn: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    volumeOff: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
  };
  const icon = (name, size = 22) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  /** Création de nœuds DOM sans innerHTML (les titres Reddit ne sont jamais interprétés comme du HTML). */
  function h(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const kid of kids) if (kid) node.append(kid);
    return node;
  }

  const nf = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
  const fmt = (n) => nf.format(n || 0);
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  function ago(ts) {
    if (!ts) return '';
    const diff = Math.round(ts - Date.now() / 1000);
    const abs = Math.abs(diff);
    for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (abs >= secs) return rtf.format(Math.round(diff / secs), unit);
    }
    return "à l'instant";
  }

  let toastTimer = 0;
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* on tente le plan B */ }
    // Plan B : l'appli est souvent ouverte en http://IP-locale, où l'API clipboard n'existe pas.
    const area = h('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignoré */ }
    area.remove();
    return ok;
  }

  /* ================================================================ état */
  const state = {
    sub: '', sort: 'hot', t: 'day',
    items: [], els: [], seen: new Set(),
    after: null, done: false, loading: false, emptyStreak: 0, hiddenNsfw: 0,
    active: -1, gen: 0, token: 0,
    noAudio: new Set(),
  };

  /* ================================================================ audio (un seul élément partagé) */
  // Les vidéos Reddit ont l'image et le son dans deux fichiers : la vidéo est muette
  // et un <audio> unique, resynchronisé en continu, porte le son.
  const audio = new Audio();
  audio.preload = 'auto';
  let audioFor = -1;
  let gestured = false;
  let swallowTap = false;
  const audioUrls = new Map();

  function audioUrl(id) {
    if (!audioUrls.has(id)) {
      audioUrls.set(id, fetch('/api/audio/' + id)
        .then((r) => r.json())
        .then((j) => j.url || null)
        .catch(() => null));
    }
    return audioUrls.get(id);
  }

  function applySound() { audio.muted = !(settings.sound && gestured); }
  function tryPlayAudio() { const p = audio.play(); if (p) p.catch(() => {}); }

  function syncAudio() {
    if (audioFor !== state.active) return;
    const video = state.els[state.active]?.video;
    if (!video) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.3) audio.currentTime = video.currentTime;
    if (!video.paused && audio.paused) tryPlayAudio();
  }

  async function setupAudio(index, token) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audioFor = -1;
    updateRail();

    const item = state.items[index];
    const next = state.items[index + 1];
    if (next?.audio_id) audioUrl(next.audio_id); // réchauffe le cache serveur

    if (!item?.audio_id) return;
    const url = await audioUrl(item.audio_id);
    if (token !== state.token) return;
    if (!url) { state.noAudio.add(item.id); updateRail(); return; }

    applySound();
    audio.src = url;
    audioFor = index;
    const video = state.els[index]?.video;
    if (video && !video.paused) tryPlayAudio();
  }

  function onGesture() {
    if (gestured) return;
    gestured = true;
    swallowTap = true;
    setTimeout(() => { swallowTap = false; }, 400);
    $('#hint').hidden = true;
    applySound();
    if (audioFor === state.active) syncAudio();
    else if (audio.src) tryPlayAudio();
  }
  for (const type of ['click', 'keydown', 'touchend', 'pointerup']) {
    window.addEventListener(type, onGesture, { capture: true });
  }

  function toggleSound() {
    settings.sound = !settings.sound;
    store.set('sound', settings.sound);
    $('#opt-sound').checked = settings.sound;
    applySound();
    updateRail();
    if (settings.sound && state.noAudio.has(state.items[state.active]?.id)) toast('Pas de son sur cette vidéo');
  }

  /* ================================================================ une vidéo du flux */
  function buildItem(item, index) {
    const bg = h('div', { class: 'bg' });
    const stage = h('div', { class: 'stage' });
    if (item.poster) stage.append(h('img', { class: 'poster', alt: '', loading: 'lazy', decoding: 'async', src: item.poster }));

    const bar = h('i');
    const prog = h('div', { class: 'prog' }, bar);
    makeSeekable(prog, index);

    const bigplay = h('div', { class: 'bigplay' });
    bigplay.innerHTML = icon('play', 38);

    const title = h('p', { class: 'title', text: item.title, onclick: (e) => e.currentTarget.classList.toggle('open') });
    const meta = h('div', { class: 'meta' },
      h('div', { class: 'byline' },
        h('button', { class: 'chip-link', type: 'button', onclick: () => start(item.sub, state.sort, state.t) }, 'r/' + item.sub),
        h('span', { class: 'dim', text: ` · u/${item.author} · ${ago(item.created)}` })),
      title,
      h('div', { class: 'stats', text: `▲ ${fmt(item.score)}    💬 ${fmt(item.comments)}${item.nsfw ? '    NSFW' : ''}` }));

    const fail = h('div', { class: 'failmsg' },
      h('p', { text: 'Cette vidéo ne se charge pas.' }),
      h('a', { href: item.permalink, target: '_blank', rel: 'noopener noreferrer', text: 'Ouvrir sur Reddit' }));

    const root = h('section', { class: 'item', 'data-i': index }, bg, stage, h('div', { class: 'shade' }), meta,
      h('div', { class: 'spinner' }), bigplay, fail, prog);
    const rec = { root, bg, stage, bar, video: null, userPaused: false };
    stage.addEventListener('click', () => onStageTap(index));
    return rec;
  }

  function onStageTap(index) {
    if (swallowTap) { swallowTap = false; return; } // le 1er clic sert seulement à débloquer le son
    if (index === state.active) togglePause();
  }

  function togglePause() {
    const rec = state.els[state.active];
    if (!rec?.video) return;
    if (rec.video.paused) rec.video.play().catch(() => {});
    else { rec.userPaused = true; rec.video.pause(); }
  }

  function makeSeekable(prog, index) {
    let dragging = false;
    const seek = (e) => {
      const video = state.els[index]?.video;
      if (!video || !video.duration) return;
      const rect = prog.getBoundingClientRect();
      video.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * video.duration;
    };
    prog.addEventListener('pointerdown', (e) => { dragging = true; prog.setPointerCapture(e.pointerId); seek(e); });
    prog.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    for (const type of ['pointerup', 'pointercancel']) prog.addEventListener(type, () => { dragging = false; });
  }

  function mount(index, eager) {
    const item = state.items[index];
    const rec = state.els[index];
    if (!item || !rec || rec.video) return;

    const video = document.createElement('video');
    video.muted = true; // le son vient de l'élément <audio>
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.loop = !settings.autonext;
    video.preload = eager ? 'auto' : 'metadata';
    video.src = item.src;

    const isActive = () => index === state.active;
    video.addEventListener('error', () => rec.root.classList.add('failed'));
    video.addEventListener('waiting', () => { rec.root.classList.add('buffering'); if (isActive()) audio.pause(); });
    video.addEventListener('playing', () => { rec.root.classList.remove('buffering', 'paused'); if (isActive()) syncAudio(); });
    video.addEventListener('play', () => { rec.userPaused = false; rec.root.classList.remove('paused'); if (isActive()) syncAudio(); });
    video.addEventListener('pause', () => {
      if (!isActive()) return;
      audio.pause();
      if (rec.userPaused) rec.root.classList.add('paused');
    });
    video.addEventListener('seeked', () => { if (isActive()) syncAudio(); });
    video.addEventListener('timeupdate', () => { if (isActive()) syncAudio(); });
    video.addEventListener('ended', () => { if (settings.autonext && isActive()) go(index + 1); });

    rec.stage.append(video);
    rec.video = video;
    if (item.poster) rec.bg.style.backgroundImage = `url("${item.poster.replace(/"/g, '%22')}")`;
  }

  function unmount(index) {
    const rec = state.els[index];
    if (!rec?.video) return;
    rec.video.pause();
    rec.video.removeAttribute('src');
    rec.video.load();
    rec.video.remove();
    rec.video = null;
    rec.bg.style.backgroundImage = '';
    rec.root.classList.remove('buffering', 'paused', 'failed');
  }

  function activate(index) {
    if (index === state.active || !state.els[index]) return;
    const previous = state.active;
    state.active = index;
    const token = ++state.token;

    state.els.forEach((_, j) => { if (Math.abs(j - index) > 1) unmount(j); });
    mount(index, true);
    mount(index + 1, false);
    mount(index - 1, false);

    state.els.forEach((rec, j) => {
      if (j === index) return;
      rec.video?.pause();
      rec.userPaused = false;
      rec.root.classList.remove('paused');
    });
    if (previous >= 0) audio.pause();

    const rec = state.els[index];
    rec.video.preload = 'auto';
    try { rec.video.currentTime = 0; } catch { /* métadonnées pas encore là */ }
    rec.video.play().catch(() => {});
    setupAudio(index, token);

    if (index >= state.items.length - 4) loadMore();
  }

  function go(index) {
    if (!state.els.length) return;
    const target = state.els[Math.max(0, Math.min(state.els.length - 1, index))];
    target.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================================================================ fin de flux / chargement */
  const tail = (() => {
    const msg = h('p', { class: 'tmsg' });
    const retry = h('button', { type: 'button', text: 'Réessayer', onclick: () => loadMore() });
    const top = h('button', { type: 'button', text: 'Revenir au début', onclick: () => feed.scrollTo({ top: 0, behavior: 'smooth' }) });
    const change = h('button', { type: 'button', text: 'Changer de subreddit', onclick: () => openPanel() });
    const root = h('section', { class: 'item tail', 'data-state': 'loading' },
      h('div', {}, h('div', { class: 'spinner' }), msg, h('div', { class: 'tbtns' }, retry, top, change)));
    return { root, msg, retry, top };
  })();

  function setTail(mode, text = '') {
    tail.root.dataset.state = mode;
    tail.msg.textContent = text;
    tail.retry.hidden = mode !== 'error';
    tail.top.hidden = !(mode === 'done' && state.items.length);
  }

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { root: feed, threshold: 0.3 }).observe(tail.root);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(Number(e.target.dataset.i));
  }, { root: feed, threshold: [0.6] });

  function append(newItems) {
    const start0 = state.items.length;
    // Si l'écran est sur le pied de page (premier chargement, ou fin atteinte pendant le chargement),
    // le navigateur resterait collé dessus : on se replace sur la première nouvelle vidéo.
    const onTail = tail.root.getBoundingClientRect().top < feed.clientHeight / 2;
    const frag = document.createDocumentFragment();
    newItems.forEach((item, k) => {
      const rec = buildItem(item, start0 + k);
      state.items.push(item);
      state.els.push(rec);
      frag.append(rec.root);
      io.observe(rec.root);
    });
    feed.insertBefore(frag, tail.root);
    if (onTail) state.els[start0].root.scrollIntoView({ block: 'start', behavior: 'instant' });
    if (state.active >= 0) mount(state.active + 1, false);
  }

  async function loadMore() {
    if (state.loading || state.done) return;
    state.loading = true;
    setTail('loading');
    const gen = state.gen;
    try {
      const query = new URLSearchParams({ sub: state.sub, sort: state.sort, t: state.t, nsfw: settings.nsfw ? '1' : '0' });
      if (state.after) query.set('after', state.after);
      const res = await fetch('/api/feed?' + query);
      const data = await res.json().catch(() => ({ error: 'Réponse invalide du serveur.' }));
      if (gen !== state.gen) return;
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

      state.after = data.after;
      state.done = !data.after;
      state.hiddenNsfw += data.hidden_nsfw || 0;

      const fresh = data.items.filter((it) => !state.seen.has(it.id));
      fresh.forEach((it) => state.seen.add(it.id));
      if (fresh.length) { state.emptyStreak = 0; append(fresh); } else { state.emptyStreak += 1; }

      state.loading = false;
      if (!fresh.length && !state.done && state.emptyStreak < 3) return loadMore();
      if (!fresh.length && !state.done) state.done = true; // 3 pages vides d'affilée : on s'arrête
      if (state.done) {
        const empty = !state.items.length;
        let text = empty ? `Aucune vidéo trouvée dans r/${state.sub}.` : `Fin de r/${state.sub}.`;
        if (empty && state.hiddenNsfw) text += ` ${state.hiddenNsfw} vidéo(s) NSFW masquée(s) : active-les dans les réglages.`;
        setTail('done', text);
      }
    } catch (err) {
      if (gen !== state.gen) return;
      setTail('error', err.message);
    } finally {
      if (gen === state.gen) state.loading = false;
    }
  }

  /* ================================================================ navigation entre subreddits */
  function resetFeed() {
    state.gen += 1;
    state.token += 1;
    state.els.forEach((rec, i) => { io.unobserve(rec.root); unmount(i); });
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audioFor = -1;
    Object.assign(state, { items: [], els: [], seen: new Set(), after: null, done: false, loading: false, emptyStreak: 0, hiddenNsfw: 0, active: -1 });
    state.noAudio.clear();
    feed.replaceChildren(tail.root);
    feed.scrollTop = 0;
    updateRail();
  }

  function start(sub, sort, t) {
    state.sub = sub; state.sort = sort; state.t = t;
    store.set('sub', sub); store.set('sort', sort); store.set('t', t);
    const recents = [sub, ...store.get('recents', []).filter((s) => s.toLowerCase() !== sub.toLowerCase())].slice(0, 8);
    store.set('recents', recents);

    const params = new URLSearchParams({ r: sub, s: sort });
    if (sort === 'top') params.set('t', t);
    history.replaceState(null, '', '?' + params);

    $('#pill-sub').textContent = 'r/' + sub;
    $('#pill-sort').textContent = sort === 'top' ? `Top · ${$('#t option[value="' + t + '"]').textContent.toLowerCase()}` : $(`#sort-seg [data-v="${sort}"]`).textContent;
    document.title = `r/${sub} · Reddit Video Feed`;
    resetFeed();
    loadMore();
  }

  /* ================================================================ barre d'actions */
  function updateRail() {
    const item = state.items[state.active];
    const noAudio = !item || !item.audio_id || state.noAudio.has(item.id);
    const on = settings.sound && !noAudio;
    $('#btn-sound').innerHTML = icon(on ? 'volumeOn' : 'volumeOff');
    $('#btn-sound').classList.toggle('dim', noAudio);
    const open = $('#btn-open');
    if (item) open.href = item.permalink; else open.removeAttribute('href');
  }

  for (const node of document.querySelectorAll('[data-icon]')) node.innerHTML = icon(node.dataset.icon);
  $('#btn-sound').addEventListener('click', toggleSound);
  $('#btn-prev').addEventListener('click', () => go(state.active - 1));
  $('#btn-next').addEventListener('click', () => go(state.active + 1));
  $('#btn-copy').addEventListener('click', async () => {
    const item = state.items[state.active];
    if (item) toast((await copyText(item.permalink)) ? 'Lien copié' : 'Copie impossible');
  });
  function openCurrent() {
    const item = state.items[state.active];
    if (item) window.open(item.permalink, '_blank', 'noopener');
  }

  /* ================================================================ panneau (subreddit + réglages) */
  const subInput = $('#sub');
  let draftSort = 'hot';

  function setDraftSort(value) {
    draftSort = value;
    for (const btn of document.querySelectorAll('#sort-seg button')) btn.setAttribute('aria-checked', String(btn.dataset.v === value));
    $('#t-field').hidden = value !== 'top';
  }

  function renderRecents() {
    const box = $('#recents');
    const recents = store.get('recents', []);
    box.replaceChildren(...recents.map((s) => h('button', { type: 'button', text: 'r/' + s, onclick: () => { start(s, draftSort, $('#t').value); closePanel(); } })));
    box.hidden = !recents.length;
  }

  function openPanel() {
    subInput.value = state.sub;
    setDraftSort(state.sort);
    $('#t').value = state.t;
    $('#opt-sound').checked = settings.sound;
    $('#opt-next').checked = settings.autonext;
    $('#opt-nsfw').checked = settings.nsfw;
    renderRecents();
    panel.hidden = false;
    scrim.hidden = false;
    $('#pill').setAttribute('aria-expanded', 'true');
    subInput.focus();
    subInput.select();
  }

  function closePanel() {
    if (panel.hidden) return;
    panel.hidden = true;
    scrim.hidden = true;
    $('#pill').setAttribute('aria-expanded', 'false');
    feed.focus({ preventScroll: true });
  }

  $('#pill').addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  scrim.addEventListener('click', closePanel);
  $('#sort-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setDraftSort(b.dataset.v); });
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const sub = subInput.value.trim().replace(/^\/?r\//i, '').replace(/[\s,]+/g, '+').replace(/^\++|\++$/g, '');
    if (!sub) return;
    start(sub, draftSort, $('#t').value);
    closePanel();
  });

  $('#opt-sound').addEventListener('change', (e) => { if (e.target.checked !== settings.sound) toggleSound(); });
  $('#opt-next').addEventListener('change', (e) => {
    settings.autonext = e.target.checked;
    store.set('autonext', settings.autonext);
    state.els.forEach((rec) => { if (rec.video) rec.video.loop = !settings.autonext; });
  });
  $('#opt-nsfw').addEventListener('change', (e) => {
    settings.nsfw = e.target.checked;
    store.set('nsfw', settings.nsfw);
    start(state.sub, state.sort, state.t);
    closePanel();
  });

  /* ================================================================ clavier, visibilité, progression */
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { closePanel(); return; }
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !panel.hidden) return;
    switch (e.key) {
      case 'ArrowDown': case 'PageDown': case 'j':
        e.preventDefault(); if (!e.repeat) go(state.active + 1); break;
      case 'ArrowUp': case 'PageUp': case 'k':
        e.preventDefault(); if (!e.repeat) go(state.active - 1); break;
      case ' ': case 'p': e.preventDefault(); togglePause(); break;
      case 'm': toggleSound(); break;
      case 'o': openCurrent(); break;
      case '/': e.preventDefault(); openPanel(); break;
      default:
    }
  });

  let resumeAfterHidden = false;
  document.addEventListener('visibilitychange', () => {
    const video = state.els[state.active]?.video;
    if (!video) return;
    if (document.hidden) { resumeAfterHidden = !video.paused; video.pause(); }
    else if (resumeAfterHidden) video.play().catch(() => {});
  });

  (function tick() {
    const video = state.els[state.active]?.video;
    if (video && video.duration) state.els[state.active].bar.style.transform = `scaleX(${video.currentTime / video.duration})`;
    requestAnimationFrame(tick);
  })();

  /* ================================================================ démarrage */
  $('#opt-sound').checked = settings.sound;
  $('#opt-next').checked = settings.autonext;
  $('#opt-nsfw').checked = settings.nsfw;
  if (settings.sound) $('#hint').hidden = false;
  applySound();
  updateRail();

  const params = new URLSearchParams(location.search);
  const clean = (s) => String(s || '').replace(/^\/?r\//i, '').replace(/[\s,]+/g, '+');
  const initSort = params.get('s') || store.get('sort', 'hot');
  start(
    clean(params.get('r') || store.get('sub', 'videos')),
    ['hot', 'new', 'top', 'rising'].includes(initSort) ? initSort : 'hot',
    params.get('t') || store.get('t', 'day'),
  );
})();
