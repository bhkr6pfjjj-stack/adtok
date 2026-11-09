// Stockage local : IndexedDB pour les ads (dossier, likes, vidéos), localStorage pour les réglages.
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('adtok', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('saved', { keyPath: 'id' });   // ads enregistrées (+ blob vidéo)
        db.createObjectStore('liked', { keyPath: 'id' });   // ads likées
        db.createObjectStore('seen', { keyPath: 'id' });    // ads déjà vues (pas de doublon)
        db.createObjectStore('pool', { keyPath: 'id' });    // ads en attente d'être servies
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
  set(key, val) { try { localStorage.setItem('adtok.' + key, JSON.stringify(val)); } catch {} },
};
