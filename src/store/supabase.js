// Lưu trữ trên Supabase — đồng bộ giữa laptop và điện thoại.
import { createClient } from '@supabase/supabase-js';

export function makeSupabaseStore(url, key) {
  const sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  let uid = null;
  const urlCache = new Map();

  const ok = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  const strip = (row) => {
    const r = { ...row };
    delete r.user_id;
    return r;
  };

  const store = {
    mode: 'cloud',
    sb,
    async init() {
      const { data } = await sb.auth.getSession();
      uid = data.session?.user?.id || null;
      sb.auth.onAuthStateChange((_e, session) => { uid = session?.user?.id || null; });
    },
    async getUser() {
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      uid = u?.id || null;
      return u ? { id: u.id, email: u.email } : null;
    },
    async signIn(email, password) {
      ok(await sb.auth.signInWithPassword({ email, password }));
      await store.getUser();
    },
    async signOut() { await sb.auth.signOut(); uid = null; },

    sections: {
      list: async () => ok(await sb.from('sections').select('*').order('sort')).map(strip),
      upsert: async (s) => ok(await sb.from('sections').upsert({ ...s, user_id: uid })),
      remove: async (id) => ok(await sb.from('sections').delete().eq('id', id)),
    },
    docs: {
      list: async () => ok(await sb.from('docs').select('*').order('updated_at', { ascending: false })).map(strip),
      upsert: async (d) => ok(await sb.from('docs').upsert({ ...d, user_id: uid })),
      async remove(d) {
        ok(await sb.from('docs').delete().eq('id', d.id)); // anns + notes xoá theo (on delete cascade)
        await sb.storage.from('pdfs').remove([d.file_path]);
      },
      async uploadPdf(file) {
        const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
        const path = `${uid}/${crypto.randomUUID()}.${ext}`;
        ok(await sb.storage.from('pdfs').upload(path, file, { contentType: file.type || 'application/octet-stream' }));
        return { file_path: path, size: file.size };
      },
      async getPdf(d) {
        const blob = ok(await sb.storage.from('pdfs').download(d.file_path));
        return await blob.arrayBuffer();
      },
    },
    anns: {
      list: async (docId) => ok(await sb.from('anns').select('*').eq('doc_id', docId)).map(strip),
      upsert: async (a) => ok(await sb.from('anns').upsert({ ...a, user_id: uid })),
      remove: async (id) => ok(await sb.from('anns').delete().eq('id', id)),
    },
    notes: {
      async get(docId) {
        const rows = ok(await sb.from('notes').select('*').eq('doc_id', docId));
        return rows[0] ? strip(rows[0]) : null;
      },
      save: async (docId, html, text) =>
        ok(await sb.from('notes').upsert({ doc_id: docId, html, text, updated_at: new Date().toISOString(), user_id: uid })),
      listTexts: async () => ok(await sb.from('notes').select('doc_id,text')),
    },
    images: {
      async upload(blob) {
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const path = `${uid}/${crypto.randomUUID()}.${ext}`;
        ok(await sb.storage.from('images').upload(path, blob, { contentType: blob.type || 'image/png' }));
        return path;
      },
      async url(ref) {
        const c = urlCache.get(ref);
        if (c && c.exp > Date.now()) return c.url;
        const data = ok(await sb.storage.from('images').createSignedUrl(ref, 60 * 60 * 6));
        urlCache.set(ref, { url: data.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 5 });
        return data.signedUrl;
      },
      async blob(ref) { return ok(await sb.storage.from('images').download(ref)); },
    },
  };
  return store;
}
