// AdTok : feed vertical de pubs Meta (Ad Library via Apify), likes, algo, dossier d'ads enregistrées.
(() => {
  const ACTOR = 'automly~facebook-ad-library-scraper';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const S = {
    get token() { return Store.get('token', ''); },
    get country() { return Store.get('country', 'FR'); },
    get media() { return Store.get('media', 'video'); },
    get interests() { return Store.get('interests', null); },
    get muted() { return Store.get('muted', true); },
  };

  // ======================================================================
  // Récupération des ads
  // ======================================================================
  function pickMedia(raw) {
    const out = [], seen = new Set();
    const add = (m) => { if (m.url && !seen.has(m.url)) { seen.add(m.url); out.push(m); } };
    for (const v of raw.videos || []) add({ type: 'video', url: v.hdUrl || v.sdUrl, sd: v.sdUrl, poster: v.previewImageUrl });
    for (const c of raw.cards || []) {
      if (c.videoHdUrl || c.videoSdUrl) add({ type: 'video', url: c.videoHdUrl || c.videoSdUrl, sd: c.videoSdUrl, poster: c.videoPreviewImageUrl });
      else if (c.imageUrl) add({ type: 'image', url: c.imageUrl });
    }
    for (const u of raw.imageUrls || []) add({ type: 'image', url: u });
    if (!out.length && raw.thumbnailUrl) add({ type: 'image', url: raw.thumbnailUrl });
    return out.slice(0, 6);
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h.toString(36); }

  function normalize(raw, queryKey) {
    const media = pickMedia(raw);
    if (!media.length || !raw.adArchiveId) return null;
    return {
      id: String(raw.adArchiveId),
      dedup: raw.collationId ? 'c' + raw.collationId : 'b' + raw.pageId + hash((raw.bodyText || '') + (raw.headline || '')),
      pageId: raw.pageId, pageName: raw.pageName || 'Annonceur', pageUrl: raw.pageUrl,
      avatar: raw.pageProfilePictureUrl, pageCategory: raw.pageCategory || '',
      bodyText: raw.bodyText || '', headline: raw.headline || '', linkDescription: raw.linkDescription || '',
      linkUrl: raw.linkUrl || '', linkDomain: raw.linkDomain || '', ctaText: raw.ctaText || '',
      activeDays: raw.activeDays || 0, versionCount: raw.versionCount || 1, startDate: raw.startDate,
      isActive: raw.isActive, platforms: raw.platforms || [], adLibraryUrl: raw.adLibraryUrl ||
        `https://www.facebook.com/ads/library/?id=${raw.adArchiveId}`,
      mediaType: media[0].type, media, searchTerm: queryKey, fetchedAt: Date.now(),
    };
  }

  let fetching = null;
  async function fetchBatch(forced) {
    if (fetching) return fetching;
    fetching = (async () => {
      const interests = S.interests || Algo.DEFAULT_INTERESTS;
      const q = forced || Algo.nextQuery(interests);
      const key = q.type === 'page' ? 'page:' + q.value : q.value;
      const input = { country: S.country, mediaType: S.media, activeStatus: 'active', outputFormat: 'clean', maxAds: 24 };
      if (q.type === 'page') {
        const c = S.country === 'ALL' ? 'ALL' : S.country;
        input.urls = [{ url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${c}&view_all_page_id=${q.value}&media_type=${S.media}` }];
      } else {
        input.searchTerms = [q.value];
        input.searchType = 'keyword_unordered';
      }
      Algo.markQuery(key);
      try {
        const items = await apify(input);
        const seenIds = new Set(await DB.keys('seen'));
        const poolIds = new Set(await DB.keys('pool'));
        const fresh = [];
        for (const raw of items) {
          const ad = normalize(raw, key);
          if (!ad || seenIds.has(ad.id) || seenIds.has(ad.dedup) || poolIds.has(ad.id)) continue;
          seenIds.add(ad.dedup);
          fresh.push(ad);
        }
        await DB.putMany('pool', fresh);
        return { query: key, count: fresh.length };
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  async function apify(input) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    try {
      const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?format=json&clean=1`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
        body: JSON.stringify(input),
      });
      if (res.status === 401 || res.status === 403) throw new Error('Token Apify refusé : vérifie-le dans Réglages.');
      if (res.status === 402) throw new Error('Plus de crédit Apify sur ton compte.');
      if (!res.ok) throw new Error('Apify a répondu ' + res.status);
      Store.set('runs', Store.get('runs', 0) + 1);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // Les liens vidéo Facebook expirent après quelques jours : on redemande des liens neufs pour une ad du dossier.
  async function refreshAd(ad) {
    const items = await apify({ urls: [{ url: ad.adLibraryUrl }], maxAds: 1, outputFormat: 'clean' });
    const raw = items.find(i => String(i.adArchiveId) === ad.id) || items[0];
    const fresh = raw && normalize(raw, ad.searchTerm);
    if (!fresh) throw new Error("Cette ad n'est plus disponible dans la Ad Library");
    for (const store of ['saved', 'liked']) {
      const cur = await DB.get(store, ad.id);
      if (cur) await DB.put(store, { ...cur, media: fresh.media, avatar: fresh.avatar, activeDays: fresh.activeDays,
        versionCount: fresh.versionCount, isActive: fresh.isActive, fetchedAt: Date.now() });
    }
    ad.media = fresh.media; ad.avatar = fresh.avatar; ad.fetchedAt = Date.now();
    return ad;
  }

  // Prend les meilleures ads du stock selon le profil ACTUEL (l'algo s'adapte en direct)
  async function takeFromPool(n) {
    const pool = await DB.all('pool');
    const now = Date.now();
    const fresh = [], stale = [];
    // les liens vidéo Facebook expirent après quelques jours : on jette le stock trop vieux
    for (const ad of pool) (now - ad.fetchedAt > 1000 * 60 * 60 * 48 ? stale : fresh).push(ad);
    for (const ad of stale) DB.del('pool', ad.id);
    fresh.forEach(ad => ad._s = Algo.score(ad));
    fresh.sort((a, b) => b._s - a._s);
    // diversité : pas plus de 2 ads du même annonceur d'affilée dans un lot
    const picked = [], perPage = {};
    for (const ad of fresh) {
      if (picked.length >= n) break;
      if ((perPage[ad.pageId] || 0) >= 2) continue;
      perPage[ad.pageId] = (perPage[ad.pageId] || 0) + 1;
      picked.push(ad);
    }
    for (const ad of picked) DB.del('pool', ad.id);
    return { picked, remaining: fresh.length - picked.length };
  }

  // ======================================================================
  // Feed
  // ======================================================================
  const feedEl = $('#feed');
  const statusEl = $('#feed-status');
  let feedAds = [];
  let filling = false;
  let likedIds = new Set(), savedIds = new Set();

  function showStatus(html) { statusEl.innerHTML = html; statusEl.classList.remove('hidden'); }
  function hideStatus() { statusEl.classList.add('hidden'); }

  async function refill() {
    if (filling) return;
    filling = true;
    try {
      let { picked, remaining } = await takeFromPool(6);
      let tries = 0;
      while (picked.length < 3 && tries < 4) {
        if (!feedAds.length) showStatus(`<div class="spinner"></div><div>Je cherche des ads pour toi…</div>`);
        tries++;
        try { await fetchBatch(); } catch (e) {
          if (!feedAds.length) showStatus(`<div>⚠️ ${esc(e.message)}</div><button class="primary" id="retry">Réessayer</button>`);
          $('#retry') && ($('#retry').onclick = () => refill());
          return;
        }
        ({ picked, remaining } = await takeFromPool(6));
      }
      hideStatus();
      picked.forEach(addSlide);
      if (!feedAds.length) showStatus(`<div>Aucune ad trouvée. Ajoute d'autres centres d'intérêt dans Réglages.</div>`);
      // on garde toujours un stock d'avance, récupéré en arrière-plan
      if (remaining < 10) fetchBatch().catch(() => {});
    } finally { filling = false; }
  }

  const ICON = {
    heart: '<svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M12 21s-7.5-4.6-10-9.3C.3 8.3 2.2 4 6.3 4c2.3 0 3.9 1.3 5.7 3.3C13.8 5.3 15.4 4 17.7 4 21.8 4 23.7 8.3 22 11.7 19.5 16.4 12 21 12 21z"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M6 2.5h12a1.5 1.5 0 0 1 1.5 1.5v18l-7.5-5-7.5 5V4A1.5 1.5 0 0 1 6 2.5z"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 10.5v6M12 7.2v.1" stroke="#000" stroke-width="2.4" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M13 3l9 8.5-9 8.5v-5.2C7 14.6 3.6 16.6 1.5 21 2.3 14 5.5 9 13 8.3V3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M9 2h6l1 2h5v2H3V4h5l1-2zM5 8h14l-1.2 13.2A2 2 0 0 1 15.8 23H8.2a2 2 0 0 1-2-1.8L5 8z"/></svg>',
  };

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDays(d) { return d >= 365 ? Math.floor(d / 365) + ' an' + (d >= 730 ? 's' : '') : d + ' j'; }

  function slideHTML(ad, opts = {}) {
    const liked = likedIds.has(ad.id), saved = savedIds.has(ad.id);
    const hot = ad.activeDays >= 30;
    const badges = [
      `<span class="badge ${hot ? 'hot' : ''}">${hot ? '🔥 ' : ''}active ${fmtDays(ad.activeDays)}</span>`,
      ad.versionCount > 1 ? `<span class="badge ${ad.versionCount >= 5 ? 'gold' : ''}">${ad.versionCount} versions</span>` : '',
      ad.linkDomain ? `<span class="badge">${esc(ad.linkDomain)}</span>` : '',
    ].join('');
    return `
      <div class="bg"></div>
      <div class="stage"></div>
      ${ad.media.length > 1 ? `<div class="carousel-dots">${ad.media.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
      <div class="shade"></div>
      <div class="info">
        <div class="page">${esc(ad.pageName)}</div>
        <div class="badges">${badges}</div>
        <div class="body">${esc(ad.bodyText || ad.headline)}</div>
        ${ad.ctaText ? `<span class="cta">${esc(ad.ctaText)} ›</span>` : ''}
      </div>
      <div class="actions">
        ${ad.avatar ? `<img class="avatar" src="${esc(ad.avatar)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
        <button class="act like ${liked ? 'on' : ''}" data-act="like">${ICON.heart}<span>J'aime</span></button>
        <button class="act save ${saved ? 'on' : ''}" data-act="save">${ICON.save}<span>${saved ? 'Enregistrée' : 'Enregistrer'}</span></button>
        <button class="act" data-act="info">${ICON.info}<span>Détails</span></button>
        <button class="act" data-act="share">${ICON.share}<span>Partager</span></button>
        ${opts.inViewer ? `<button class="act" data-act="remove">${ICON.trash}<span>Retirer</span></button>` : ''}
      </div>
      <div class="progress"><i></i></div>`;
  }

  function buildSlide(ad, opts = {}) {
    const el = document.createElement('div');
    el.className = 'slide';
    el.dataset.id = ad.id;
    el.innerHTML = slideHTML(ad, opts);
    el._ad = ad;
    el._opts = opts;
    el._mi = 0;
    wireSlide(el);
    return el;
  }

  function addSlide(ad) {
    feedAds.push(ad);
    const el = buildSlide(ad);
    feedEl.appendChild(el);
    observer.observe(el);
    DB.put('seen', { id: ad.id, t: Date.now() });
    DB.put('seen', { id: ad.dedup, t: Date.now() });
  }

  function mediaSrc(el, m) {
    // dans le dossier, on lit la copie locale si elle existe
    const blobs = el._opts.blobs;
    return (blobs && blobs[m.url]) || m.url;
  }

  // Charge le média courant de la slide (on ne garde que les slides proches pour économiser la mémoire)
  function mount(el) {
    if (el._mounted) return;
    el._mounted = true;
    const ad = el._ad, m = ad.media[el._mi];
    const stage = $('.stage', el);
    const poster = m.type === 'video' ? (el._opts.blobs && el._opts.blobs[m.poster]) || m.poster : mediaSrc(el, m);
    if (poster) $('.bg', el).style.backgroundImage = `url("${poster}")`;
    if (m.type === 'video') {
      stage.innerHTML = `<video class="media" playsinline webkit-playsinline loop preload="auto" ${S.muted ? 'muted' : ''}></video>`;
      const v = $('video', stage);
      if (poster) v.poster = poster;
      v.src = mediaSrc(el, m);
      v.muted = S.muted;
      v.addEventListener('error', () => {
        // le lien HD peut échouer : on tente la version SD
        if (m.sd && v.src !== m.sd && !v._triedSd) { v._triedSd = true; v.src = m.sd; if (el._active) v.play().catch(() => {}); return; }
        // lien expiré sur une ad du dossier : on récupère un lien neuf puis on relance
        if (el._opts.inViewer && !el._refreshed) {
          el._refreshed = true;
          toast('Lien expiré, je récupère la vidéo…');
          refreshAd(ad).then(() => { unmount(el); mount(el); if (el._active) play(el); })
            .catch(e => toast(e.message));
        }
      });
      v.addEventListener('timeupdate', () => {
        if (!v.duration) return;
        $('.progress i', el).style.width = (v.currentTime / v.duration * 100) + '%';
        el._maxFrac = Math.max(el._maxFrac || 0, v.currentTime / v.duration);
      });
      v.addEventListener('seeked', () => {});
      v.addEventListener('ended', () => { el._loops = (el._loops || 0) + 1; });
      let lastT = 0;
      v.addEventListener('timeupdate', () => { if (v.currentTime < lastT - 1) el._loops = (el._loops || 0) + 1; lastT = v.currentTime; });
    } else {
      stage.innerHTML = `<img class="media" src="${esc(mediaSrc(el, m))}" alt="">`;
    }
  }
  function unmount(el) {
    if (!el._mounted) return;
    el._mounted = false;
    const v = $('video', el);
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    $('.stage', el).innerHTML = '';
  }
  function showMedia(el, i) {
    const n = el._ad.media.length;
    el._mi = (i + n) % n;
    unmount(el); mount(el);
    $$('.carousel-dots i', el).forEach((d, k) => d.classList.toggle('on', k === el._mi));
    if (el._active) play(el);
  }
  function play(el) {
    const v = $('video', el);
    if (v) { v.muted = S.muted; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
  }

  function wireSlide(el) {
    const ad = el._ad;
    // simple tap = pause/lecture (ou carrousel sur les bords), double tap = like
    let lastTap = 0, tapTimer;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.actions, .info .cta')) return;
      if (e.target.closest('.body')) { e.target.closest('.body').classList.toggle('open'); return; }
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer);
        lastTap = 0;
        heartPop(el, e);
        if (!likedIds.has(ad.id)) toggleLike(el);
        return;
      }
      lastTap = now;
      const x = e.clientX / window.innerWidth;
      tapTimer = setTimeout(() => {
        if (ad.media.length > 1 && (x < 0.22 || x > 0.78)) { showMedia(el, el._mi + (x < 0.5 ? -1 : 1)); return; }
        const v = $('video', el);
        if (v) v.paused ? v.play().catch(() => {}) : v.pause();
      }, 280);
    });
    $('.actions', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'like') toggleLike(el);
      else if (act === 'save') toggleSave(el);
      else if (act === 'info') openDetails(ad, el);
      else if (act === 'share') shareAd(ad);
      else if (act === 'remove') removeFromFolder(el);
    });
    const cta = $('.info .cta', el);
    if (cta) cta.addEventListener('click', () => ad.linkUrl && window.open(ad.linkUrl, '_blank'));
  }

  function heartPop(el, e) {
    const h = document.createElement('div');
    h.className = 'heart-pop'; h.textContent = '❤️';
    const r = el.getBoundingClientRect();
    h.style.left = (e.clientX - r.left) + 'px'; h.style.top = (e.clientY - r.top) + 'px';
    el.appendChild(h);
    setTimeout(() => h.remove(), 800);
  }

  function refreshButtons(id) {
    for (const el of $$(`.slide[data-id="${id}"]`)) {
      const l = $('[data-act="like"]', el), s = $('[data-act="save"]', el);
      const liked = likedIds.has(id), saved = savedIds.has(id);
      l.classList.toggle('on', liked);
      s.classList.toggle('on', saved);
      $('span', s).textContent = saved ? 'Enregistrée' : 'Enregistrer';
    }
  }

  async function toggleLike(el) {
    const ad = el._ad;
    if (likedIds.has(ad.id)) {
      likedIds.delete(ad.id); await DB.del('liked', ad.id); Algo.signal(ad, -3);
    } else {
      likedIds.add(ad.id); await DB.put('liked', { ...strip(ad), likedAt: Date.now() }); Algo.signal(ad, 3);
      if (navigator.vibrate) navigator.vibrate(10);
    }
    refreshButtons(ad.id);
  }

  function strip(ad) { const { _tok, _s, ...rest } = ad; return rest; }

  async function toggleSave(el) {
    const ad = el._ad;
    if (savedIds.has(ad.id)) {
      savedIds.delete(ad.id); await DB.del('saved', ad.id); Algo.signal(ad, -2);
      toast('Retirée du dossier');
    } else {
      savedIds.add(ad.id);
      await DB.put('saved', { ...strip(ad), savedAt: Date.now(), blobs: {} });
      Algo.signal(ad, 5);
      toast('🔖 Enregistrée dans ton dossier');
      cacheMedia(ad); // copie locale des vidéos : elles restent lisibles même quand le lien Facebook expire
    }
    refreshButtons(ad.id);
  }

  async function cacheMedia(ad) {
    // Facebook interdit de copier les vidéos depuis une page web : on garde les images (miniatures, visuels).
    // Les vidéos, elles, sont rafraîchies via la Ad Library quand leur lien expire (voir refreshAd).
    const blobs = {};
    const urls = [];
    for (const m of ad.media) { if (m.type === 'image') urls.push(m.url); if (m.poster) urls.push(m.poster); }
    if (ad.avatar) urls.push(ad.avatar);
    for (const u of urls) {
      try {
        const r = await fetch(u, { mode: 'cors', cache: 'no-store' });
        if (r.ok) blobs[u] = await r.blob();
      } catch {}
    }
    const cur = await DB.get('saved', ad.id);
    if (cur) { cur.blobs = blobs; await DB.put('saved', cur); }
  }

  async function shareAd(ad) {
    const text = `${ad.pageName} — ${ad.adLibraryUrl}`;
    try {
      if (navigator.share) await navigator.share({ title: ad.pageName, text, url: ad.adLibraryUrl });
      else { await navigator.clipboard.writeText(ad.adLibraryUrl); toast('Lien copié'); }
    } catch {}
  }

  // Ouvre le fichier brut dans Safari : bouton Partager → "Enregistrer la vidéo" pour l'avoir dans Photos.
  async function downloadVideo(ad) {
    let m = ad.media.find(x => x.type === 'video') || ad.media[0];
    const w = window.open('about:blank', '_blank');
    if (Date.now() - (ad.fetchedAt || 0) > 1000 * 60 * 60 * 48) {
      try { toast('Je récupère un lien neuf…'); await refreshAd(ad); m = ad.media.find(x => x.type === 'video') || ad.media[0]; }
      catch (e) { toast(e.message); }
    }
    if (w) w.location = m.url; else location.href = m.url;
  }

  // ---------- suivi de visionnage (signal le plus important de l'algo) ----------
  let current = null;
  function leave(el) {
    if (!el || el._opts.inViewer) return;
    const dwell = (Date.now() - (el._enter || Date.now())) / 1000;
    const ad = el._ad;
    const isVideo = !!$('video', el);
    let d = 0;
    if (dwell < 1.5) d = -0.8;                                         // swipe direct
    else if (isVideo && ((el._loops || 0) >= 1 || (el._maxFrac || 0) > 0.9)) d = 1.5;   // regardée en entier
    else if (isVideo && (el._maxFrac || 0) > 0.5) d = 0.6;
    else if (!isVideo && dwell > 6) d = 0.6;
    else if (dwell > 12) d = 0.6;
    if (d) Algo.signal(ad, d);
  }

  // Détecte la slide affichée à partir de la position de défilement (fiable sur iOS, même en arrière-plan).
  function activateFeed() {
    const slides = $$('.slide', feedEl);
    if (!slides.length) return;
    const idx = Math.min(slides.length - 1, Math.max(0, Math.round(feedEl.scrollTop / (feedEl.clientHeight || 1))));
    const el = slides[idx];
    if (current === el) return;
    if (current) { leave(current); current._active = false; const v = $('video', current); if (v) v.pause(); }
    current = el; el._active = true; el._enter = Date.now(); el._maxFrac = 0; el._loops = 0;
    slides.forEach((s, i) => (Math.abs(i - idx) <= 2 ? mount(s) : unmount(s)));
    if ($('#view-feed').classList.contains('active')) play(el);
    if (slides.length - idx <= 4) refill();
  }
  let scrollT;
  feedEl.addEventListener('scroll', () => { clearTimeout(scrollT); scrollT = setTimeout(activateFeed, 90); }, { passive: true });
  const observer = { observe() { if (!current) setTimeout(activateFeed, 0); }, unobserve() {} };

  // son
  const muteBtn = $('#mute-btn');
  function setMuted(m) {
    Store.set('muted', m);
    muteBtn.textContent = m ? '🔇' : '🔊';
    $$('video').forEach(v => v.muted = m);
    if (!m && current) play(current);
  }
  muteBtn.onclick = () => setMuted(!S.muted);
  muteBtn.textContent = S.muted ? '🔇' : '🔊';

  // ======================================================================
  // Détails
  // ======================================================================
  function openDetails(ad, el) {
    const d = ad.startDate ? new Date(ad.startDate).toLocaleDateString('fr-FR') : '—';
    $('#sheet-body').innerHTML = `
      <h3>${esc(ad.pageName)}</h3>
      <dl class="kv">
        <dt>Active depuis</dt><dd>${d} (${fmtDays(ad.activeDays)})</dd>
        <dt>Versions</dt><dd>${ad.versionCount}</dd>
        <dt>Catégorie</dt><dd>${esc(ad.pageCategory) || '—'}</dd>
        <dt>Plateformes</dt><dd>${esc((ad.platforms || []).join(', ')) || '—'}</dd>
        <dt>Bouton</dt><dd>${esc(ad.ctaText) || '—'}</dd>
        <dt>Titre</dt><dd>${esc(ad.headline) || '—'}</dd>
        <dt>Site</dt><dd>${ad.linkUrl ? `<a href="${esc(ad.linkUrl)}" target="_blank" rel="noopener">${esc(ad.linkDomain || ad.linkUrl)}</a>` : '—'}</dd>
        <dt>Trouvée via</dt><dd>${esc(ad.searchTerm || '—')}</dd>
      </dl>
      <div class="full">${esc(ad.bodyText) || '<span class="muted">Pas de texte</span>'}</div>
      <div class="sheet-actions">
        <button id="sh-dl">⬇️ Ouvrir le fichier (pour l'enregistrer dans Photos)</button>
        <button id="sh-copy">📋 Copier le texte de l'ad</button>
        <button id="sh-more">➕ Plus d'ads de ${esc(ad.pageName)}</button>
        <a href="${esc(ad.adLibraryUrl)}" target="_blank" rel="noopener">Ouvrir dans la Meta Ad Library</a>
        ${ad.pageUrl ? `<a href="${esc(ad.pageUrl)}" target="_blank" rel="noopener">Page Facebook de la marque</a>` : ''}
        <button id="sh-hide">🚫 Moins de ce genre</button>
      </div>`;
    $('#sheet').classList.remove('hidden');
    $('#sh-dl').onclick = () => downloadVideo(ad);
    $('#sh-copy').onclick = async () => { try { await navigator.clipboard.writeText(ad.bodyText || ''); toast('Texte copié'); } catch {} };
    $('#sh-more').onclick = async () => {
      closeSheet(); Algo.signal(ad, 2); toast(`Je cherche plus d'ads de ${ad.pageName}…`);
      if (!$('#view-feed').classList.contains('active')) { closeViewer(); switchView('feed'); }
      try {
        const r = await fetchBatch({ type: 'page', value: ad.pageId });
        // on insère directement ces ads en tête de la suite du feed
        const pool = (await DB.all('pool')).filter(a => a.searchTerm === r.query).slice(0, 6);
        for (const a of pool) { await DB.del('pool', a.id); }
        const idx = current ? $$('.slide', feedEl).indexOf(current) : -1;
        const anchor = $$('.slide', feedEl)[idx + 1] || null;
        for (const a of pool) {
          feedAds.push(a);
          const s = buildSlide(a); feedEl.insertBefore(s, anchor); observer.observe(s);
          DB.put('seen', { id: a.id, t: Date.now() }); DB.put('seen', { id: a.dedup, t: Date.now() });
        }
        toast(pool.length ? `${pool.length} ads ajoutées juste après` : 'Pas d\'autre ad active');
      } catch (e) { toast(e.message); }
    };
    $('#sh-hide').onclick = () => {
      Algo.signal(ad, -4); closeSheet(); toast('Compris, moins de ce genre');
      if (el && el.parentElement === feedEl) { const next = el.nextElementSibling; if (next) next.scrollIntoView({ behavior: 'smooth' }); }
    };
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); }
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  // ======================================================================
  // Dossier
  // ======================================================================
  let listKind = 'saved';
  let objectUrls = [];
  function revokeAll() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }
  function blobUrls(item) {
    const out = {};
    for (const [k, b] of Object.entries(item.blobs || {})) { const u = URL.createObjectURL(b); objectUrls.push(u); out[k] = u; }
    return out;
  }

  async function renderSaved() {
    revokeAll();
    const items = (await DB.all(listKind)).sort((a, b) => (b.savedAt || b.likedAt) - (a.savedAt || a.likedAt));
    const q = Algo.tokens($('#saved-search').value).join(' ');
    const filtered = q ? items.filter(it => {
      const hay = Algo.tokens([it.pageName, it.bodyText, it.headline, it.linkDomain, it.pageCategory].join(' ')).join(' ');
      return q.split(' ').every(w => hay.includes(w));
    }) : items;
    const grid = $('#saved-grid');
    grid.innerHTML = '';
    $('#saved-empty').classList.toggle('hidden', filtered.length > 0);
    $('#saved-empty').textContent = listKind === 'saved'
      ? "Rien ici pour l'instant. Appuie sur 📑 dans le feed pour enregistrer une ad."
      : "Pas encore de likes. Double-tape une ad pour la liker.";
    filtered.forEach((it, i) => {
      const urls = blobUrls(it);
      const m = it.media[0];
      const thumb = (m.poster && (urls[m.poster] || m.poster)) || urls[m.url] || m.url;
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.style.backgroundImage = m.type === 'image' || m.poster ? `url("${thumb}")` : '';
      cell.innerHTML = `${m.type === 'video' ? '<span class="off">▶︎</span>' : ''}<span class="lbl">${esc(it.pageName)}</span>`;
      cell.onclick = () => openViewer(filtered, i);
      grid.appendChild(cell);
    });
  }
  $$('.seg button').forEach(b => b.onclick = () => {
    $$('.seg button').forEach(x => x.classList.toggle('on', x === b));
    listKind = b.dataset.list; renderSaved();
  });
  $('#saved-search').addEventListener('input', () => renderSaved());

  const viewerBody = $('#viewer-body');
  let viewerCur = null;
  function activateViewer() {
    const slides = $$('.slide', viewerBody);
    if (!slides.length) return;
    const idx = Math.min(slides.length - 1, Math.max(0, Math.round(viewerBody.scrollTop / (viewerBody.clientHeight || 1))));
    const el = slides[idx];
    if (viewerCur === el) return;
    slides.forEach((s, i) => {
      if (s !== el) { s._active = false; const v = $('video', s); if (v) v.pause(); }
      Math.abs(i - idx) <= 1 ? mount(s) : unmount(s);
    });
    viewerCur = el; el._active = true; play(el);
  }
  let vScrollT;
  viewerBody.addEventListener('scroll', () => { clearTimeout(vScrollT); vScrollT = setTimeout(activateViewer, 90); }, { passive: true });
  const viewerObserver = { observe() {}, unobserve() {} };

  function openViewer(items, start) {
    if (current) { const v = $('video', current); if (v) v.pause(); }
    const body = $('#viewer-body');
    body.innerHTML = '';
    items.forEach(it => {
      const el = buildSlide(it, { inViewer: true, blobs: blobUrls(it) });
      body.appendChild(el);
      viewerObserver.observe(el);
    });
    $('#viewer').classList.remove('hidden');
    viewerCur = null;
    body.scrollTop = start * body.clientHeight;
    activateViewer();
  }
  function closeViewer() {
    $$('#viewer-body .slide').forEach(s => { unmount(s); viewerObserver.unobserve(s); });
    $('#viewer-body').innerHTML = '';
    viewerCur = null;
    $('#viewer').classList.add('hidden');
    if ($('#view-saved').classList.contains('active')) renderSaved();
  }
  $('#viewer-close').onclick = closeViewer;

  async function removeFromFolder(el) {
    const id = el._ad.id;
    if (listKind === 'saved') { savedIds.delete(id); await DB.del('saved', id); }
    else { likedIds.delete(id); await DB.del('liked', id); }
    toast('Retirée');
    const next = el.nextElementSibling || el.previousElementSibling;
    unmount(el); el.remove();
    if (!next) closeViewer(); else { refreshButtons(id); viewerCur = null; activateViewer(); }
  }

  // ======================================================================
  // Réglages
  // ======================================================================
  function renderSettings() {
    $('#set-token').value = S.token;
    $('#set-country').value = S.country;
    $('#set-media').value = S.media;
    $('#set-interests').value = (S.interests || Algo.DEFAULT_INTERESTS).join('\n');
    const terms = Algo.learnedTerms(24);
    $('#learned').innerHTML = terms.length
      ? terms.map(([t, w]) => `<span class="chip">${esc(t)}<b>${w.toFixed(1)}</b></span>`).join('')
      : '<span class="muted">Like et enregistre des ads : l\'algo affichera ici ce qu\'il a compris de tes goûts.</span>';
    const p = Algo.profile();
    $('#stats').textContent = `${p.events} interactions apprises · ${likedIds.size} likes · ${savedIds.size} enregistrées · ${Store.get('runs', 0)} recherches Apify`;
  }
  $('#save-settings').onclick = async () => {
    const before = [S.country, S.media].join();
    Store.set('token', $('#set-token').value.trim());
    Store.set('country', $('#set-country').value);
    Store.set('media', $('#set-media').value);
    Store.set('interests', $('#set-interests').value.split('\n').map(s => s.trim()).filter(Boolean));
    toast('Réglages enregistrés');
    if (before !== [S.country, S.media].join()) { await DB.clear('pool'); resetFeed(); }
  };
  $('#reset-algo').onclick = async () => {
    if (!confirm("Effacer ce que l'algo a appris et l'historique des ads vues ? Ton dossier et tes likes sont conservés.")) return;
    Algo.reset(); await DB.clear('seen'); await DB.clear('pool');
    renderSettings(); resetFeed(); toast('Algo réinitialisé');
  };
  $('#export-btn').onclick = async () => {
    const saved = (await DB.all('saved')).map(({ blobs, ...r }) => r);
    const data = { v: 1, at: new Date().toISOString(), profile: Algo.profile(), interests: S.interests,
      country: S.country, media: S.media, saved, liked: await DB.all('liked') };
    const file = new File([JSON.stringify(data)], `adtok-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch {} }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
  };
  $('#import-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.profile) Algo.setProfile(d.profile);
      if (d.interests) Store.set('interests', d.interests);
      await DB.putMany('saved', (d.saved || []).map(s => ({ ...s, blobs: {} })));
      await DB.putMany('liked', d.liked || []);
      await loadSets(); renderSettings(); toast('Sauvegarde importée');
    } catch { toast('Fichier invalide'); }
  };

  // ======================================================================
  // Navigation / onboarding
  // ======================================================================
  function switchView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
    if (name !== 'feed' && current) { const v = $('video', current); if (v) v.pause(); }
    if (name === 'feed' && current) play(current);
    if (name === 'saved') renderSaved();
    if (name === 'settings') renderSettings();
  }
  $$('.tabbar button').forEach(b => b.onclick = () => switchView(b.dataset.view));

  function resetFeed() {
    $$('.slide', feedEl).forEach(s => { unmount(s); observer.unobserve(s); });
    feedEl.innerHTML = ''; feedAds = []; current = null;
    refill();
  }

  function onboarding() {
    const ob = $('#onboarding');
    ob.classList.remove('hidden');
    const chosen = new Set(Algo.DEFAULT_INTERESTS.slice(0, 3));
    const all = [...new Set([...Algo.DEFAULT_INTERESTS, ...Algo.EXPLORE])];
    const draw = () => {
      $('#ob-chips').innerHTML = all.map(t => `<button class="chip ${chosen.has(t) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('');
    };
    draw();
    $('#ob-chips').onclick = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      const t = b.dataset.t; chosen.has(t) ? chosen.delete(t) : chosen.add(t); draw();
    };
    $('#ob-custom').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target.value.trim(); if (!t) return;
      all.unshift(t); chosen.add(t); e.target.value = ''; draw();
    };
    $('#ob-go').onclick = () => {
      const tok = $('#ob-token').value.trim();
      if (!tok) { toast('Colle ton token Apify'); return; }
      if (!chosen.size) { toast('Choisis au moins un intérêt'); return; }
      Store.set('token', tok);
      Store.set('interests', [...chosen]);
      ob.classList.add('hidden');
      refill();
    };
  }

  async function loadSets() {
    likedIds = new Set(await DB.keys('liked'));
    savedIds = new Set(await DB.keys('saved'));
  }

  async function init() {
    await loadSets();
    if (!S.token) onboarding(); else refill();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
