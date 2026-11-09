// L'algorithme : apprend tes goûts à partir de tes likes, enregistrements, temps de visionnage et swipes,
// choisit les prochaines recherches dans la Ad Library, puis classe les ads récupérées.
const Algo = (() => {
  const STOP = new Set(`
    alors aussi autre avant avec avoir bien cela celle cette ceux chez comme comment dans des donc dont elle elles
    encore entre est etre être faire fait plus pour pourquoi quand que quel quelle qui quoi sans selon ses son sont
    sous sur tous tout toute toutes très trop une vos votre vous nous notre leur leurs mais même ici ainsi peut
    jour jours avez sera ont été cest c'est qu'il qu'elle n'est d'un d'une l'on chaque depuis vers voici voilà
    offre offert livraison gratuite gratuit code promo commande commandez maintenant découvrez decouvrez profitez
    seulement nouveau nouvelle nouveaux meilleur meilleure produit produits site lien clique cliquez shop
    with your that this from have will what more about just like they them their there when which would been
    were into only also than then some these those over most such very much make made best free shipping order
    shop click link learn more now today get new http https www com
  `.split(/\s+/).filter(Boolean));

  // Niches pour l'exploration (20 % du feed) : élargit ce que l'algo connaît de toi.
  const EXPLORE = [
    'skincare', 'sérum', 'complément alimentaire', 'minceur', 'cheveux', 'maquillage', 'parfum', 'mode femme',
    'robe', 'sneakers', 'bijoux', 'montre', 'sac à main', 'lingerie', 'sport', 'fitness', 'yoga', 'protéine',
    'gadget', 'cuisine', 'maison déco', 'bébé', 'chien', 'chat', 'jardin', 'voiture accessoire', 'tech',
    'écouteurs', 'application', 'formation en ligne', 'e-commerce', 'dropshipping', 'café', 'thé', 'nutrition',
    'sommeil', 'posture', 'douleur dos', 'dents blanches', 'barbe', 'lunettes', 'valise', 'jeux', 'cadeau',
  ];

  const DEFAULT_INTERESTS = ['skincare', 'mode femme', 'complément alimentaire', 'gadget', 'e-commerce', 'cheveux'];

  function norm(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function tokens(text) {
    const out = new Set();
    for (const w of norm(text).split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
    return [...out];
  }
  function adText(ad) {
    return [ad.bodyText, ad.headline, ad.linkDescription, ad.pageCategory, ad.pageName].join(' ');
  }
  function adTokens(ad) { return ad._tok || (ad._tok = tokens(adText(ad))); }

  // ---------- profil ----------
  function load() {
    return Store.get('profile', {
      tok: {},        // mot -> poids
      page: {},       // pageId -> poids
      domain: {},     // domaine -> poids
      cat: {},        // catégorie de page -> poids
      query: {},      // recherche -> {w, last, n}
      events: 0,
    });
  }
  let P = load();
  const save = () => Store.set('profile', P);

  function bump(map, key, delta, cap = 30) {
    if (!key) return;
    map[key] = Math.max(-cap, Math.min(cap, (map[key] || 0) + delta));
    if (Math.abs(map[key]) < 0.05) delete map[key];
  }

  // Signaux : like +3, save +5, vu en entier +1.5, vu à moitié +0.6, swipe en < 1,5 s -0.8, unlike -3
  function signal(ad, delta) {
    for (const t of adTokens(ad)) bump(P.tok, t, delta * 0.35);
    bump(P.page, ad.pageId, delta);
    bump(P.domain, ad.linkDomain, delta * 0.6);
    bump(P.cat, norm(ad.pageCategory), delta * 0.5);
    if (ad.searchTerm && P.query[ad.searchTerm]) {
      const q = P.query[ad.searchTerm];
      q.w = Math.max(-5, Math.min(20, (q.w || 0) + delta * 0.5));
    }
    P.events++;
    // oubli progressif : les vieux goûts s'estompent doucement
    if (P.events % 25 === 0) decay();
    save();
  }
  function decay() {
    for (const m of [P.tok, P.page, P.domain, P.cat]) {
      for (const k in m) { m[k] *= 0.92; if (Math.abs(m[k]) < 0.1) delete m[k]; }
    }
  }

  // ---------- score d'une ad ----------
  function score(ad) {
    let s = 0;
    const toks = adTokens(ad);
    for (const t of toks) s += P.tok[t] || 0;
    s = s / Math.sqrt(Math.max(4, toks.length)) * 2;           // pas d'avantage aux textes très longs
    s += (P.page[ad.pageId] || 0) * 0.8;
    s += (P.domain[ad.linkDomain] || 0) * 0.5;
    s += (P.cat[norm(ad.pageCategory)] || 0) * 0.4;
    // signal "winner" : une ad qui tourne depuis longtemps ou avec beaucoup de versions
    s += Math.log1p(ad.activeDays || 0) * 0.45;
    s += Math.min(ad.versionCount || 1, 20) * 0.08;
    if (ad.mediaType === 'video') s += 0.4;
    s += (Math.random() - 0.5) * 1.2;                           // un peu de hasard pour éviter la bulle
    return s;
  }

  // ---------- choix des prochaines recherches ----------
  function learnedTerms(n = 12) {
    return Object.entries(P.tok).filter(([, w]) => w > 0.8).sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  function likedPages() {
    return Object.entries(P.page).filter(([, w]) => w >= 4).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  // Retourne {type:'term', value} ou {type:'page', value:pageId}
  function nextQuery(interests) {
    const now = Date.now();
    const cool = (q) => { const h = P.query[q]; return !h || now - (h.last || 0) > 1000 * 60 * 45; };
    const r = Math.random();

    // 15 % : plus d'ads d'un annonceur que tu as aimé
    const pages = likedPages().filter(id => cool('page:' + id));
    if (r < 0.15 && pages.length) {
      return { type: 'page', value: pages[Math.floor(Math.random() * Math.min(5, pages.length))] };
    }
    // 20 % : exploration
    if (r < 0.35) {
      const pool = EXPLORE.filter(q => cool(q) && !interests.includes(q));
      if (pool.length) return { type: 'term', value: pool[Math.floor(Math.random() * pool.length)] };
    }
    // sinon : tirage pondéré entre tes intérêts et les mots appris
    const cands = [];
    for (const q of interests) cands.push([q, 3 + ((P.query[q] && P.query[q].w) || 0)]);
    for (const [t, w] of learnedTerms()) if (!interests.includes(t)) cands.push([t, w + ((P.query[t] && P.query[t].w) || 0)]);
    // combos "intérêt + mot appris" pour aller chercher plus précis
    const lt = learnedTerms(4);
    if (lt.length && interests.length) {
      const a = interests[Math.floor(Math.random() * interests.length)];
      const b = lt[Math.floor(Math.random() * lt.length)][0];
      if (!norm(a).includes(b)) cands.push([`${a} ${b}`, 2.5]);
    }
    let usable = cands.filter(([q, w]) => w > 0 && cool(q));
    if (!usable.length) usable = cands.filter(([, w]) => w > 0);
    if (!usable.length) return { type: 'term', value: EXPLORE[Math.floor(Math.random() * EXPLORE.length)] };
    const total = usable.reduce((s, [, w]) => s + w, 0);
    let x = Math.random() * total;
    for (const [q, w] of usable) { x -= w; if (x <= 0) return { type: 'term', value: q }; }
    return { type: 'term', value: usable[0][0] };
  }

  function markQuery(key) {
    const h = P.query[key] || (P.query[key] = { w: 0, n: 0 });
    h.last = Date.now(); h.n++;
    save();
  }

  function reset() { P = { tok: {}, page: {}, domain: {}, cat: {}, query: {}, events: 0 }; save(); }
  function profile() { return P; }
  function setProfile(p) { P = p; save(); }

  return { signal, score, nextQuery, markQuery, learnedTerms, reset, profile, setProfile, tokens, DEFAULT_INTERESTS, EXPLORE };
})();
