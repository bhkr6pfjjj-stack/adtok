// Stockage local : IndexedDB pour les ads (dossier, likes, vidéos), localStorage pour les réglages.
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('adtok', 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('saved', { keyPath: 'id' });   // ads enregistrées (+ images)
          db.createObjectStore('liked', { keyPath: 'id' });   // ads likées
          db.createObjectStore('seen', { keyPath: 'id' });    // ads déjà vues (pas de doublon)
          db.createObjectStore('pool', { keyPath: 'id' });    // ads en attente d'être servies
        }
        if (e.oldVersion < 2) db.createObjectStore('kv', { keyPath: 'id' }); // réglages importants (copie de secours)
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : r);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
    putMany: (store, vals) => tx(store, 'readwrite', s => { vals.forEach(v => s.put(v)); }),
    get: (store, id) => tx(store, 'readonly', s => s.get(id)),
    del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
    keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', s => s.clear()),
  };
})();

const Store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('adtok.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem('adtok.' + key, JSON.stringify(val)); } catch {}
    // la clé Apify et les réglages essentiels sont aussi copiés dans IndexedDB, au cas où l'un des deux serait vidé
    if (Store.BACKUP.includes(key)) DB.put('kv', { id: key, v: val }).catch(() => {});
  },
  BACKUP: ['token', 'interests', 'country', 'status', 'sort', 'media', 'shopify', 'profile'],
  // au démarrage : si localStorage a été vidé, on recopie depuis IndexedDB
  async restore() {
    try {
      for (const row of await DB.all('kv')) {
        if (localStorage.getItem('adtok.' + row.id) == null && row.v != null) localStorage.setItem('adtok.' + row.id, JSON.stringify(row.v));
      }
      // et dans l'autre sens : première fois après la mise à jour, on remplit la copie de secours
      for (const k of Store.BACKUP) {
        const v = localStorage.getItem('adtok.' + k);
        if (v != null) await DB.put('kv', { id: k, v: JSON.parse(v) });
      }
    } catch {}
    // demande à iOS / au navigateur de ne pas effacer les données de l'app
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
  },
};
