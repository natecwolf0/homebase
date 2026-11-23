// Supabase-backed replacement for the `window.storage` API the app was written
// against inside Claude. The app code is unchanged: it still calls
// window.storage.get / set / delete with the same keys ("properties",
// "appreciation", "compPool") and the same JSON strings. They now live in one
// Postgres table (public.kv) shared by everyone with the link.
//
// Behaviours worth knowing:
//  - set() is debounced (~0.8s) so typing in a field is one save, not one per
//    keystroke. A tab-close warning appears if edits are still unsaved.
//  - If a key could not be READ (network/db error), writes to it are refused so
//    an empty "failed to load" state can never overwrite real data.
//  - Live sync: after every save a tiny broadcast message ("key X changed") goes
//    out on a Supabase Realtime channel; other open screens re-fetch that key.
//    A 20s poll + refetch on tab focus covers any missed message.
//  - A local unsaved edit always wins over an incoming remote change.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SYNC_KEYS = ["properties", "appreciation", "compPool"];
const DEBOUNCE_MS = 800;
const POLL_MS = 20000;
const CHANNEL = "homebase-sync";

export const isConfigured = !!(SUPABASE_URL && SUPABASE_KEY);

let sb = null;
let channel = null;
let started = false;
const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

const cache = new Map();      // key -> { value, updatedAt }
const timers = new Map();     // key -> debounce timer (a pending local write)
const locks = new Map();      // key -> promise of the write currently in flight
const loadFailed = new Set(); // keys whose last read errored — writes refused
let lastError = null;

function client() {
  if (!sb) sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return sb;
}

function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
}
const busy = () => timers.size > 0 || locks.size > 0;
function status(state, message) { emit("hb-sync", { state, message: message || "" }); }

// ------------------------------- reads --------------------------------------
async function get(key) {
  // A key with a local unsaved/in-flight write is the freshest truth.
  if (timers.has(key) || locks.has(key)) {
    const c = cache.get(key);
    return c ? { key, value: c.value } : null;
  }
  const { data, error } = await client().from("kv").select("value,updated_at").eq("key", key).maybeSingle();
  if (error) { loadFailed.add(key); throw new Error(error.message); }
  loadFailed.delete(key);
  if (!data) { cache.delete(key); return null; }
  cache.set(key, { value: data.value, updatedAt: data.updated_at });
  return { key, value: data.value };
}

// ------------------------------- writes -------------------------------------
async function writeNow(key) {
  const entry = cache.get(key);
  if (!entry) return;
  const value = entry.value;
  let attempt = 0;
  for (;;) {
    attempt++;
    const { data, error } = await client().from("kv").upsert({ key, value }, { onConflict: "key" }).select("updated_at").single();
    if (!error) {
      cache.set(key, { value, updatedAt: data.updated_at });
      lastError = null;
      try { channel?.send({ type: "broadcast", event: "changed", payload: { key, by: clientId } }); } catch {}
      return;
    }
    lastError = error.message;
    if (attempt >= 3) throw new Error(error.message);
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }
}

function flush(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const prev = locks.get(key) || Promise.resolve();
  status("saving");
  const run = prev.catch(() => {}).then(() => writeNow(key));
  const tracked = run.then(
    () => { if (locks.get(key) === tracked) locks.delete(key); if (!busy()) status("saved"); },
    (e) => {
      if (locks.get(key) === tracked) locks.delete(key);
      status("error", "Not saved — " + (e?.message || "network problem") + ". Retrying…");
      // keep the data and try again shortly (unless a newer edit already queued)
      if (!timers.has(key)) timers.set(key, setTimeout(() => flush(key), 5000));
    }
  );
  locks.set(key, tracked);
  return tracked;
}

async function set(key, value) {
  if (loadFailed.has(key)) {
    const msg = "Not saved — this page couldn't load the latest data from the database. Refresh the page and try again.";
    status("error", msg);
    throw new Error(msg);
  }
  const prev = cache.get(key);
  cache.set(key, { value, updatedAt: prev?.updatedAt || null });
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => flush(key), DEBOUNCE_MS));
  status("dirty");
  return { key, value };
}

async function del(key) {
  clearTimeout(timers.get(key)); timers.delete(key);
  cache.delete(key);
  const { error } = await client().from("kv").delete().eq("key", key);
  if (error) throw new Error(error.message);
  try { channel?.send({ type: "broadcast", event: "changed", payload: { key, by: clientId } }); } catch {}
  return { key, deleted: true };
}

function flushAll() {
  return Promise.all([...timers.keys()].map((k) => flush(k)));
}

// ------------------------------ version history -----------------------------
async function history(key) {
  const { data, error } = await client().from("kv_history").select("id,key,saved_at").eq("key", key).order("saved_at", { ascending: false }).limit(15);
  if (error) throw new Error(error.message);
  return data;
}
async function historyGet(id) {
  const { data, error } = await client().from("kv_history").select("value").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data.value;
}

// ------------------------------- live sync ----------------------------------
async function syncKeys(keys) {
  const check = keys.filter((k) => !timers.has(k) && !locks.has(k));
  if (!check.length) return;
  const { data, error } = await client().from("kv").select("key,updated_at").in("key", check);
  if (error || !data) return;
  for (const row of data) {
    if (timers.has(row.key) || locks.has(row.key)) continue; // local edit wins
    const known = cache.get(row.key);
    if (known && known.updatedAt === row.updated_at) continue;
    const r = await client().from("kv").select("value,updated_at").eq("key", row.key).maybeSingle();
    if (r.error || !r.data) continue;
    if (timers.has(row.key) || locks.has(row.key)) continue;
    const same = known && known.value === r.data.value;
    cache.set(row.key, { value: r.data.value, updatedAt: r.data.updated_at });
    if (!same) emit("hb-remote", { key: row.key, value: r.data.value });
  }
}

export function startSync() {
  if (started || !isConfigured || typeof window === "undefined") return () => {};
  started = true;
  try {
    channel = client().channel(CHANNEL, { config: { broadcast: { self: false } } });
    channel.on("broadcast", { event: "changed" }, ({ payload }) => {
      if (payload && payload.by !== clientId && SYNC_KEYS.includes(payload.key)) syncKeys([payload.key]);
    }).subscribe();
  } catch {}
  const poll = setInterval(() => { if (document.visibilityState === "visible") syncKeys(SYNC_KEYS); }, POLL_MS);
  const onVis = () => {
    if (document.visibilityState === "hidden") flushAll();
    else syncKeys(SYNC_KEYS);
  };
  const onFocus = () => syncKeys(SYNC_KEYS);
  const onBeforeUnload = (e) => {
    if (busy()) { flushAll(); e.preventDefault(); e.returnValue = ""; }
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("focus", onFocus);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", flushAll);
  return () => {
    started = false;
    clearInterval(poll);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pagehide", flushAll);
    try { channel && client().removeChannel(channel); } catch {}
    channel = null;
  };
}

export function installStorage() {
  if (typeof window === "undefined") return;
  window.storage = { get, set, delete: del, history, historyGet };
}

export const _debug = { cache, timers, locks, loadFailed, get lastError() { return lastError; }, clientId };
