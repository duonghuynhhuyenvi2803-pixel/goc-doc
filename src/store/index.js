import { localStore } from './local.js';
import { makeSupabaseStore } from './supabase.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Có key Supabase → đồng bộ cloud; chưa có → lưu trên máy (IndexedDB).
export const store = url && key ? makeSupabaseStore(url, key) : localStore;

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
