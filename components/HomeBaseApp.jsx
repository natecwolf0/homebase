"use client";
import { useEffect, useState } from "react";
import { installStorage, startSync, isConfigured } from "../lib/storage";
import App from "./HomeBase";

installStorage();

// Small, quiet save indicator (bottom-right). Shows only while something is
// happening; goes away on its own.
function SyncPill() {
  const [s, setS] = useState({ state: "idle", message: "" });
  useEffect(() => {
    let t;
    const on = (e) => {
      const d = e.detail;
      setS(d);
      clearTimeout(t);
      if (d.state === "saved") t = setTimeout(() => setS({ state: "idle", message: "" }), 1800);
    };
    window.addEventListener("hb-sync", on);
    return () => { window.removeEventListener("hb-sync", on); clearTimeout(t); };
  }, []);
  if (s.state === "idle") return null;
  const err = s.state === "error";
  const label = err ? s.message : s.state === "saved" ? "Saved ✓" : "Saving…";
  return (
    <div role="status" style={{
      position: "fixed", right: 12, bottom: 12, zIndex: 50, maxWidth: "min(360px, 90vw)",
      padding: "7px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, fontFamily: "Inter, system-ui, sans-serif",
      background: err ? "#f5e6e0" : "#e7efe9", color: err ? "#9e3b2a" : "#2f5d50",
      border: `1px solid ${err ? "#a8492f" : "#2f5d50"}`, boxShadow: "0 2px 8px rgba(0,0,0,.12)",
    }}>{label}</div>
  );
}

export default function HomeBaseApp() {
  useEffect(() => (isConfigured ? startSync() : undefined), []);
  useEffect(() => {
    // lets the browser offer "Install app" / "Add to Home screen" as a standalone app
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  if (!isConfigured) {
    return (
      <div style={{ padding: 40, maxWidth: 560, fontFamily: "Georgia, serif", color: "#1a2b26", lineHeight: 1.6 }}>
        <h2 style={{ marginTop: 0 }}>HOMEBASE isn’t connected to its database yet</h2>
        <p>The environment variables <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are missing. Add them in Vercel → Project → Settings → Environment Variables, then redeploy.</p>
      </div>
    );
  }
  return (<><App /><SyncPill /></>);
}
