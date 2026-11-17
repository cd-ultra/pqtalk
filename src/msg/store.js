// Tiny IndexedDB wrapper. Everything private (keys, sessions, messages) lives on the device only.
const DB = 'pqtalk-msg', VER = 1;
const STORES = {
  kv: {}, contacts: { keyPath: 'id' }, convs: { keyPath: 'id' }, sessions: { keyPath: 'sid' },
  messages: { keyPath: 'id', index: ['byConv', ['conv', 'ts']] }, outbox: { keyPath: 'id' }, blobs: {},
};

let dbp;
export function openDb(name = DB) {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(name, VER);
    r.onupgradeneeded = () => {
      for (const [s, o] of Object.entries(STORES)) {
        if (r.result.objectStoreNames.contains(s)) continue;
        const os = r.result.createObjectStore(s, o.keyPath ? { keyPath: o.keyPath } : undefined);
        if (o.index) os.createIndex(o.index[0], o.index[1]);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(store, mode, fn) {
  const db = await openDb();
  const t = db.transaction(store, mode);
  const out = fn(t.objectStore(store));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out instanceof IDBRequest ? out.result : out;
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, val, key) => tx(store, 'readwrite', (s) => s.put(val, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());

export async function messagesFor(conv, limit = 300) {
  const db = await openDb();
  const idx = db.transaction('messages').objectStore('messages').index('byConv');
  const range = IDBKeyRange.bound([conv, 0], [conv, Infinity]);
  const out = [];
  await new Promise((res, rej) => {
    const c = idx.openCursor(range, 'prev');
    c.onsuccess = () => { const cur = c.result; if (!cur || out.length >= limit) return res(); out.push(cur.value); cur.continue(); };
    c.onerror = () => rej(c.error);
  });
  return out.reverse();
}

export async function wipeAll() {
  const db = await openDb();
  db.close(); dbp = null;
  await req(indexedDB.deleteDatabase(DB));
}
