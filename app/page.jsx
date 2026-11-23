"use client";
import dynamic from "next/dynamic";

// The app is browser-only (it talks to window.storage), so skip server rendering.
const HomeBaseApp = dynamic(() => import("../components/HomeBaseApp"), {
  ssr: false,
  loading: () => <div style={{ padding: 40, fontFamily: "Georgia, serif", color: "#6b7671" }}>Loading your properties…</div>,
});

export default function Page() {
  return <HomeBaseApp />;
}
