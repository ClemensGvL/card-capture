// IndexedDB queue for captured contacts. No network involved here.
// Each record: { id, fields..., contextNote, cardImageDataUrl, capturedAt }
const DB = (() => {
  const NAME = "card-capture";
  const STORE = "captures";
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode) { return open().then(db => db.transaction(STORE, mode).objectStore(STORE)); }

  return {
    async add(record) {
      const store = await tx("readwrite");
      return new Promise((res, rej) => {
        const r = store.add(record);
        r.onsuccess = () => res(record);
        r.onerror = () => rej(r.error);
      });
    },
    async all() {
      const store = await tx("readonly");
      return new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    },
    async remove(id) {
      const store = await tx("readwrite");
      return new Promise((res, rej) => {
        const r = store.delete(id);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    },
    async count() {
      const store = await tx("readonly");
      return new Promise((res, rej) => {
        const r = store.count();
        r.onsuccess = () => res(r.result || 0);
        r.onerror = () => rej(r.error);
      });
    },
  };
})();
