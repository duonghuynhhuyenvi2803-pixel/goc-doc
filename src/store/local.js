// Lưu trữ cục bộ bằng IndexedDB — dùng khi chưa cấu hình Supabase (chế độ dùng thử / offline).
const DB_NAME = 'goc-doc';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sections', { keyPath: 'id' });
      db.createObjectStore('docs', { keyPath: 'id' });
      const anns = db.createObjectStore('anns', { keyPath: 'id' });
      anns.createIndex('doc_id', 'doc_id');
      db.createObjectStore('notes', { keyPath: 'doc_id' });
      db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp;
const db = () => (dbp ||= open());

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, v, key) => tx(store, 'readwrite', (s) => (key ? s.put(v, key) : s.put(v)));
const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

const urlCache = new Map();

export const localStore = {
  mode: 'local',
  async init() {},
  async getUser() { return { id: 'local', email: 'Trên máy này' }; },
  async signIn() {},
  async signOut() {},

  sections: {
    list: async () => (await all('sections')).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    upsert: (s) => put('sections', s),
    remove: (id) => del('sections', id),
  },
  docs: {
    list: async () => (await all('docs')).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    upsert: (d) => put('docs', d),
    async remove(d) {
      await del('docs', d.id);
      await del('blobs', d.file_path);
      await del('notes', d.id);
      const anns = await localStore.anns.list(d.id);
      for (const a of anns) await del('anns', a.id);
    },
    async uploadPdf(file) {
      const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
      const path = `pdf/${crypto.randomUUID()}.${ext}`;
      await put('blobs', file, path);
      return { file_path: path, size: file.size };
    },
    async getPdf(d) {
      const blob = await get('blobs', d.file_path);
      if (!blob) throw new Error('Không tìm thấy file PDF');
      return await blob.arrayBuffer();
    },
  },
  anns: {
    list: (docId) => tx('anns', 'readonly', (s) => s.index('doc_id').getAll(docId)),
    upsert: (a) => put('anns', a),
    remove: (id) => del('anns', id),
  },
  notes: {
    get: (docId) => get('notes', docId),
    save: (docId, html, text) => put('notes', { doc_id: docId, html, text, updated_at: new Date().toISOString() }),
    listTexts: async () => (await all('notes')).map((n) => ({ doc_id: n.doc_id, text: n.text || '' })),
  },
  images: {
    async upload(blob) {
      const path = `img/${crypto.randomUUID()}`;
      await put('blobs', blob, path);
      return path;
    },
    async url(ref) {
      if (urlCache.has(ref)) return urlCache.get(ref);
      const blob = await get('blobs', ref);
      if (!blob) return '';
      const u = URL.createObjectURL(blob);
      urlCache.set(ref, u);
      return u;
    },
    async blob(ref) { return get('blobs', ref); },
  },
};
