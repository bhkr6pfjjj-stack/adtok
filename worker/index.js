// Relais gratuit AdTok (Cloudflare Worker, offre gratuite : 100 000 requêtes/jour).
// 1. interroge l'API officielle Meta Ad Library (gratuite) avec ton token, gardé ici en secret ;
// 2. va chercher les vidéos/images dans la page d'aperçu de chaque ad (impossible depuis le téléphone :
//    Facebook bloque ces pages depuis un site web) ;
// 3. renvoie les ads au même format que le scraper Apify, pour que l'app les affiche pareil.
//
// Secrets à définir : META_TOKEN (token Meta avec accès Ad Library), APP_KEY (mot de passe partagé avec l'app).

const GRAPH = 'https://graph.facebook.com/v21.0/ads_archive';
const FIELDS = [
  'id', 'page_id', 'page_name', 'ad_snapshot_url', 'ad_creative_bodies', 'ad_creative_link_titles',
  'ad_creative_link_descriptions', 'ad_creative_link_captions', 'ad_delivery_start_time', 'ad_delivery_stop_time',
  'publisher_platforms', 'eu_total_reach',
].join(',');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
});

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (!env.APP_KEY || req.headers.get('X-App-Key') !== env.APP_KEY) return json({ error: 'Clé du relais incorrecte' }, 401);
    if (!env.META_TOKEN) return json({ error: 'META_TOKEN manquant sur le relais' }, 500);
    try {
      if (url.pathname === '/search') return json(await search(url.searchParams, env, ctx));
      if (url.pathname === '/ad') return json(await oneAd(url.searchParams.get('id'), env, ctx));
      if (url.pathname === '/ping') return json({ ok: true });
      return json({ error: 'Route inconnue' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 502);
    }
  },
};

// ---------- recherche ----------
async function search(p, env, ctx) {
  const country = p.get('country') || 'FR';
  const q = new URLSearchParams({
    access_token: env.META_TOKEN,
    fields: FIELDS,
    ad_type: 'ALL',
    ad_reached_countries: JSON.stringify([country === 'ALL' ? 'ALL' : country]),
    ad_active_status: ({ active: 'ACTIVE', inactive: 'INACTIVE', all: 'ALL' })[p.get('status')] || 'ACTIVE',
    media_type: ({ video: 'VIDEO', image: 'IMAGE', all: 'ALL' })[p.get('media')] || 'ALL',
    limit: String(Math.min(Number(p.get('limit')) || 25, 40)),
  });
  if (p.get('q')) { q.set('search_terms', p.get('q')); q.set('search_type', 'KEYWORD_UNORDERED'); }
  if (p.get('page_ids')) q.set('search_page_ids', JSON.stringify(p.get('page_ids').split(',')));
  if (p.get('date_min')) q.set('ad_delivery_date_min', p.get('date_min'));
  if (p.get('after')) q.set('after', p.get('after'));

  const r = await fetch(GRAPH + '?' + q);
  const d = await r.json();
  if (d.error) {
    const e = new Error(d.error.code === 10 || d.error.error_subcode === 2332002
      ? "Ton token Meta n'a pas encore accès à la Ad Library (vérification d'identité sur facebook.com/ads/library/api)."
      : 'Meta : ' + d.error.message);
    e.status = 403;
    throw e;
  }
  const ads = d.data || [];
  // aperçus en parallèle (6 à la fois), mis en cache 12 h par Cloudflare
  const items = [];
  for (let i = 0; i < ads.length; i += 6) {
    const chunk = await Promise.all(ads.slice(i, i + 6).map(a => snapshot(a.id, a.ad_snapshot_url, env, ctx).catch(() => null)));
    chunk.forEach((m, k) => items.push(toItem(ads[i + k], m, p.get('q') || (p.get('page_ids') ? 'page:' + p.get('page_ids') : ''))));
  }
  return { items, after: d.paging && d.paging.cursors && d.paging.next ? d.paging.cursors.after : null };
}

async function oneAd(id, env, ctx) {
  if (!/^\d+$/.test(id || '')) throw Object.assign(new Error('id invalide'), { status: 400 });
  const m = await snapshot(id, null, env, ctx, true);
  return { id, ...m };
}

// ---------- page d'aperçu → vidéos / images ----------
async function snapshot(id, snapshotUrl, env, ctx, fresh = false) {
  const cache = caches.default;
  const key = new Request('https://adtok-cache/snap/' + id);
  if (!fresh) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const u = new URL(snapshotUrl || `https://www.facebook.com/ads/archive/render_ad/?id=${id}`);
  u.searchParams.set('access_token', env.META_TOKEN);
  const r = await fetch(u, { headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9',
  } });
  const media = parseSnapshot(await r.text());
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(media), { headers: { 'Cache-Control': 'max-age=43200' } })));
  return media;
}

// Les pages d'aperçu contiennent un bloc JSON "snapshot" (mêmes clés que la Ad Library) :
// video_hd_url, video_sd_url, video_preview_image_url, original_image_url, resized_image_url, page_profile_picture_url…
export function parseSnapshot(html) {
  const all = (k) => [...html.matchAll(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(m => unescapeJson(m[1])).filter(Boolean);
  const one = (k) => all(k)[0] || null;
  const hd = all('video_hd_url'), sd = all('video_sd_url'), prev = all('video_preview_image_url');
  const videos = [];
  const n = Math.max(hd.length, sd.length);
  for (let i = 0; i < n; i++) {
    const v = { hdUrl: hd[i] || null, sdUrl: sd[i] || null, previewImageUrl: prev[i] || null };
    if ((v.hdUrl || v.sdUrl) && !videos.some(x => (x.hdUrl || x.sdUrl) === (v.hdUrl || v.sdUrl))) videos.push(v);
  }
  const imageUrls = [...new Set([...all('original_image_url'), ...all('resized_image_url')])]
    .filter(u => !prev.includes(u)).slice(0, 6);
  return {
    videos: videos.slice(0, 6),
    imageUrls: videos.length ? [] : imageUrls,
    pageProfilePictureUrl: one('page_profile_picture_url'),
    linkUrl: one('link_url'),
    ctaText: one('cta_text'),
    pageCategory: (all('page_categories')[0]) || null,
    found: videos.length + imageUrls.length > 0,
  };
}
function unescapeJson(s) { try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, '/'); } }

// ---------- format identique à Apify (outputFormat "clean") ----------
function toItem(a, m, searchTerm) {
  const start = a.ad_delivery_start_time, stop = a.ad_delivery_stop_time;
  const end = stop ? new Date(stop) : new Date();
  const days = start ? Math.max(0, Math.round((end - new Date(start)) / 864e5)) : 0;
  const caption = (a.ad_creative_link_captions || [])[0] || '';
  const linkUrl = (m && m.linkUrl) || (caption ? 'https://' + caption.replace(/^https?:\/\//, '') : '');
  let linkDomain = '';
  try { linkDomain = linkUrl ? new URL(linkUrl).hostname.replace(/^www\./, '') : ''; } catch {}
  return {
    adArchiveId: a.id,
    pageId: a.page_id, pageName: a.page_name,
    pageProfilePictureUrl: m && m.pageProfilePictureUrl,
    pageCategory: (m && m.pageCategory) || '',
    bodyText: (a.ad_creative_bodies || [])[0] || '',
    headline: (a.ad_creative_link_titles || [])[0] || '',
    linkDescription: (a.ad_creative_link_descriptions || [])[0] || '',
    linkUrl, linkDomain,
    ctaText: (m && m.ctaText) || '',
    startDate: start ? start.slice(0, 10) : null,
    endDate: stop ? stop.slice(0, 10) : null,
    isActive: !stop || new Date(stop) > new Date(),
    activeDays: days,
    versionCount: 1,
    euReach: typeof a.eu_total_reach === 'number' ? a.eu_total_reach : null,
    platforms: a.publisher_platforms || [],
    videos: (m && m.videos) || [],
    imageUrls: (m && m.imageUrls) || [],
    mediaFound: !!(m && m.found),
    searchTerm,
    adLibraryUrl: `https://www.facebook.com/ads/library/?id=${a.id}`,
  };
}
