# HOMEBASE

Comp-driven home valuation workbench. Next.js + Supabase + Anthropic API.

- **Data:** one Postgres table (`kv`) holding the same three keys the app always used — `properties`, `appreciation`, `compPool` — plus `kv_history` (automatic restore points).
- **AI:** all five AI calls go through `app/api/ai/route.js`, which holds the API key server-side and sets the model.
- **Live sync:** edits broadcast over Supabase Realtime; every open screen refreshes within a second or two (plus a 20 s poll and refresh-on-focus as a safety net).
- **Install:** it's a PWA — "Install app" / "Add to Home screen".
- **Access:** no login by design. Anyone with the URL can view and edit. The page is marked `noindex`.

Setup: see `SETUP.md`.
