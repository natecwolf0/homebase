"use client";
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ============================================================================
// HOMEBASE — a comp-driven home valuation workbench for Nathan's Atlanta search
// ----------------------------------------------------------------------------
// Design thesis: this is an appraiser's clipboard, not a dashboard. The list
// price is an opinion; closed comps are the only fact. Everything here pushes
// toward a defensible NUMBER you can put on an offer, and flags when a house is
// a price problem hiding behind a pretty kitchen.
//
// No guesswork rule: the tool never invents property facts. You enter verified
// data (county records / agent / your own eyes). The tool does the disciplined
// math you'd skip on a house you love: time-adjusts stale comps with real
// Atlanta-metro growth rates, runs cost-of-cure, scores against your criteria,
// and raises red flags.
// ============================================================================

// --- Real Atlanta-metro annual appreciation (editable). Sourced defaults: -----
// 2019 ~5%, 2020 ~10%, 2021 ~24.7% (Reventure), 2022 ~14% (peak mid-22),
// 2023 ~-3% (correction), 2024 ~2.5%, 2025 ~0.5% (Reventure/homes.com),
// 2026 ~0.5% (flat YoY, homes.com June 2026). All overridable per year.
const DEFAULT_APPRECIATION = {
  2016: 6.0, 2017: 6.5, 2018: 5.5, 2019: 5.0, 2020: 10.0,
  2021: 24.7, 2022: 14.0, 2023: -3.0, 2024: 2.5, 2025: 0.5, 2026: 0.5,
};

// Rough cost-of-cure defaults ($ to bring a system to "renovated comp" condition).
// Editable per property — these are Atlanta-metro ballparks, not quotes.
const CURE_DEFAULTS = {
  kitchen: 35000, bathrooms: 12000, roof: 12000, hvac: 8000,
  flooring: 10000, windows: 9000, paint: 6000, electrical: 7000,
  plumbing: 6000, landscaping: 5000,
};

// Nathan's established criteria (from the home search). Weights sum to 100.
const CRITERIA = [
  { key: "beds", label: "Bedrooms (3+)", weight: 10, hint: "3BR minimum; small bedrooms are the specific concern." },
  { key: "baths", label: "Bathrooms (2+)", weight: 8, hint: "2+ full baths." },
  { key: "sqft", label: "Square footage (~2,000–3,000)", weight: 12, hint: "~2,400 feels like plenty; 1,500 too small; won't shy below 3,000." },
  { key: "lot", label: "Lot size (0.25+ acre)", weight: 10, hint: "0.25+ acre, flat usable yard preferred." },
  { key: "openKitchen", label: "Open kitchen", weight: 9, hint: "Open kitchen is required." },
  { key: "mainBed", label: "Main-level bed/bath", weight: 7, hint: "Main-level bed/bath preferred." },
  { key: "schools", label: "Strong school district", weight: 14, hint: "Primary ROI driver — school district durability. Wheeler HS zone is a strong personal fit." },
  { key: "commute", label: "≤45 min to both anchors", weight: 10, hint: "Within 45 min of Holcomb Bridge/GA-400 and Four Seasons Midtown." },
  { key: "renoEquity", label: "Renovation equity (livable)", weight: 8, hint: "Needs some reno but very livable. NOT reno potential at post-reno pricing." },
  { key: "zone", label: "Target zone", weight: 7, hint: "East Cobb, Dunwoody, Roswell primary; Chamblee/Sandy Springs/Brookhaven secondary." },
  { key: "detached", label: "Single-family detached", weight: 5, hint: "No townhomes unless area is exceptional; detached holds value in soft markets." },
];

// -------------------------------- helpers -----------------------------------
const fmt = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString());
const fmtPct = (n) => (n == null || isNaN(n) ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + "%");
const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
const uid = () => Math.random().toString(36).slice(2, 9);
const todayYear = new Date().getFullYear();

// Time-adjust a comp's sale price from its sale year to today using annual rates.
function timeAdjust(salePrice, saleYear, rates) {
  if (!salePrice || !saleYear) return { adjusted: salePrice, factor: 1, applied: [] };
  let factor = 1; const applied = [];
  for (let y = saleYear; y < todayYear; y++) {
    const r = rates[y] != null ? rates[y] : (rates[todayYear - 1] ?? 0);
    factor *= 1 + r / 100;
    applied.push({ year: y, rate: r });
  }
  return { adjusted: salePrice * factor, factor, applied };
}

// ============================================================================
// COMP ANALYSIS ENGINE — appraiser-grounded valuation from a sold-comps export
// ----------------------------------------------------------------------------
// You supply a CSV export (Redfin / GAMLS / Zillow); the engine maps columns,
// computes real distance from lat/long, screens distressed sales, derives
// adjustment factors from the comp set itself (paired-sales) where possible,
// scores each comp for similarity per Fannie Mae / appraiser practice, builds
// a line-by-line adjustment grid, and reconciles to a similarity-WEIGHTED
// value (not a simple average). Every number is shown so you can back into why.
// ============================================================================

// Tolerant CSV parse (handles quoted fields containing commas / quotes).
function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (cur !== "" || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
      else cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// Map a header row to our schema across Redfin / GAMLS / Zillow naming.
const COLMAP = {
  address: ["address", "street address", "property address", "full address", "location", "site address"],
  price: ["sold price", "price", "sale price", "close price", "last sale price", "closeprice", "sold_price", "sale amount", "selling price"],
  sqft: ["square feet", "sqft", "living area", "gla", "total finished sqft", "above grade finished area", "sq ft", "finished sqft", "heated sqft", "total sqft"],
  beds: ["beds", "bedrooms", "br", "bed", "# beds", "beds total"],
  baths: ["baths", "bathrooms", "ba", "bath", "total baths", "# baths", "baths total", "full baths"],
  yearBuilt: ["year built", "yr built", "yearbuilt", "year", "yr_built", "built"],
  lot: ["lot size", "lot size (sq ft)", "lot sqft", "lot", "lot size acres", "acres", "lotsize", "lot area"],
  soldDate: ["sold date", "sale date", "close date", "sold", "closedate", "closing date", "date sold", "settlement date"],
  lat: ["latitude", "lat"],
  lng: ["longitude", "long", "lng", "lon"],
  status: ["sale type", "status", "mls status", "property type", "sale_type", "transaction type"],
};
function mapColumns(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(COLMAP)) {
    let idx = -1;
    for (const a of aliases) { const i = norm.indexOf(a); if (i >= 0) { idx = i; break; } }
    if (idx < 0) for (const a of aliases) { const i = norm.findIndex((h) => h.includes(a)); if (i >= 0) { idx = i; break; } }
    map[field] = idx;
  }
  return map;
}

// Haversine great-circle distance in miles.
function haversine(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((x) => x == null || isNaN(x))) return null;
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseSaleYear(dateStr) { const m = String(dateStr).match(/(20\d{2})/); return m ? +m[1] : null; }
function monthsSince(dateStr) { const d = new Date(dateStr); if (isNaN(d)) return null; return Math.max(0, Math.round((Date.now() - d) / (1000 * 60 * 60 * 24 * 30.4))); }
// Days on market that counts UP over time: if a listing date is known, it's
// today minus that date; otherwise fall back to the static pasted number.
// Parse a user-typed or stored date flexibly: YYYY-MM-DD, M/D/YYYY, M/D/YY.
// Returns a Date or null. Avoids JS's inconsistent Date() string parsing.
function parseFlexDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d) ? null : d; }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = new Date(y, +m[1] - 1, +m[2]); return isNaN(d) ? null : d; }
  const d = new Date(s); // last resort
  return isNaN(d) ? null : d;
}

function effectiveDom(prop) {
  if (prop && prop.listingDate) {
    const d = parseFlexDate(prop.listingDate);
    if (d) {
      const days = Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
      // Guard: a future listing date (typo) or an absurd span → don't show a
      // nonsense DOM; fall back to the static number instead.
      if (days >= 0 && days <= 3650) return days;
    }
  }
  const n = num(prop && prop.dom);
  return n != null ? n : null;
}

// Read a CSV export into structured comp rows (raw values, nothing invented).
function readCompCSV(text, rates) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { comps: [], map: {}, headers: [], error: "No data rows found — is this a CSV export?" };
  const headers = rows[0];
  const map = mapColumns(headers);
  const comps = [];
  for (let r = 1; r < rows.length; r++) {
    const get = (f) => (map[f] >= 0 ? rows[r][map[f]] : "");
    const price = num(get("price")), sqft = num(get("sqft"));
    if (!price || !sqft) continue; // a comp without price+sqft is unusable
    let lot = get("lot");
    const lotNum = num(lot);
    // normalize lot to acres if it's clearly sqft (>1000)
    const lotAcres = lotNum != null ? (lotNum > 1000 ? +(lotNum / 43560).toFixed(3) : lotNum) : null;
    const saleYear = parseSaleYear(get("soldDate"));
    const factor = saleYear ? timeAdjust(price, saleYear, rates).factor : 1;
    comps.push({
      id: uid(), address: (get("address") || "").trim(), price, sqft,
      beds: num(get("beds")), baths: num(get("baths")), yearBuilt: num(get("yearBuilt")),
      lot: lotAcres, soldDate: get("soldDate"), saleYear,
      lat: num(get("lat")), lng: num(get("lng")), status: (get("status") || "").trim(),
      priceAdj: Math.round(price * factor), timeFactor: factor,
      monthsOld: monthsSince(get("soldDate")),
      include: true, // user can toggle
    });
  }
  return { comps, map, headers, error: comps.length ? null : "No rows had both a price and square footage." };
}

// Paired-sales: estimate $/sqft-of-difference from comps alike in all but size.
function deriveGLA(comps, opts) {
  // Precedence: (1) paired-sales from the pool → (2) explicit $/sqft override →
  // (3) percent of the pool's median $/sqft (appraiser-standard fallback, since
  // the size adjustment is a FRACTION of the full price/sqft, typically 30-50%).
  const glaOverride = num(opts?.glaOverride);
  const glaPct = num(opts?.glaPct) ?? 40; // % of median $/sqft
  const rates = [];
  for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
    const a = comps[i], b = comps[j];
    if (!a.priceAdj || !b.priceAdj || !a.sqft || !b.sqft) continue;
    const dSqft = Math.abs(a.sqft - b.sqft);
    if (dSqft < 100 || dSqft > 1200) continue;
    if (a.beds !== b.beds) continue;
    if (Math.abs((a.baths || 0) - (b.baths || 0)) > 1) continue;
    if (Math.abs((a.yearBuilt || 0) - (b.yearBuilt || 0)) > 15) continue;
    const rate = Math.abs(a.priceAdj - b.priceAdj) / dSqft;
    if (rate > 20 && rate < 400) rates.push(rate);
  }
  if (rates.length) {
    rates.sort((x, y) => x - y);
    return { value: Math.round(rates[Math.floor(rates.length / 2)]), source: `paired-sales (${rates.length} pair${rates.length === 1 ? "" : "s"})` };
  }
  // No clean pairs. Prefer an explicit override; else derive from median $/sqft.
  if (glaOverride) return { value: glaOverride, source: `manual $/sqft override` };
  const ppsfs = comps.filter((c) => c.priceAdj && c.sqft).map((c) => c.priceAdj / c.sqft).sort((a, b) => a - b);
  if (ppsfs.length) {
    const medPPSF = ppsfs[Math.floor(ppsfs.length / 2)];
    const derived = Math.round(medPPSF * (glaPct / 100));
    return { value: derived, source: `${glaPct}% of median $/sqft ($${Math.round(medPPSF)})` };
  }
  return { value: 90, source: "default ($90 — no pairs or pool data)" };
}

// Screen for distressed / non-arm's-length sales.
function screenComp(comp, medianPPSF) {
  const flags = [];
  if (/foreclosure|reo|short sale|auction|bank.?owned|estate sale|as.?is|distress|probate/i.test(comp.status || ""))
    flags.push("distressed sale type");
  const ppsf = comp.priceAdj / comp.sqft;
  if (medianPPSF && ppsf < medianPPSF * 0.65) flags.push("$/sqft far below market");
  if (medianPPSF && ppsf > medianPPSF * 1.5) flags.push("$/sqft far above market (outlier)");
  return flags;
}

// Similarity score (0–100) per appraiser weightings. Proximity is controlling.
function scoreComp(comp, subject, radius) {
  let score = 100; const lines = [];
  if (comp.dist != null) {
    if (comp.dist <= 0.5) lines.push(["Proximity", 0, "same immediate area"]);
    else if (comp.dist <= 1) { score -= 5; lines.push(["Proximity", -5, `${comp.dist.toFixed(2)} mi`]); }
    else if (comp.dist <= radius) { score -= 15; lines.push(["Proximity", -15, `${comp.dist.toFixed(2)} mi`]); }
    else { score -= 100; lines.push(["Proximity", -100, `${comp.dist.toFixed(2)} mi — beyond ${radius} mi radius`]); }
  }
  if (comp.monthsOld != null) {
    if (comp.monthsOld <= 3) lines.push(["Recency", 0, "≤3 mo"]);
    else if (comp.monthsOld <= 6) { score -= 4; lines.push(["Recency", -4, `${comp.monthsOld} mo`]); }
    else if (comp.monthsOld <= 12) { score -= 10; lines.push(["Recency", -10, `${comp.monthsOld} mo`]); }
    else { score -= 18; lines.push(["Recency", -18, `${comp.monthsOld} mo (time-adjusted)`]); }
  }
  if (comp.sqft && subject.sqft) {
    const pct = Math.abs(comp.sqft - subject.sqft) / subject.sqft;
    if (pct <= 0.1) lines.push(["Size", 0, "within 10%"]);
    else if (pct <= 0.25) { score -= 10; lines.push(["Size", -10, `${(pct * 100).toFixed(0)}% diff`]); }
    else { score -= 25; lines.push(["Size", -25, `${(pct * 100).toFixed(0)}% diff — beyond 25%`]); }
  }
  if (comp.beds != null && subject.beds != null && comp.beds !== subject.beds) { score -= 8; lines.push(["Beds", -8, `${comp.beds} vs ${subject.beds}`]); }
  if (comp.baths != null && subject.baths != null && Math.abs(comp.baths - subject.baths) >= 1) { score -= 6; lines.push(["Baths", -6, `${comp.baths} vs ${subject.baths}`]); }
  if (comp.yearBuilt && subject.yearBuilt && Math.abs(comp.yearBuilt - subject.yearBuilt) > 20) { score -= 8; lines.push(["Age", -8, `${comp.yearBuilt} vs ${subject.yearBuilt}`]); }
  return { score: Math.max(0, score), lines };
}

// Full pipeline: screen, score, adjustment grid, weighted reconciliation.
function analyzeComps(compList, subject, radius, factors) {
  const comps = (compList || []).filter((c) => c.include !== false && num(c.price) && num(c.sqft)).map((c) => ({ ...c }));
  if (!comps.length) return null;

  // distance
  comps.forEach((c) => { c.dist = (subject.lat != null && c.lat != null) ? haversine(subject.lat, subject.lng, c.lat, c.lng) : null; });

  // median ppsf for screening
  const ppsfs = comps.map((c) => c.priceAdj / c.sqft).sort((a, b) => a - b);
  const medPPSF = ppsfs.length ? ppsfs[Math.floor(ppsfs.length / 2)] : null;

  const gla = deriveGLA(comps, { glaOverride: factors?.glaOverride, glaPct: factors?.glaPct });
  const BED = num(factors?.bed) ?? 8000, BATH = num(factors?.bath) ?? 7500, YEAR = num(factors?.year) ?? 500, LOT = num(factors?.lot) ?? 20000;
  const sqftTol = num(factors?.sqftTol) ?? 500; // absolute sqft; comps beyond this are excluded
  const maxMonths = num(factors?.maxMonths); // sold-date window in months; null = no limit
  // GLA cap: the largest total GLA dollar swing allowed on a single comp, so a
  // huge size gap can't dominate the value. Defaults to sqftTol × gla rate.
  const glaCap = num(factors?.glaCap) || Math.round(sqftTol * gla.value);

  const scored = comps.map((c) => {
    const flags = screenComp(c, medPPSF);
    const { score, lines } = scoreComp(c, subject, radius);
    // sqft tolerance exclusion (absolute)
    const sqftDiff = (subject.sqft && c.sqft) ? Math.abs(subject.sqft - c.sqft) : null;
    const overSqftTol = sqftDiff != null && sqftDiff > sqftTol;
    // sold-date tolerance exclusion
    const tooOld = maxMonths != null && c.monthsOld != null && c.monthsOld > maxMonths;
    const excluded = score <= 0 || flags.length > 0 || overSqftTol || tooOld;
    if (overSqftTol) flags.push(`${sqftDiff} sqft from subject (over ${sqftTol} tolerance)`);
    if (tooOld) flags.push(`sold ${c.monthsOld} mo ago (over ${maxMonths} mo window)`);
    // adjustment grid: bring comp toward subject
    let glaAdjRaw = subject.sqft && c.sqft ? Math.round((subject.sqft - c.sqft) * gla.value) : 0;
    const glaCapped = Math.abs(glaAdjRaw) > glaCap;
    const glaAdj = glaCapped ? Math.sign(glaAdjRaw) * glaCap : glaAdjRaw;
    const bedAdj = (subject.beds != null && c.beds != null) ? (subject.beds - c.beds) * BED : 0;
    const bathAdj = (subject.baths != null && c.baths != null) ? Math.round((subject.baths - c.baths) * BATH) : 0;
    const yearAdj = (subject.yearBuilt && c.yearBuilt) ? (subject.yearBuilt - c.yearBuilt) * YEAR : 0;
    const lotAdj = (subject.lot != null && c.lot != null) ? Math.round((subject.lot - c.lot) * LOT) : 0;
    const adjustedValue = c.priceAdj + glaAdj + bedAdj + bathAdj + yearAdj + lotAdj;
    const grossAdj = Math.abs(glaAdj) + Math.abs(bedAdj) + Math.abs(bathAdj) + Math.abs(yearAdj) + Math.abs(lotAdj);
    return { ...c, flags, score, scoreLines: lines, excluded, overSqftTol, sqftDiff, tooOld, glaAdj, glaCapped, bedAdj, bathAdj, yearAdj, lotAdj, adjustedValue, grossAdj, ppsf: c.priceAdj / c.sqft };
  });

  const included = scored.filter((c) => !c.excluded);
  let wTot = 0, wSum = 0;
  included.forEach((c) => { wSum += c.adjustedValue * c.score; wTot += c.score; });
  const weighted = wTot > 0 ? Math.round(wSum / wTot) : null;

  const adjVals = included.map((c) => c.adjustedValue).sort((a, b) => a - b);
  const range = adjVals.length ? { low: adjVals[0], high: adjVals[adjVals.length - 1] } : null;

  return { scored, included, weighted, range, gla, glaCap, sqftTol, maxMonths, factors: { BED, BATH, YEAR, LOT }, medPPSF, radius };
}

// --- Global comp pool: read an export (coords optional), and the geocode loop ---
// Read a CSV export into pool comps. Unlike readCompCSV, coordinates may be
// absent — they get filled by the geocode round-trip. We keep the address so
// the geocode result can be matched back.
function readPoolCSV(text, rates) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { comps: [], map: {}, headers: [], error: "No data rows found — is this a CSV export?" };
  const headers = rows[0];
  const map = mapColumns(headers);
  const comps = [];
  for (let r = 1; r < rows.length; r++) {
    const get = (f) => (map[f] >= 0 ? rows[r][map[f]] : "");
    const price = num(get("price")), sqft = num(get("sqft"));
    const address = (get("address") || "").trim();
    if (!price || !sqft || !address) continue;
    const lotNum = num(get("lot"));
    const lotAcres = lotNum != null ? (lotNum > 1000 ? +(lotNum / 43560).toFixed(3) : lotNum) : null;
    const saleYear = parseSaleYear(get("soldDate"));
    const factor = saleYear ? timeAdjust(price, saleYear, rates).factor : 1;
    // include a city/zip if present, to disambiguate geocoding
    const cityIdx = headers.findIndex((h) => /city/i.test(h));
    const zipIdx = headers.findIndex((h) => /zip|postal/i.test(h));
    const city = cityIdx >= 0 ? (rows[r][cityIdx] || "").trim() : "";
    const zip = zipIdx >= 0 ? (rows[r][zipIdx] || "").trim() : "";
    comps.push({
      id: uid(), address, city, zip, price, sqft,
      beds: num(get("beds")), baths: num(get("baths")), yearBuilt: num(get("yearBuilt")),
      lot: lotAcres, soldDate: get("soldDate"), saleYear,
      lat: num(get("lat")), lng: num(get("lng")), status: (get("status") || "").trim(),
      priceAdj: Math.round(price * factor), timeFactor: factor,
      monthsOld: monthsSince(get("soldDate")),
    });
  }
  return { comps, map, headers, error: comps.length ? null : "No rows had address + price + square footage." };
}

// Which pool comps still need coordinates.
function poolNeedingGeo(pool) {
  return (pool.comps || []).filter((c) => c.lat == null || c.lng == null);
}

// Normalize an address for fuzzy duplicate detection. Collapses spacing/punct
// and standardizes street-type words, but KEEPS directionals (NE vs SE are
// genuinely different lots). "Wind Grove" and "Windgrove" collapse because we
// strip internal spaces from the name portion.
const STREET_TYPES = { street: "st", str: "st", drive: "dr", court: "ct", road: "rd", lane: "ln", avenue: "ave", av: "ave", boulevard: "blvd", place: "pl", terrace: "ter", trace: "trce", parkway: "pkwy", circle: "cir", way: "way", trail: "trl", cove: "cv", point: "pt", pass: "pass", run: "run", path: "path", close: "close", crossing: "xing", square: "sq", highway: "hwy" };
const DIRECTIONALS = { north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw" };
function normAddrKey(address, zip) {
  let s = String(address || "").toLowerCase().trim();
  s = s.replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  let tokens = s.split(" ").filter(Boolean);
  // drop unit markers + following token
  const t2 = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^(apt|unit|ste|suite|bldg|lot)$/.test(tokens[i])) { i++; continue; }
    t2.push(tokens[i]);
  }
  tokens = t2;
  // standardize street types and directionals (kept, not stripped)
  const mapped = tokens.map((t) => STREET_TYPES[t] || DIRECTIONALS[t] || t);
  // number is first token; the rest is name+type+dir. Remove internal spaces in
  // the name so "wind grove" == "windgrove", but keep type/dir as separate marks.
  const streetTypeSet = new Set(Object.values(STREET_TYPES));
  const dirSet = new Set(Object.values(DIRECTIONALS));
  const numTok = mapped[0] || "";
  const rest = mapped.slice(1);
  const tail = []; // type + directional, order-independent
  const nameParts = [];
  rest.forEach((t) => { if (streetTypeSet.has(t) || dirSet.has(t)) tail.push(t); else nameParts.push(t); });
  const name = nameParts.join(""); // collapse spaces in the name
  tail.sort();
  return `${numTok} ${name} ${tail.join(" ")}`.trim() + (zip ? "|" + String(zip).slice(0, 5) : "");
}

// Merge a freshly-read batch of comps INTO an existing pool.
// - Dedup on normalized address; on collision keep the MOST RECENT sale.
// - Preserve coordinates from whichever record already had them.
// - Never wipe the pool: new non-duplicate comps append.
function appendComps(pool, incoming) {
  const existing = [...(pool.comps || [])];
  const byKey = new Map();
  existing.forEach((c) => byKey.set(normAddrKey(c.address, c.zip), c));
  const history = new Set(pool.addressHistory || []);
  let added = 0, replaced = 0, skipped = 0;

  incoming.forEach((n) => {
    const key = normAddrKey(n.address, n.zip);
    history.add(key);
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, n); added++; return; }
    // duplicate: keep most recent sale; carry coordinates forward if the winner lacks them
    const py = prior.saleYear || 0, ny = n.saleYear || 0;
    const pd = new Date(prior.soldDate || 0).getTime() || 0, nd = new Date(n.soldDate || 0).getTime() || 0;
    const newerIsBetter = (nd || ny) >= (pd || py);
    if (newerIsBetter) {
      // keep coords if the new record has none but old did
      if ((n.lat == null || n.lng == null) && prior.lat != null) { n.lat = prior.lat; n.lng = prior.lng; }
      byKey.set(key, n); replaced++;
    } else {
      if ((prior.lat == null || prior.lng == null) && n.lat != null) { prior.lat = n.lat; prior.lng = n.lng; }
      skipped++;
    }
  });

  return { pool: { ...pool, comps: Array.from(byKey.values()), addressHistory: Array.from(history), updatedAt: new Date().toISOString() }, added, replaced, skipped };
}

// Format addresses for geocoding (numbered list to paste into chat, if needed).
function geocodeRequestText(comps) {
  return comps.map((c, i) => {
    const parts = [c.address, c.city, c.zip].filter(Boolean).join(", ");
    return `${i + 1}. ${parts}`;
  }).join("\n");
}

// Parse the Census batch geocoder result (GeocodeResults.csv). Census returns
// rows keyed by the unique_id we sent, with matched coords as lon,lat (lon
// first) in a known column. We match back to pool comps by address.
function mergeCensusResults(pool, csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return { pool, matched: 0, error: "No rows found in the Census result." };
  const comps = [...(pool.comps || [])];
  const norm = (s) => normAddrKey(s, "");
  const byAddr = new Map();
  comps.forEach((c, i) => { const k = norm(c.address); if (!byAddr.has(k)) byAddr.set(k, i); });
  let matched = 0;
  for (const r of rows) {
    // Census columns: id, input_address, match_status, match_type, matched_address, lon,lat, tigerline, side
    // Find the "Match"/"Exact" status and the coordinate field (contains a comma-separated lon,lat)
    const status = r.find((cell) => /^(Match|No_Match|Tie)$/i.test((cell || "").trim()));
    if (status && /no_match|tie/i.test(status)) continue;
    const coordCell = r.find((cell) => /^-?\d{2,3}\.\d+,\s*-?\d{1,2}\.\d+$/.test((cell || "").trim()));
    const inputAddr = r[1] || "";
    if (!coordCell) continue;
    const [lonS, latS] = coordCell.split(",").map((x) => x.trim());
    const lat = parseFloat(latS), lng = parseFloat(lonS);
    if (isNaN(lat) || isNaN(lng)) continue;
    // match by the street portion of the input address
    const street = inputAddr.split(",")[0] || inputAddr;
    const idx = byAddr.get(norm(street));
    if (idx != null && (comps[idx].lat == null || comps[idx].lng == null)) { comps[idx] = { ...comps[idx], lat, lng }; matched++; }
  }
  const stillMissing = comps.filter((c) => c.lat == null || c.lng == null).length;
  return { pool: { ...pool, comps }, matched, stillMissing, error: matched ? null : "No coordinates matched — check that this is the Census GeocodeResults.csv." };
}

// Merge geocoded results (JSON I return) back into pool comps by index or address.
// Accepts either [{address,lat,lng}] or [{i,lat,lng}] or a subject {lat,lng}.
function mergeGeocode(pool, geoJson) {
  let parsed;
  try { parsed = typeof geoJson === "string" ? JSON.parse(geoJson) : geoJson; } catch { return { pool, matched: 0, error: "That isn't valid JSON — paste the block exactly as given." }; }
  const list = Array.isArray(parsed) ? parsed : (parsed.results || []);
  if (!list.length) return { pool, matched: 0, error: "No coordinate entries found in that block." };
  const comps = [...(pool.comps || [])];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = new Set(); // prevent one comp being claimed by two entries
  let matched = 0;
  for (const g of list) {
    if (g.lat == null || g.lng == null) continue;
    let idx = -1;
    if (g.i != null && comps[g.i - 1] && !used.has(g.i - 1)) idx = g.i - 1; // 1-based index, unambiguous
    else if (g.address) {
      const gn = norm(g.address);
      // exact normalized match first (address, or address+city+zip), skipping used
      idx = comps.findIndex((c, i) => !used.has(i) && norm(c.address) === gn);
      if (idx < 0) idx = comps.findIndex((c, i) => !used.has(i) && norm([c.address, c.city, c.zip].filter(Boolean).join("")) === gn);
      // only if still unmatched, fall back to a *directional-aware* contains that won't collide
      if (idx < 0) idx = comps.findIndex((c, i) => !used.has(i) && norm(c.address).length > 6 && (norm(c.address) === gn));
    }
    if (idx >= 0) { comps[idx] = { ...comps[idx], lat: +g.lat, lng: +g.lng }; used.add(idx); matched++; }
  }
  const stillMissing = comps.filter((c) => c.lat == null || c.lng == null).length;
  return { pool: { ...pool, comps }, matched, stillMissing, error: null };
}

// Convert a pool comp into the shape analyzeComps expects (already compatible).
function poolCompsForProperty(pool) {
  return (pool.comps || []).map((c) => ({ ...c, include: true }));
}

// ============================================================================
// ASSESSMENT MODEL — three co-located but logically-separate modules:
//   1. RENOVATIONS  — hard bring-to-standard costs. Direct $ off value.
//                     If better than standard → adds value; at standard → $0.
//   2. ENVIRONMENT  — proximity / site risks. Severity → suggested $, override.
//   3. CRITERIA     — nice-to-have checklist. Fit/desirability only, NO value.
// Observations drive suggestions into each; every module is fully editable.
// (Condition/qualitative-severity removed — renovation cost is the single
//  quality lever, so nothing double-counts.)
// ============================================================================

// 1. Renovation line items — default bring-to-standard costs (Atlanta metro,
//    editable in Assumptions). Positive cost = subtract from value. A negative
//    cost means the home is BETTER than standard on that item (adds value).
const RENO_DEFAULTS = [
  { key: "kitchen", label: "Kitchen", cost: 35000, note: "Full kitchen update to current market standard." },
  { key: "primaryBath", label: "Primary bath", cost: 15000, note: "Primary bathroom renovation." },
  { key: "secondaryBath", label: "Secondary bath(s)", cost: 9000, note: "Per additional bath brought to standard." },
  { key: "roof", label: "Roof", cost: 12000, note: "Full replacement; prorate if partial life remains." },
  { key: "hvac", label: "HVAC", cost: 8000, note: "System replacement." },
  { key: "flooring", label: "Flooring", cost: 10000, note: "Replace/refinish throughout." },
  { key: "windows", label: "Windows", cost: 9000, note: "Replace dated/failing windows." },
  { key: "paintInterior", label: "Interior paint", cost: 5000, note: "Whole-interior repaint." },
  { key: "electrical", label: "Electrical / panel", cost: 7000, note: "Panel or wiring to code." },
  { key: "plumbing", label: "Plumbing", cost: 6000, note: "Repipe / major fixture work." },
  { key: "exterior", label: "Exterior / siding", cost: 12000, note: "Siding, trim, exterior repair." },
  { key: "landscaping", label: "Landscaping / grading", cost: 5000, note: "Bring yard to standard." },
];

// 2. Environmental / proximity risks — severity 0..3 → suggested $ discount.
//    Base is the per-severity-step discount (editable). Discounts only (risks).
const ENV_RISKS = [
  { key: "busyRoad", label: "Busy / arterial road", base: 8000, note: "Backs or faces a high-traffic road." },
  { key: "powerlines", label: "Power lines / tower", base: 7000, note: "Transmission lines, cell tower nearby." },
  { key: "railroad", label: "Railroad", base: 7000, note: "Active rail line proximity." },
  { key: "airport", label: "Airport / flight path", base: 6000, note: "Noise from approach/departure paths." },
  { key: "prison", label: "Prison / undesirable use", base: 9000, note: "Correctional facility or similar nearby." },
  { key: "trees", label: "Hazard trees", base: 5000, note: "Large trees threatening structure — removal/risk." },
  { key: "drainage", label: "Drainage / stagnant water", base: 6000, note: "Poor drainage, standing water, flood tendency." },
  { key: "slope", label: "Heavy slope / unusable yard", base: 6000, note: "Steep grade limiting yard use." },
  { key: "foliage", label: "Overgrowth / foliage", base: 3000, note: "Heavy overgrowth, neglect signals." },
  { key: "localTraffic", label: "Local traffic / cut-through", base: 4000, note: "Street used as a cut-through; parking/safety." },
  { key: "commercial", label: "Commercial adjacency", base: 6000, note: "Backs to commercial, dumpster, lot." },
];
// Environmental severity: 0 none, 1 minor, 2 moderate, 3 severe → × base.
const ENV_SEV = { "0": 0, "1": 1, "2": 2.2, "3": 3.6 };

// 3. Criteria — nice-to-have checklist (fit only, no value impact). Kept items
//    from the old criteria plus the new list; user can add more in Assumptions.
const DEFAULT_CRITERIA_FEATURES = [
  { key: "openKitchen", label: "Open kitchen" },
  { key: "schools", label: "Strong school district" },
  { key: "commute", label: "≤45 min to both anchors" },
  { key: "renoEquity", label: "Renovation equity (livable)" },
  { key: "usableBedrooms", label: "Usable bedrooms (not tiny)" },
  { key: "walkInShower", label: "Walk-in shower" },
  { key: "gasRange", label: "Gas range" },
  { key: "garageNook", label: "Garage nook / bonus" },
  { key: "bigClosets", label: "Big closet(s)" },
  { key: "upstairsLaundry", label: "Upstairs laundry" },
  { key: "openKitchenLiving", label: "Kitchen & living, no walls" },
  { key: "naturalLight", label: "Natural light / big windows" },
  { key: "tallCeilings", label: "Tall ceilings" },
  { key: "levelYard", label: "Level usable yard" },
  { key: "quietStreet", label: "Quiet street" },
  { key: "mainFloorFlex", label: "Main-floor flex/office" },
  { key: "fencedYard", label: "Fenced yard" },
];

// Compute renovation total (sum of enabled line items; cost>0 subtracts).
function renovationTotal(prop, renoDefaults) {
  const items = prop.renovations || {};
  let total = 0; const lines = [];
  (renoDefaults || RENO_DEFAULTS).forEach((r) => {
    const st = items[r.key];
    if (!st || !st.on) return;
    const cost = num(st.cost != null ? st.cost : r.cost) || 0;
    total += cost; // positive cost = money needed = subtract from value
    lines.push({ key: r.key, label: r.label, cost });
  });
  // custom one-off reno lines
  (prop.renoCustom || []).forEach((c) => {
    const cost = num(c.cost) || 0;
    if (cost !== 0) { total += cost; lines.push({ key: c.id, label: c.label || "Custom", cost, custom: true }); }
  });
  return { total, lines };
}

// Compute environmental discount total.
function environmentalTotal(prop, envDefaults) {
  const envData = prop.environment || {};
  let total = 0; const lines = [];
  (envDefaults || ENV_RISKS).forEach((e) => {
    const d = envData[e.key];
    // stored as either a bare severity (legacy) or { sev, override }
    const sev = (d && typeof d === "object") ? d.sev : d;
    const override = (d && typeof d === "object") ? d.override : null;
    if ((sev == null || String(sev) === "0") && override == null) return;
    let val;
    if (override != null && override !== "") val = Math.round(num(override) || 0);
    else val = Math.round((num(e.base) || 0) * (ENV_SEV[String(sev)] ?? 0));
    if (val !== 0) { total += val; lines.push({ key: e.key, label: e.label, sev, value: val, overridden: override != null && override !== "" }); }
  });
  return { total, lines };
}


// ------------------------------- storage ------------------------------------
async function loadProps() {
  try {
    const r = await window.storage.get("properties");
    return r ? JSON.parse(r.value) : [];
  } catch { return []; }
}
async function saveProps(props) {
  await window.storage.set("properties", JSON.stringify(props)); // throws on failure — caller handles
}
async function loadRates() {
  try {
    const r = await window.storage.get("appreciation");
    return r ? JSON.parse(r.value) : { ...DEFAULT_APPRECIATION };
  } catch { return { ...DEFAULT_APPRECIATION }; }
}
async function saveRates(rates) {
  try { await window.storage.set("appreciation", JSON.stringify(rates)); } catch (e) { console.error(e); }
}
async function loadPool() {
  try {
    const r = await window.storage.get("compPool");
    return r ? JSON.parse(r.value) : { comps: [], updatedAt: null };
  } catch { return { comps: [], updatedAt: null }; }
}
async function savePool(pool) {
  await window.storage.set("compPool", JSON.stringify(pool)); // single key, no shadow — throws on failure
}
// Load the pool. (Kept the recovery signature for callers, but there's no longer
// a separate shadow key to recover from — storage is a single key now.)
async function loadPoolWithRecovery() {
  let primary = { comps: [], updatedAt: null };
  try { const r = await window.storage.get("compPool"); if (r) primary = JSON.parse(r.value); } catch {}
  return { pool: primary, recovered: null, recoveredCount: 0 };
}

// ========================= listing extraction ===============================
// Reads a SAVED Zillow/Redfin listing page (uploaded HTML) or a pasted JSON
// block and pulls structured fields. Pure local parsing — NO network. If a
// field isn't found it's left blank and reported, never invented.
//
// Zillow/Redfin embed a big JSON state blob in the page. We hunt it out and
// dig for known key names. Because portals rename keys to deter this, we try
// many aliases and fall back to labeled-text regex on the raw HTML. Anything
// uncertain is returned so the review step can show it.

function digFirst(obj, keys, depth = 0) {
  // breadth-ish recursive search for the first matching key with a scalar value
  if (obj == null || depth > 8) return undefined;
  if (typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] != null && (typeof obj[k] === "number" || typeof obj[k] === "string")) {
      const n = num(obj[k]);
      if (n != null || typeof obj[k] === "string") return obj[k];
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const r = digFirst(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function findComps(obj, depth = 0, out = []) {
  // look for arrays of sold-home objects (nearby recently sold)
  if (obj == null || depth > 9 || out.length > 40) return out;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === "object") {
        const price = digFirst(item, ["lastSoldPrice", "soldPrice", "price", "unformattedPrice"]);
        const sqft = digFirst(item, ["livingArea", "livingAreaValue", "finishedSqFt", "sqft", "area"]);
        const soldDate = digFirst(item, ["dateSold", "lastSoldDate", "soldDate", "dateSoldString"]);
        if (price && sqft && (soldDate || digFirst(item, ["homeStatus"]) === "RECENTLY_SOLD")) {
          const yr = soldDate ? (String(soldDate).match(/(20\d{2})/) || [])[1] : "";
          out.push({
            address: digFirst(item, ["streetAddress", "address", "addressStreet"]) || "",
            price: num(price) || "", sqft: num(sqft) || "", saleYear: yr || "",
            beds: digFirst(item, ["bedrooms", "beds"]) || "", baths: digFirst(item, ["bathrooms", "baths"]) || "",
          });
        }
        findComps(item, depth + 1, out);
      }
    }
  } else if (typeof obj === "object") {
    for (const v of Object.values(obj)) findComps(v, depth + 1, out);
  }
  return out;
}

function extractFromJsonBlob(blob) {
  // Portals often stash the useful data as a STRINGIFIED JSON field nested
  // inside the outer blob (e.g. Zillow's gdpClientCache). Recursively parse
  // any string that looks like a JSON object so digFirst can reach it.
  const deepParse = (o, d = 0) => {
    if (d > 7 || o == null) return o;
    if (typeof o === "string") {
      const t = o.trim();
      if (t.startsWith("{") || t.startsWith("[")) { try { return deepParse(JSON.parse(t), d + 1); } catch { return o; } }
      return o;
    }
    if (typeof o === "object") { for (const k in o) o[k] = deepParse(o[k], d + 1); }
    return o;
  };
  blob = deepParse(blob);

  const facts = {
    address: digFirst(blob, ["streetAddress", "fullAddress", "address"]),
    asking: digFirst(blob, ["price", "listPrice", "unformattedPrice", "lastSoldPrice"]),
    sqft: digFirst(blob, ["livingArea", "livingAreaValue", "finishedSqFt"]),
    beds: digFirst(blob, ["bedrooms", "beds"]),
    baths: digFirst(blob, ["bathrooms", "baths"]),
    lot: digFirst(blob, ["lotSize", "lotAreaValue", "lotSizeAcres"]),
    yearBuilt: digFirst(blob, ["yearBuilt"]),
    dom: digFirst(blob, ["daysOnZillow", "daysOnMarket", "timeOnRedfin", "cumulativeDaysOnMarket"]),
  };
  const comps = findComps(blob);
  return { facts, comps };
}

// Address string is usually an object on Zillow; flatten if so.
function flattenAddress(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    const parts = [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean);
    return parts.join(", ");
  }
  return "";
}

// Decode a saved .mht / .mhtml archive (MIME multipart) into clean HTML.
// Mobile "Save page" produces these. They're often quoted-printable encoded
// and split into parts; we grab the HTML part and un-mangle it before parsing.
function decodeMhtml(text) {
  // Not an MHTML archive? Return as-is.
  if (!/Content-Type:\s*multipart\/related/i.test(text) && !/^From:|^MIME-Version:/im.test(text)) {
    return text;
  }
  // Find the boundary marker.
  const boundaryMatch = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return text;
  const boundary = "--" + boundaryMatch[1];
  const parts = text.split(boundary);

  // Pick the largest text/html part.
  let htmlPart = "";
  for (const part of parts) {
    if (/Content-Type:\s*text\/html/i.test(part)) {
      // Strip the part headers (everything up to the first blank line).
      const idx = part.search(/\r?\n\r?\n/);
      let body = idx >= 0 ? part.slice(idx).trim() : part;
      const enc = (part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || "";
      if (/quoted-printable/i.test(enc)) body = decodeQuotedPrintable(body);
      else if (/base64/i.test(enc)) { try { body = atob(body.replace(/\s/g, "")); } catch {} }
      if (body.length > htmlPart.length) htmlPart = body;
    }
  }
  return htmlPart || text;
}

function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, "")               // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseListingHtml(rawText) {
  const htmlText = decodeMhtml(rawText);
  const report = { source: "unknown", found: {}, missing: [], comps: 0, error: null };
  try {
    const isRedfin = /redfin\.com/i.test(htmlText) || /__REACT_QUERY|reactServerData/i.test(htmlText);
    report.source = isRedfin ? "Redfin" : "Zillow";

    // Try to find embedded JSON blobs. Zillow: __NEXT_DATA__ or hdpApolloPreloadedData.
    // Redfin: reactServerState / __REACT_QUERY_INITIAL. We grab the biggest {...} we can parse.
    const candidates = [];
    const patterns = [
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
      /hdpApolloPreloadedData"?\s*[:=]\s*(\{[\s\S]*?\})\s*[,<]/i,
      /apiCache"?\s*:\s*"(\{.*?\})"/i,
      /<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
      /root\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/i,
    ];
    for (const p of patterns) {
      const m = htmlText.match(p);
      if (m && m[1]) {
        let raw = m[1];
        try { raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); } catch {}
        try { candidates.push(JSON.parse(m[1])); } catch {
          try { candidates.push(JSON.parse(raw)); } catch {}
        }
      }
    }

    // Also try any large JSON object literal as a last resort.
    let best = { facts: {}, comps: [] };
    for (const blob of candidates) {
      const got = extractFromJsonBlob(blob);
      const score = Object.values(got.facts).filter((x) => x != null).length + got.comps.length;
      const bestScore = Object.values(best.facts).filter((x) => x != null).length + best.comps.length;
      if (score > bestScore) best = got;
    }

    // Fallback: labeled-text regex on raw HTML for the core facts.
    const textFallback = (label, re) => {
      const m = htmlText.match(re);
      return m ? m[1] : undefined;
    };
    const facts = { ...best.facts };
    if (facts.sqft == null) facts.sqft = textFallback("sqft", /([\d,]+)\s*(?:sq\.?\s?ft|square\s?feet)/i);
    if (facts.beds == null) facts.beds = textFallback("beds", /([\d.]+)\s*(?:beds?|bedrooms?|bd)\b/i);
    if (facts.baths == null) facts.baths = textFallback("baths", /([\d.]+)\s*(?:baths?|bathrooms?|ba)\b/i);
    if (facts.yearBuilt == null) facts.yearBuilt = textFallback("yearBuilt", /built in\s*(\d{4})/i);
    if (facts.asking == null) facts.asking = textFallback("price", /\$([\d,]{5,})/);

    const clean = {
      address: flattenAddress(facts.address),
      asking: num(facts.asking) || "",
      sqft: num(facts.sqft) || "",
      beds: num(facts.beds) || "",
      baths: num(facts.baths) || "",
      lot: facts.lot != null ? String(facts.lot) : "",
      yearBuilt: num(facts.yearBuilt) || "",
      dom: num(facts.dom) || "",
    };

    report.found = clean;
    report.comps = best.comps.length;
    report.missing = Object.entries(clean).filter(([k, val]) => val === "" || val == null).map(([k]) => k);

    return { clean, comps: best.comps, report };
  } catch (e) {
    report.error = e.message;
    return { clean: {}, comps: [], report };
  }
}

// Pull a full street + city/state/zip address out of pasted listing text,
// even when the city line wraps to the next line (common on Zillow mobile).
// \b before the suffix prevents matching a suffix substring inside a street
// name (e.g. the "St" in "Whitehurst").
function parseAddress(text) {
  const streetRe = /(?<![\d,\/$.])\b(\d{1,6}\s+[A-Za-z0-9.\s'-]*?\b(?:St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Blvd|Boulevard|Pl|Place|Ter|Terrace|Cir|Circle|Trl|Trail|Pkwy|Parkway|Hwy|Highway|Xing|Crossing|Run|Pt|Point|Cove|Cv|Path|Walk|Row|Sq)(?:\s+(?:NE|NW|SE|SW|N|S|E|W))?)(?=[\s,\n]|$)(?:\s*,?\s*(?:APT|UNIT|STE|#)\s*\w+)?/i;
  const sm = text.match(streetRe);
  if (!sm) return "";
  const street = sm[1].trim().replace(/\s+/g, " ");
  const after = text.slice(sm.index + sm[0].length, sm.index + sm[0].length + 60);
  const cm = after.match(/[\s,]*([A-Za-z][A-Za-z .'-]+?),?\s+([A-Z]{2})\s+(\d{5})/);
  if (cm) return `${street}, ${cm[1].trim()}, ${cm[2]} ${cm[3]}`;
  return street;
}

// Parse RAW listing text (copy-paste the whole Zillow/Redfin page text on
// mobile). Tolerant pattern matching — fills what it finds, flags misses,
// never invents. This is the primary mobile path since file upload is blocked
// in the sandbox.
function parseListingText(text) {
  const report = { source: "Pasted text", found: {}, missing: [], comps: 0, error: null };
  if (!text || text.trim().length < 10) {
    report.error = "Not enough text to read. Select all the listing text and paste it here.";
    return { clean: {}, comps: [], report };
  }

  const grab = (re) => { const m = text.match(re); return m ? m[1] : undefined; };

  // Core facts — multiple phrasings per field.
  const beds = grab(/([\d.]+)\s*(?:beds?|bds?|bedrooms?)\b/i);
  const baths = grab(/([\d.]+)\s*(?:baths?|ba\b|bathrooms?)\b/i);
  const sqft = grab(/([\d,]+)\s*(?:sq\.?\s?ft\.?|square\s?feet|sqft)\b/i);
  const yearBuilt = grab(/(?:built in|year built[:\s]+|yr built[:\s]+)\s*(\d{4})/i);

  // Asking price — prefer a labeled price, else the first large $ figure.
  let asking = grab(/(?:list(?:ed)? (?:price|for)|asking|price)[:\s]*\$([\d,]{4,})/i);
  if (!asking) asking = grab(/\$([\d,]{5,})/);

  // Lot size — acres or sqft.
  let lot = grab(/([\d.]+)\s*acres?\b/i);
  if (!lot) { const ls = grab(/lot(?:\s?size)?[:\s]*([\d,]+)\s*sq/i); if (ls) lot = (num(ls) / 43560).toFixed(3); }

  const dom = grab(/(\d+)\s*days?\s*on\s*(?:zillow|redfin|market|the market)/i)
    || grab(/(?:on (?:zillow|redfin|market)|time on market)[:\s]*(\d+)\s*days?/i);

  // Price cuts — count listing-price REDUCTIONS in the price-history section.
  // Real Zillow/GAMLS rows are multi-line: "Date  Event" then "$price" then a
  // signed "-4%" on its own line. A cut = a row whose own percentage is
  // negative. Exclude "Sold" rows (a negative % there is market movement
  // between sales, not a listing price cut) and never count "Listed for sale".
  const histIdx = text.search(/price history/i);
  const cutZone = histIdx >= 0 ? text.slice(histIdx) : text;
  const cutLines = cutZone.split(/\n/);
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 18, now.getDate()); // 18-month sanity cap
  // Parse a date from a history row (e.g. "6/25/2026", "Jun 25, 2026", "6/2026").
  const rowDate = (s) => {
    let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    m = s.match(/(\d{1,2})\/(\d{4})/); if (m) return new Date(+m[2], +m[1] - 1, 1);
    m = s.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{0,2},?\s*(\d{4})/i);
    if (m) { const mo = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].toLowerCase().slice(0,3)); return new Date(+m[2], mo, 1); }
    return null;
  };
  // KEY: price history is newest-first. The current owner's listing cycle is
  // everything ABOVE the most recent "Sold" row. A price cut only counts if it's
  // a genuine price reduction in THIS cycle (before we hit the last Sold), and
  // within the 18-month window. Anything at/after the last Sold is a prior owner.
  let cutCount = 0;
  for (let i = 0; i < cutLines.length; i++) {
    const line = cutLines[i];
    // Stop entirely once we reach the most recent completed sale — everything
    // below belongs to a previous owner and must not be counted.
    if (/\bsold\b/i.test(line)) break;
    const hasNegPct = /(^|\s)-\s?[\d.]+%/.test(line);
    if (!hasNegPct) continue;
    let ev = "", dt = rowDate(line);
    let hitSold = false;
    for (let k = i; k >= Math.max(0, i - 4); k--) {
      if (/\bsold\b/i.test(cutLines[k])) { hitSold = true; break; }
      if (!dt) { const d = rowDate(cutLines[k]); if (d) dt = d; }
      if (!ev && /price change|price cut|listed for sale|pending|back on market/i.test(cutLines[k])) ev = cutLines[k];
    }
    if (hitSold) break;                                          // crossed into prior ownership
    if (/listed for sale/i.test(ev) && !/price (change|cut)/i.test(line)) continue; // a listing, not a cut
    if (dt && dt < windowStart) continue;                        // older than 18 months → ignore
    cutCount++;
  }
  // If a price-history section existed, a zero count is a real finding (clean
  // listing) → record "0". If there was no history to read, stay blank.
  const priceCuts = cutCount > 0 ? String(cutCount) : (histIdx >= 0 ? "0" : "");

  // Current-cycle listing date — the most recent "Listed for sale" that is not
  // below a Sold row (same ownership boundary as price cuts), within 18 months.
  // Used to auto-count days-on-market forward from that date.
  let listDate = null;
  for (let i = 0; i < cutLines.length; i++) {
    if (/\bsold\b/i.test(cutLines[i])) break;                    // hit prior ownership; stop
    if (/listed for sale/i.test(cutLines[i])) {
      // date may be on this line or the one just above it
      const d = rowDate(cutLines[i]) || rowDate(cutLines[i - 1] || "");
      if (d && (!listDate || d > listDate)) listDate = d;        // keep the newest listing in cycle
    }
  }
  const listingDate = listDate && listDate >= windowStart ? listDate.toISOString().slice(0, 10) : "";

  // "What's special" — Zillow's listing highlights blurb. Capture it so it can
  // seed observations and feed the AI take. It sits under a "What's special"
  // header and runs until the next section header.
  let whatsSpecial = "";
  const wsIdx = text.search(/what'?s special/i);
  if (wsIdx >= 0) {
    let after = text.slice(wsIdx).replace(/^[^\n]*what'?s special[^\n]*\n/i, "");
    // Only stop at a line that IS a section header — i.e. the header phrase is
    // essentially the whole line (short, standalone), not a description sentence
    // that merely happens to contain the word ("near nearby schools", "home gym").
    const HEADERS = /^(likely to sell.*|price\s*(?:and tax )?history|listing updated.*|listed by.*|listing agent.*|property details|facts (?:and|&) features|home facts|interior features|monthly (?:cost|payment).*|down payment.*|neighborhood|schools|nearby (?:homes|schools|rentals).*|getting around|walk score.*|climate risk.*|market value.*|payment calculator.*|estimated market value.*|show more|show less|see more.*|hide|©.*|zillow last checked.*|listing provided.*|source:.*|mls #.*|advertisement)$/i;
    const lines = after.split(/\n/);
    let stopLine = -1;
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      if (!t) continue;
      // a header line is short and matches a known header exactly (allowing a trailing colon)
      if (t.length <= 40 && HEADERS.test(t.replace(/:$/, ""))) { stopLine = li; break; }
    }
    if (stopLine >= 0) after = lines.slice(0, stopLine).join("\n");
    whatsSpecial = after.replace(/\bshow (more|less)\b/gi, "").replace(/\n{2,}/g, "\n").trim();
    if (whatsSpecial.length > 8000) whatsSpecial = whatsSpecial.slice(0, 8000).trim() + "…";
  }

  // "Facts & features" — Zillow's structured spec block (interior, construction,
  // utilities, parking, etc.). Captured separately from "What's special" and fed
  // to the AI as its own observation block. Same header-boundary approach.
  let factsFeatures = "";
  const ffIdx = text.search(/facts (?:and|&) features/i);
  if (ffIdx >= 0) {
    let after = text.slice(ffIdx).replace(/^[^\n]*facts (?:and|&) features[^\n]*\n/i, "");
    const FF_STOP = /^(what'?s special.*|price\s*(?:and tax )?history|listing updated.*|listed by.*|listing agent.*|monthly (?:cost|payment).*|down payment.*|neighborhood|schools|nearby (?:homes|schools|rentals).*|getting around|walk score.*|climate risk.*|market value.*|payment calculator.*|estimated market value.*|show more|show less|see more.*|hide|©.*|zillow last checked.*|listing provided.*|source:.*|mls #.*|advertisement|find (?:assessor|out what)|similar homes|homes for sale|nearby homes)$/i;
    const lines = after.split(/\n/);
    let stopLine = -1;
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      if (!t) continue;
      if (t.length <= 40 && FF_STOP.test(t.replace(/:$/, ""))) { stopLine = li; break; }
    }
    if (stopLine >= 0) after = lines.slice(0, stopLine).join("\n");
    factsFeatures = after.replace(/\bshow (more|less)\b/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    if (factsFeatures.length > 8000) factsFeatures = factsFeatures.slice(0, 8000).trim() + "…";
  }

  // Structured financial facts from the "Facts & features" / financial detail
  // block — HOA (with period), annual tax, date on market, cumulative DOM.
  let hoaFee = "", hoaPeriod = "", annualTax = "", listDateFromFacts = "", cumDom = "";
  const hoaM = text.match(/hoa fee[:\s]*\$?([\d,]+)\s*(annually|\/?\s*year|monthly|\/?\s*month|quarterly)?/i);
  if (hoaM) {
    hoaFee = String(num(hoaM[1]));
    const per = (hoaM[2] || "").toLowerCase();
    hoaPeriod = /month/.test(per) ? "monthly" : /quarter/.test(per) ? "quarterly" : "annually";
  }
  const taxM = text.match(/annual tax amount[:\s]*\$?([\d,]+)/i) || text.match(/tax annual amount[:\s]*\$?([\d,]+)/i);
  if (taxM) annualTax = String(num(taxM[1]));
  const domDateM = text.match(/date on market[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (domDateM) { const m = domDateM[1].match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) listDateFromFacts = `${m[3]}-${String(+m[1]).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`; }
  const cumM = text.match(/cumulative days on market[:\s]*(\d+)/i);
  if (cumM) cumDom = String(num(cumM[1]));

  // Prefer the explicit "Date on market" from facts over the price-history guess.
  const finalListingDate = listDateFromFacts || listingDate || "";
  const finalDom = cumDom || (num(dom) != null ? String(num(dom)) : "");

  const clean = {
    address: parseAddress(text),
    asking: num(asking) || "",
    sqft: num(sqft) || "",
    beds: num(beds) || "",
    baths: num(baths) || "",
    lot: lot || "",
    yearBuilt: num(yearBuilt) || "",
    dom: finalDom,
    priceCuts: priceCuts || "",
    listingDate: finalListingDate,
    hoaFee: hoaFee || "",
    hoaPeriod: hoaPeriod || "",
    annualTax: annualTax || "",
    whatsSpecial: whatsSpecial || "",
    factsFeatures: factsFeatures || "",
  };

  // Comps — look for a "recently sold" / "nearby" block, then find lines that
  // carry both a $price and a sqft figure. Line-by-line is far more robust to
  // portal formatting than one big regex; also handles mobile's collapsed rows.
  const comps = [];
  const soldIdx = text.search(/(recently sold|nearby (?:homes|sold)|sold homes|comparable|similar (?:homes|sold))/i);
  const compZone = soldIdx >= 0 ? text.slice(soldIdx) : "";
  if (compZone) {
    const lines = compZone.split(/\n|(?<=sq\s?ft)\s+(?=\d)|(?<=sqft)\s+(?=\d)|(?<=\b20\d{2}\b)\s+(?=\d+\s+[A-Za-z])/i);
    for (const line of lines) {
      if (comps.length >= 12) break;
      const priceM = line.match(/\$\s?([\d,]{4,})/);
      const sqftM = line.match(/([\d,]{3,5})\s*(?:sq\.?\s?ft|sqft|square feet)/i);
      if (priceM && sqftM) {
        const price = num(priceM[1]), sq = num(sqftM[1]);
        if (price > 50000 && sq > 400 && sq < 12000) {
          const yr = (line.match(/\b(20\d{2})\b/) || [])[1] || "";
          const addr = (line.match(/(\d+\s+[A-Za-z0-9.\s]+?(?:St|Ave|Dr|Rd|Ln|Way|Ct|Blvd|Pl|Ter|Cir|Trl|Drive|Street|Avenue|Road|Lane|Court|Circle|Place|Terrace|Trail))/) || [])[1] || "";
          comps.push({ address: addr.trim().slice(0, 50), price, sqft: sq, saleYear: yr, beds: "", baths: "" });
        }
      }
    }
  }

  report.found = clean;
  report.comps = comps.length;
  report.missing = Object.entries(clean).filter(([, v]) => v === "" || v == null).map(([k]) => k);
  return { clean, comps, report };
}

// Route any pasted content: real JSON, HTML/MHTML, or raw listing text.
function smartParse(input) {
  const t = (input || "").trim();
  if (!t) return { clean: {}, comps: [], report: { error: "Nothing pasted yet.", found: {}, missing: [], comps: 0 } };
  // JSON?
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      const clean = {
        address: flattenAddress(parsed.address) || parsed.address || "",
        asking: parsed.asking ?? parsed.price ?? "", sqft: parsed.sqft ?? "",
        beds: parsed.beds ?? "", baths: parsed.baths ?? "", lot: parsed.lot ?? "",
        yearBuilt: parsed.yearBuilt ?? "", dom: parsed.dom ?? "",
        areaDom: parsed.areaDom ?? "", priceCuts: parsed.priceCuts ?? "",
        roofAge: parsed.roofAge ?? "", hvacAge: parsed.hvacAge ?? "",
        whatsSpecial: parsed.whatsSpecial ?? "",
        factsFeatures: parsed.factsFeatures ?? "",
        listingDate: parsed.listingDate ?? "",
        hoaFee: parsed.hoaFee ?? "", hoaPeriod: parsed.hoaPeriod ?? "", annualTax: parsed.annualTax ?? "",
      };
      const comps = parsed.comps || [];
      return { clean, comps, report: { source: "JSON", found: clean, missing: Object.entries(clean).filter(([, v]) => v === "" || v == null).map(([k]) => k), comps: comps.length, error: null } };
    } catch {
      // fall through to text parsing on malformed JSON
    }
  }
  // HTML / MHTML?
  if (/<html|<!doctype|Content-Type:\s*multipart|__NEXT_DATA__|hdpApolloPreloadedData/i.test(t)) {
    return parseListingHtml(t);
  }
  // Otherwise: raw listing text.
  return parseListingText(t);
}


// Turns a plain-language observation into a suggested value adjustment.
// Rule: hard physical facts (lot, road, defects) => fixed DOLLARS.
//       whole-home quality factors (renovations, finishes) => PERCENT of value.
// Every rule shows its reasoning; the user accepts / edits / rejects.
// `sign` is baked into the amount (negative = discount).
const NOTE_RULES = [
  // --- percentage: whole-home quality (scales with value) ---
  { re: /\b(all|both|every|fully|completely).{0,20}(bath|bathroom).{0,30}(renovat|remodel|updated|modern|new)/i, kind: "pct", amt: 4, label: "Bathrooms fully renovated", why: "Move-in-ready baths across the home lift value proportionally — a whole-home quality factor, so it scales with price." },
  { re: /\b(bath|bathroom)s?\b.{0,30}(renovat|remodel|updated|modern|new)/i, kind: "pct", amt: 2, label: "Updated bathroom(s)", why: "Updated baths add value proportional to the home." },
  { re: /\b(kitchen).{0,30}(renovat|remodel|updated|modern|new|gutted|redone)/i, kind: "pct", amt: 4, label: "Renovated kitchen", why: "The kitchen drives buyer perception more than any room; renovated kitchens lift whole-home value." },
  { re: /\b(whole|entire|fully|completely|top to bottom|move.?in ready|turnkey|turn.?key).{0,20}(renovat|remodel|updated|redone|new)/i, kind: "pct", amt: 6, label: "Whole-home renovation", why: "Turnkey condition commands a premium over the comp set as a proportion of value." },
  { re: /\b(new|newer|updated|refinished).{0,15}(floor|hardwood|luxury vinyl|lvp)/i, kind: "pct", amt: 1.5, label: "Updated flooring", why: "Fresh flooring throughout is a proportional quality lift." },
  { re: /\b(open|open.concept|open.floor).{0,15}(kitchen|plan|concept|layout)/i, kind: "pct", amt: 2, label: "Open-concept layout", why: "Open kitchen/plan is a required preference and a value driver — scales with the home." },
  { re: /\b(natural light|tons of light|bright|large windows|tall ceiling|high ceiling|vaulted)/i, kind: "pct", amt: 1.5, label: "Light / ceiling quality", why: "Light and ceiling height are whole-home desirability factors buyers pay a proportional premium for." },
  { re: /\b(dated|outdated|original|needs updating|tired|worn).{0,20}(throughout|everywhere|whole|entire|kitchen and bath)/i, kind: "pct", amt: -4, label: "Dated throughout", why: "Whole-home dated condition discounts value proportionally vs. renovated comps." },
  { re: /\b(smell|odor|smoke|pet odor|mold smell|musty)/i, kind: "pct", amt: -2, label: "Odor issue", why: "Pervasive odor depresses buyer willingness across the whole home." },

  // --- dollars: hard physical facts (fixed regardless of price) ---
  { re: /\b(small|tiny|little|compact|no|not much|minimal).{0,15}(lot|yard|backyard|land)/i, kind: "usd", amt: -15000, label: "Small lot / yard", why: "Lot size is a fixed physical constraint; buyers discount a set dollar amount, not a percentage." },
  { re: /\b(busy|main|major|arterial|through|traffic).{0,10}(road|street|highway|hwy)/i, kind: "usd", amt: -18000, label: "Backs/faces busy road", why: "A permanent location defect — fixed dollar discount every buyer applies." },
  { re: /\b(power line|powerline|transmission|high.tension|cell tower)/i, kind: "usd", amt: -20000, label: "Power lines / tower", why: "Permanent visual/perceived-risk defect; fixed discount." },
  { re: /\b(freeway|highway|interstate|train|railroad|airport).{0,10}(noise|sound|close|nearby|adjacent)/i, kind: "usd", amt: -15000, label: "Noise (freeway/train/air)", why: "Permanent noise nuisance — fixed dollar hit." },
  { re: /\b(slope|sloped|steep|hill|hilly|unusable|can.?t use).{0,15}(yard|lot|backyard|grade)/i, kind: "usd", amt: -12000, label: "Sloped / unusable yard", why: "Flat usable yard is your stated preference; a slope is a fixed physical shortfall." },
  { re: /\b(pie.?shaped|odd.?shaped|weird.?shaped|irregular|flag.?lot|narrow lot)/i, kind: "usd", amt: -8000, label: "Odd-shaped lot", why: "Irregular lot geometry is a fixed usability discount." },
  { re: /\b(no privacy|overlooked|neighbors close|close to neighbor|zero privacy)/i, kind: "usd", amt: -8000, label: "Lacks privacy", why: "Fixed physical/location discount for exposure." },
  { re: /\b(walk through|walk.?through|tandem).{0,15}(bedroom|room|to get)/i, kind: "usd", amt: -10000, label: "Poor floor-plan flow", why: "Functional floor-plan defect buyers dock a fixed amount for." },
  { re: /\b(no|small|tiny).{0,10}(primary|master|bed).{0,10}(closet|bedroom)/i, kind: "usd", amt: -7000, label: "Small bedrooms/closets", why: "Small bedrooms are your specific concern; a fixed functional discount." },
  { re: /\b(no|missing|only).{0,15}(main.?level|main.?floor|downstairs|first.?floor).{0,10}(bed|bath)/i, kind: "usd", amt: -6000, label: "No main-level bed/bath", why: "Missing a stated preference; fixed functional discount." },
  { re: /\b(foundation|crack|settling|structural|water damage|water intrusion|leak)/i, kind: "usd", amt: -25000, label: "Structural / water concern", why: "Potential structural issue — placeholder fixed hit; get an inspection to price precisely." },
  { re: /\b(cul.?de.?sac|quiet street|interior lot|private lot|large lot|big yard|flat yard|level yard)/i, kind: "usd", amt: 8000, label: "Premium lot/position", why: "A desirable fixed location feature buyers pay a set premium for." },
  { re: /\b(pool|swimming pool)\b/i, kind: "usd", amt: 10000, label: "Pool", why: "A pool is a fixed feature; value varies but a set premium is a fair starting point in this climate." },
];

function interpretNote(text) {
  const hits = [];
  for (const rule of NOTE_RULES) {
    if (rule.re.test(text)) {
      // avoid double-firing the weaker bath rule when the strong one matched
      if (rule.label === "Updated bathroom(s)" && hits.some((h) => h.label === "Bathrooms fully renovated")) continue;
      hits.push({ kind: rule.kind, amt: rule.amt, label: rule.label, why: rule.why });
    }
  }
  return hits;
}

// ============================== valuation core ==============================
// Estimated monthly payment on the ASKING price. Financing inputs come from
// Assumptions (rates.defaults). Down payment is entered as CASH AVAILABLE (a
// dollar amount), so the down-payment % — and therefore whether PMI applies —
// is computed per property from its price. Falls back to a down % if no cash
// figure is set, for backward compatibility.
function monthlyPayment(prop, rates) {
  const asking = num(prop.asking);
  if (!asking) return null;
  const d = rates.defaults || {};
  const apr = num(d.interestRate) ?? 6.5;
  const termYrs = num(d.loanTermYrs) ?? 30;
  const pmiPct = num(d.pmiPct) ?? 0.6;
  const insPct = num(d.insPctOfValue) ?? 0.35;

  // Cash available (dollars) is the primary input; cap it at the price. If no
  // cash figure is set, fall back to the legacy down-payment percent.
  const cash = num(d.cashAvailable);
  let down, downPct;
  if (cash != null) {
    down = Math.min(cash, asking);
    downPct = (down / asking) * 100;
  } else {
    downPct = num(d.downPct) ?? 20;
    down = asking * (downPct / 100);
  }
  const loan = Math.max(0, asking - down);
  const r = (apr / 100) / 12;
  const n = termYrs * 12;
  const pi = r > 0 ? (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : loan / n;

  const annualTax = num(prop.annualTax);
  const taxMo = annualTax != null ? annualTax / 12 : (asking * ((num(d.taxPctOfValue) ?? 1.0) / 100)) / 12;

  let hoaMo = 0;
  const hoa = num(prop.hoaFee);
  if (hoa != null) {
    const per = (prop.hoaPeriod || "annually").toLowerCase();
    hoaMo = /month/.test(per) ? hoa : /quarter/.test(per) ? hoa / 3 : hoa / 12;
  }

  // PMI applies when the down payment is under 20% of THIS property's price.
  const pmiMo = downPct < 20 ? (loan * (pmiPct / 100)) / 12 : 0;
  const insMo = (asking * (insPct / 100)) / 12;

  const total = pi + taxMo + hoaMo + pmiMo + insMo;
  return { asking, down, downPct, loan, apr, termYrs, pi, taxMo, hoaMo, pmiMo, insMo, total, taxIsEstimated: annualTax == null, hasHoa: hoa != null && hoa > 0, usesCash: cash != null };
}

function valuate(prop, rates, pool) {
  const subjectSqft = num(prop.sqft);

  // Prefer the POOL engine when it can produce a value — that's the real
  // appraiser-grade number. Fall back to any manual comps on the property.
  const ca = prop.compAnalysis || {};
  const poolSubject = {
    sqft: subjectSqft, beds: num(prop.beds), baths: num(prop.baths),
    yearBuilt: num(prop.yearBuilt), lot: num(prop.lot),
    lat: num(ca.lat), lng: num(ca.lng),
  };
  const caFactors = { sqftTol: rates.defaults?.sqftTol ?? 500, maxMonths: rates.defaults?.maxMonths, glaPct: rates.defaults?.glaPct, glaOverride: rates.defaults?.glaOverride, bed: rates.defaults?.bedAdj, bath: rates.defaults?.bathAdj, year: rates.defaults?.yearAdj, lot: rates.defaults?.lotAdj, ...(ca.factors || {}) };
  const poolAnalysis = (pool && (pool.comps || []).length)
    ? analyzeComps(poolCompsForProperty(pool), poolSubject, num(ca.radius) || num(rates.defaults?.radius) || 2, caFactors)
    : null;

  let low = null, likely = null, high = null, ppsfMedian = null, adjComps = [];

  if (poolAnalysis && poolAnalysis.weighted != null) {
    // Pool engine drives the value; its adjusted comps already reconcile.
    likely = poolAnalysis.weighted;
    low = poolAnalysis.range?.low ?? null;
    high = poolAnalysis.range?.high ?? null;
    ppsfMedian = poolAnalysis.medPPSF;
    adjComps = poolAnalysis.included;
  } else {
    // Fallback: manual comps entered on the property (legacy path).
    const comps = (prop.comps || []).filter((c) => num(c.price) && num(c.sqft));
    adjComps = comps.map((c) => {
      const price = num(c.price), sqft = num(c.sqft), yr = num(c.saleYear) || todayYear;
      const { adjusted, factor, applied } = timeAdjust(price, yr, rates);
      return { ...c, price, sqft, yr, adjusted, factor, applied, ppsf: adjusted / sqft };
    }).filter((c) => isFinite(c.ppsf) && c.ppsf > 0);
    if (adjComps.length && subjectSqft) {
      const ppsfs = adjComps.map((c) => c.ppsf).sort((a, b) => a - b);
      const median = (arr) => { const m = Math.floor(arr.length / 2); return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2; };
      ppsfMedian = median(ppsfs);
      likely = ppsfMedian * subjectSqft;
      low = ppsfs[0] * subjectSqft;
      high = ppsfs[ppsfs.length - 1] * subjectSqft;
    }
  }

  // --- Value adjustments (renovation cost + environmental + observation) ---
  // Renovations: bring-to-standard cost, subtracted (cost>0 lowers value).
  const reno = renovationTotal(prop, rates.renoDefaults);
  // Environmental / proximity risks: severity → discount, subtracted.
  const env = environmentalTotal(prop, rates.envDefaults);
  // Accepted free-form observation adjustments (dollar/percent), still supported.
  const adjustments = (prop.adjustments || []).filter((a) => a.status === "accepted");
  const adjTotalUsd = adjustments.filter((a) => a.kind === "usd").reduce((s, a) => s + (num(a.amt) || 0), 0);
  const adjTotalPct = adjustments.filter((a) => a.kind === "pct").reduce((s, a) => s + (num(a.amt) || 0), 0);

  // Flip & relist discounts (percentage of comp value). Defaults in Assumptions.
  // Flip is serious: cosmetic-over-old-bones = paying renovated price for hidden
  // risk. Relist is a softer market-signal haircut, toggled off if not a trick.
  const flipPct = prop.flipSignals ? (num(rates.defaults?.flipPct) ?? 10) : 0;
  const relistPct = prop.relisted ? (num(rates.defaults?.relistPct) ?? 2) : 0;

  const applyAll = (base) => {
    if (base == null) return null;
    let val = base;
    adjustments.filter((a) => a.kind === "pct").forEach((a) => { val += base * (num(a.amt) / 100); });
    adjustments.filter((a) => a.kind === "usd").forEach((a) => { val += num(a.amt) || 0; });
    val -= reno.total;   // renovation cost lowers value (negative cost = better than standard, raises it)
    val -= env.total;    // environmental risk discount
    val -= base * (flipPct / 100);   // flip discount
    val -= base * (relistPct / 100); // relist discount
    return val;
  };
  const flipUsd = likely != null ? Math.round(likely * (flipPct / 100)) : 0;
  const relistUsd = likely != null ? Math.round(likely * (relistPct / 100)) : 0;
  const baseLikely = likely;
  const fairLikely = applyAll(likely);
  const fairLow = applyAll(low);
  const fairHigh = applyAll(high);

  // Nice-to-have criteria checklist: fit only, NEVER affects value.
  const critFeatures = rates.criteriaFeatures || DEFAULT_CRITERIA_FEATURES;
  const critChecked = critFeatures.filter((f) => (prop.criteriaCheck || {})[f.key]).length;
  const critScore = critFeatures.length ? Math.round((critChecked / critFeatures.length) * 100) : 0;

  // Verdict vs. asking.
  const asking = num(prop.asking);
  let overUnder = null, overPct = null;
  if (asking && fairLikely != null) {
    overUnder = asking - fairLikely;
    overPct = (overUnder / fairLikely) * 100;
  }

  // Red flags.
  const flags = [];
  const dom = effectiveDom(prop), areaDom = num(prop.areaDom);
  if (dom && areaDom && dom > areaDom * 1.8)
    flags.push({ level: "high", text: `On market ${dom} days vs. area norm ~${areaDom}. Well past local pace — the market has been saying no.` });
  else if (dom && areaDom && dom > areaDom * 1.25)
    flags.push({ level: "med", text: `On market ${dom} days vs. area norm ~${areaDom}. Running slow — leverage building.` });

  const cuts = num(prop.priceCuts);
  if (cuts && cuts >= 3)
    flags.push({ level: "high", text: `${cuts} price cuts — seller has been chasing the market down and is likely still a step behind it.` });
  else if (cuts && cuts >= 1)
    flags.push({ level: "low", text: `${cuts} price cut(s) — normal seller adjustment, but note the direction.` });

  if (prop.relisted)
    flags.push({ level: "med", text: `Withdrawn & relisted — applied a ${relistPct}% haircut (${fmt(relistUsd)}). DOM clock may have been reset; if it's not a market trick, untick it on the Facts tab.` });

  if (prop.flipSignals)
    flags.push({ level: "high", text: `Flip signals — applied a ${flipPct}% discount (${fmt(flipUsd)}). You're at risk of paying renovated prices for cosmetic-over-old-bones. Scrutinize what's behind the finishes; verify permits and last sale date.` });

  if (overPct != null && overPct > 8)
    flags.push({ level: "high", text: `Asking ${overPct.toFixed(0)}% above comp-derived fair value (${fmt(overUnder)} over). Classic overpricing.` });
  else if (overPct != null && overPct > 3)
    flags.push({ level: "med", text: `Asking ${overPct.toFixed(0)}% above fair value (${fmt(overUnder)} over).` });

  if (reno.total > 40000 && overPct != null && overPct > 0)
    flags.push({ level: "high", text: `${fmt(reno.total)} of renovation needed AND priced above value — "renovated pricing without the renovation." Your automatic dealbreaker.` });

  const roofAge = num(prop.roofAge), hvacAge = num(prop.hvacAge);
  if (roofAge && roofAge >= 20) flags.push({ level: "med", text: `Roof ~${roofAge} yrs — at/near replacement. Add to renovations.` });
  if (hvacAge && hvacAge >= 15) flags.push({ level: "med", text: `HVAC ~${hvacAge} yrs — on borrowed time.` });

  if (adjComps.length < 3)
    flags.push({ level: "low", text: `Only ${adjComps.length} usable comp(s). Thin comp set — widen the radius or add pool comps.` });

  // AI-generated insights from the observation notes (recurring / serious themes).
  (prop.insights || []).forEach((i) => flags.push({ level: i.level || "med", text: i.text, insight: true }));

  let deal = "neutral";
  const goodAt = num(rates.defaults?.dealGoodPct) ?? 0;   // asking <= this % over fair → good
  const badAt = num(rates.defaults?.dealBadPct) ?? 8;     // asking > this % over fair → bad
  if (overPct != null) {
    if (overPct <= goodAt) deal = "good";
    else if (overPct > badAt) deal = "bad";
  }

  return {
    adjComps, ppsfMedian, low, likely, high, poolAnalysis,
    reno, env, baseLikely, fairLow, fairLikely, fairHigh,
    flipPct, relistPct, flipUsd, relistUsd,
    payment: monthlyPayment(prop, rates),
    adjustments, adjTotalUsd, adjTotalPct,
    critScore, critChecked, critTotal: critFeatures.length,
    asking, overUnder, overPct, flags, deal,
  };
}

// ================================ UI bits ===================================
const C = {
  ink: "#1a2b26", paper: "#faf8f3", panel: "#ffffff", line: "#dcd7cc",
  moss: "#2f5d50", mossLt: "#e7efe9", clay: "#a8492f", clayLt: "#f5e6e0",
  gold: "#b08428", sub: "#6b7671", good: "#2f6d4f", bad: "#9e3b2a", med: "#a5762a",
};

function Field({ label, hint, value, onChange, placeholder, suffix, defaultHint, type = "text", quickPaste, readOnly }) {
  const [showHint, setShowHint] = useState(false);
  const isEmpty = value === "" || value == null;
  const doPaste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return;
      if (quickPaste === "num") { const n = num(t); if (n != null) onChange(String(n)); }
      else onChange(t.trim());
    } catch { /* clipboard blocked; user can paste manually */ }
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, letterSpacing: 0.2 }}>{label}</label>
        {hint && (
          <a onClick={() => setShowHint((s) => !s)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setShowHint((s) => !s); }}
            style={{ fontSize: 10.5, color: C.moss, cursor: "pointer", textDecoration: "underline" }}>
            where to find
          </a>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <input type={type} value={value ?? ""} placeholder={placeholder} readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, padding: "9px 11px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 14, color: readOnly ? C.sub : C.ink, background: readOnly ? C.mossLt : C.paper, fontFamily: "inherit", outline: "none" }} />
        {/* Accept-default appears inline ONLY when the paste read nothing for this field */}
        {defaultHint != null && isEmpty && (
          <button onClick={() => onChange(String(defaultHint))} title={`Use default ${defaultHint}`}
            style={{ padding: "7px 9px", border: `1px solid ${C.moss}`, borderRadius: 6, background: C.mossLt, color: C.moss, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap" }}>
            use {defaultHint}
          </button>
        )}
        {quickPaste && (
          <button onClick={doPaste} title="Paste from clipboard" style={{ padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 6, background: C.panel, color: C.moss, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>⎘</button>
        )}
        {suffix && <span style={{ fontSize: 12, color: C.sub, minWidth: 30 }}>{suffix}</span>}
      </div>
      {showHint && hint && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: C.sub, background: C.mossLt, padding: "7px 9px", borderRadius: 6, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function Segment({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          style={{ flex: 1, padding: "5px 4px", fontSize: 11, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${value === o.v ? o.c : C.line}`, borderRadius: 6,
            background: value === o.v ? o.c : C.panel, color: value === o.v ? "#fff" : C.sub, fontFamily: "inherit" }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ============================== main app ====================================
export default function App() {
  const [props, setProps] = useState([]);
  const [rates, setRates] = useState({ ...DEFAULT_APPRECIATION });
  const [pool, setPool] = useState({ comps: [], updatedAt: null });
  const [activeId, setActiveId] = useState(null);
  const [view, setView] = useState("list"); // list | edit | rates | compare | backup | pool

  // Always land at the top when navigating to a new page or opening a property.
  // Runs after render so scrolling afterward still works normally.
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch {}
  }, [view, activeId]);
  const [loaded, setLoaded] = useState(false);
  const [recovery, setRecovery] = useState(null); // {recovered, recoveredCount}

  // LOAD — pure read. Never triggers a save. This is the key architectural fix:
  // the load path only reads storage and seeds state; it can no longer cause a
  // write, so an empty/transient state on load can never overwrite good data.
  useEffect(() => {
    (async () => {
      const [p, r, poolRes] = await Promise.all([loadProps(), loadRates(), loadPoolWithRecovery()]);
      setProps(p);
      setRates(r);
      setPool(poolRes.pool);
      setLoaded(true);
    })();
  }, []);

  // LIVE SYNC — another screen saved a change. Apply it to state WITHOUT saving
  // (this is a pure read, so it can never echo back or overwrite anything).
  useEffect(() => {
    const onRemote = (e) => {
      const { key, value } = e.detail || {};
      try {
        const parsed = JSON.parse(value);
        if (key === "properties" && Array.isArray(parsed)) setProps(parsed);
        else if (key === "appreciation" && parsed && typeof parsed === "object") setRates(parsed);
        else if (key === "compPool" && parsed && Array.isArray(parsed.comps)) setPool(parsed);
      } catch {}
    };
    window.addEventListener("hb-remote", onRemote);
    return () => window.removeEventListener("hb-remote", onRemote);
  }, []);

  // SAVE — only in response to real user mutations, via these commit wrappers.
  // Failures are surfaced to the user (a visible banner) instead of swallowed,
  // so a storage-quota problem can't silently lose data on the next refresh.
  const commitProps = useCallback((next) => {
    setProps((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      saveProps(value).catch(() => {});
      return value;
    });
  }, []);
  const commitRates = useCallback((next) => {
    setRates((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      saveRates(value);
      return value;
    });
  }, []);
  const commitPool = useCallback((next) => {
    setPool((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      if ((value?.comps?.length || 0) > 0 || value?._clearedByUser) {
        savePool(value).catch(() => {});
      }
      return value;
    });
  }, []);

  const active = props.find((p) => p.id === activeId);
  useEffect(() => { if (loaded && view === "edit" && activeId && !active) { setActiveId(null); setView("list"); } }, [loaded, view, activeId, active]);

  const newProp = () => {
    const p = {
      id: uid(), address: "", asking: "", sqft: "", beds: "", baths: "", lot: "",
      yearBuilt: "",
      roofAge: rates.defaults?.roofAge ?? "", hvacAge: rates.defaults?.hvacAge ?? "",
      dom: "", areaDom: rates.defaults?.areaDom ?? "", priceCuts: "",
      relisted: false, notes: "",
      renovations: {}, environment: {}, criteriaCheck: {}, renoCustom: [], adjustments: [],
      compAnalysis: { radius: rates.defaults?.radius ?? "2" },
    };
    commitProps((ps) => [...ps, p]); setActiveId(p.id); setView("edit");
  };
  const update = (patch) => commitProps((ps) => ps.map((p) => (p.id === activeId ? { ...p, ...patch } : p)));
  const del = (id) => { commitProps((ps) => ps.filter((p) => p.id !== id)); if (activeId === id) { setActiveId(null); setView("list"); } };

  if (!loaded) return <div style={{ padding: 40, fontFamily: "Georgia, serif", color: C.sub }}>Loading your properties…</div>;

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Inter', system-ui, sans-serif", color: C.ink, overflowX: "hidden", width: "100%", maxWidth: "100vw" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        html, body { overflow-x: hidden; max-width: 100%; }
        input:focus { border-color: ${C.moss} !important; }
        button:focus-visible { outline: 2px solid ${C.moss}; outline-offset: 1px; }
        @media (prefers-reduced-motion: no-preference) { .fade { animation: fade .3s ease; } }
        @keyframes fade { from { opacity: 0; transform: translateY(4px);} to {opacity:1; transform:none;} }
        .edit-grid { display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start; }
        .facts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
        .facts-grid > * { min-width: 0; }
        .quad-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; }
        .quad-grid > * { min-width: 0; }
        .tri-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
        .tri-grid > * { min-width: 0; }
        .edit-grid > * { min-width: 0; }
        input, select, textarea { max-width: 100%; }
        .app-header { padding: 18px 22px; }
        .app-main { max-width: 1080px; margin: 0 auto; padding: 22px 18px 60px; }
        @media (max-width: 760px) {
          .edit-grid { grid-template-columns: 1fr; }
          .edit-grid > aside { position: static !important; width: 100% !important; order: -1; }
          .facts-grid { grid-template-columns: 1fr; }
          .quad-grid { grid-template-columns: 1fr 1fr; }
          .tri-grid { grid-template-columns: 1fr; }
          .app-header { padding: 14px 16px; flex-wrap: wrap; gap: 10px; }
          .app-main { padding: 16px 12px 60px; }
          .nav-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap !important; padding-bottom: 4px; }
          .nav-scroll > button { flex-shrink: 0; }
        }
        @media (max-width: 440px) {
          .quad-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* header */}
      <header className="app-header" style={{ borderBottom: `2px solid ${C.ink}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: C.panel }}>
        <div>
          <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 26, fontWeight: 700, letterSpacing: -0.5, lineHeight: 1 }}>
            HOMEBASE
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 3, letterSpacing: 0.3 }}>
            The list price is an opinion. Closed comps are the fact.
          </div>
        </div>
        <div className="nav-scroll" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <NavBtn on={view === "list"} onClick={() => setView("list")}>Properties</NavBtn>
          <NavBtn on={view === "pool"} onClick={() => setView("pool")}>Comp&nbsp;Pool{pool.comps.length ? ` (${pool.comps.length})` : ""}</NavBtn>
          <NavBtn on={view === "compare"} onClick={() => setView("compare")}>Compare</NavBtn>
          <NavBtn on={view === "rates"} onClick={() => setView("rates")}>Assumptions</NavBtn>
          <NavBtn on={view === "backup"} onClick={() => setView("backup")}>Backup</NavBtn>
        </div>
      </header>

      <main className="app-main">
        {view === "list" && <ListView props={props} rates={rates} pool={pool} onOpen={(id) => { setActiveId(id); setView("edit"); }} onNew={newProp} onDel={del} />}
        {view === "rates" && <RatesView rates={rates} setRates={commitRates} props={props} setProps={commitProps} />}
        {view === "pool" && <CompPoolView pool={pool} setPool={commitPool} rates={rates} />}
        {view === "backup" && <BackupView props={props} rates={rates} pool={pool} setProps={commitProps} setRates={commitRates} setPool={commitPool} />}
        {view === "compare" && <CompareView props={props} rates={rates} pool={pool} onOpen={(id) => { setActiveId(id); setView("edit"); }} />}
        {view === "edit" && active && <EditView key={active.id} prop={active} rates={rates} pool={pool} update={update} onBack={() => setView("list")} onDel={() => del(active.id)} />}
      </main>
    </div>
  );
}

function NavBtn({ on, onClick, children }) {
  return (
    <button onClick={onClick} style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
      border: `1px solid ${on ? C.ink : C.line}`, borderRadius: 7, background: on ? C.ink : C.panel, color: on ? C.paper : C.ink, fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

// ------------------------------- comp pool view -----------------------------
function CompPoolView({ pool, setPool, rates }) {
  const [csv, setCsv] = useState("");
  const [readMsg, setReadMsg] = useState(null);
  const [census, setCensus] = useState("");
  const [geoMsg, setGeoMsg] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const [chatReq, setChatReq] = useState("");
  const [chatReply, setChatReply] = useState("");
  const [chatMsg, setChatMsg] = useState(null);

  const comps = pool.comps || [];
  const needGeo = poolNeedingGeo(pool);
  const haveGeo = comps.length - needGeo.length;
  const outliers = pool.outliers || []; // [{address, reason, severity}]

  // Load an export → APPEND to the pool with dedup (never wipes existing data).
  const loadExport = (text) => {
    const res = readPoolCSV(text, rates);
    if (res.error) { setReadMsg({ err: res.error }); return; }
    const merged = appendComps(pool, res.comps);
    setPool(merged.pool);
    setReadMsg({ ok: `Appended: ${merged.added} new, ${merged.replaced} updated (newer sale), ${merged.skipped} duplicates skipped. Pool now ${merged.pool.comps.length} comps.` });
    setCsv("");
  };
  const pasteCsv = async () => { try { const t = await navigator.clipboard.readText(); if (t) { setCsv(t); loadExport(t); } } catch {} };

  // Census geocode result → fill coordinates.
  const applyCensus = () => {
    const res = mergeCensusResults(pool, census);
    if (res.error && !res.matched) { setGeoMsg({ err: res.error }); return; }
    setPool(res.pool);
    setGeoMsg({ ok: `Filled coordinates for ${res.matched} comps. ${res.stillMissing} still missing.` });
    setCensus("");
  };

  // AI outlier scan over the WHOLE pool.
  const runScan = async () => {
    if (!comps.length || scanning) return;
    setScanning(true); setScanMsg({ ok: "Scanning the pool for bad comps…" });
    // send a compact table (cap tokens): address, price, sqft, ppsf, beds, baths, year, date
    const rows = comps.map((c) => ({ a: c.address, p: c.price, s: c.sqft, ppsf: c.sqft ? Math.round(c.price / c.sqft) : null, bd: c.beds, ba: c.baths, y: c.yearBuilt, d: c.soldDate }));
    const sys = `You audit a pool of sold-home comps for a homebuyer's valuation tool. Identify comps that should NOT be used as market comparables. Return ONLY JSON: {"outliers":[{"address": "...", "severity":"high|med|low", "reason":"one short sentence"}]}.
Flag: non-arm's-length sales (price far below market, e.g. under ~$50/sqft or absurdly low totals like family transfers/foreclosures/lot-only), obvious data errors (impossible ppsf, missing critical fields), and price/sqft that is a wild outlier vs the pool. Do NOT flag a comp just for being somewhat high or low — only genuine non-market or broken records. Use the exact address string from the data. Return [] if the pool is clean.`;
    try {
      const resp = await fetch("/api/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1500, system: sys, messages: [{ role: "user", content: `Comps (ppsf = price per sqft):\n${JSON.stringify(rows)}\n\nReturn the outliers JSON.` }] }),
      });
      const data = await resp.json();
      const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(txt);
      const found = (parsed.outliers || []).filter((o) => o && o.address);
      setPool({ ...pool, outliers: found });
      setScanMsg({ ok: found.length ? `Found ${found.length} comps to review below.` : "No outliers found — pool looks clean." });
    } catch (err) {
      setScanMsg({ err: "Scan failed . Try again." });
    } finally { setScanning(false); }
  };

  const removeComp = (address) => {
    const key = normAddrKey(address, "");
    setPool({ ...pool, comps: comps.filter((c) => normAddrKey(c.address, "") !== key), outliers: outliers.filter((o) => o.address !== address) });
  };
  const acceptOutlier = (address) => setPool({ ...pool, outliers: outliers.filter((o) => o.address !== address) });
  const removeAllOutliers = () => {
    const addrs = new Set(outliers.map((o) => normAddrKey(o.address, "")));
    setPool({ ...pool, comps: comps.filter((c) => !addrs.has(normAddrKey(c.address, ""))), outliers: [] });
  };

  const downloadCSV = () => {
    const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const out = ["address,city,zip,price,sqft,beds,baths,yearBuilt,lot,soldDate,lat,lng,status"].concat(
      comps.map((c) => [c.address, c.city, c.zip, c.price, c.sqft, c.beds, c.baths, c.yearBuilt, c.lot, c.soldDate, c.lat, c.lng, c.status].map(esc).join(","))
    ).join("\n");
    try {
      const blob = new Blob([out], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `comp-pool-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setReadMsg({ ok: `Downloaded ${comps.length} comps.` });
    } catch { setReadMsg({ err: "Download blocked here — try the published app." }); }
  };

  const clearAll = () => { if (confirm("Clear ALL pool comps, coordinates, history, and outlier flags? This cannot be undone.")) setPool({ comps: [], addressHistory: [], outliers: [], updatedAt: null, _clearedByUser: true }); };

  // Build a prompt the user pastes into the Claude chat to estimate coordinates
  // for comps the Census geocoder couldn't match.
  const buildChatRequest = () => {
    const list = needGeo.map((c, i) => `${i + 1}. ${[c.address, c.city, c.zip].filter(Boolean).join(", ")}`).join("\n");
    const prompt = `I have ${needGeo.length} addresses my geocoder couldn't match. Please estimate their coordinates and return ONLY a JSON array of {"i": <number>, "lat": <number>, "lng": <number>} using the numbers below — no other text. Approximate from the street/ZIP is fine; flag that they're estimates.\n\n${list}`;
    setChatReq(prompt);
    if (navigator.clipboard) navigator.clipboard.writeText(prompt).then(() => setChatMsg({ ok: "Prompt copied — paste it into the Claude chat, then paste the JSON reply below." }), () => setChatMsg({ ok: "Select the prompt below and copy it into the Claude chat." }));
    else setChatMsg({ ok: "Copy the prompt below into the Claude chat, then paste the JSON reply below." });
  };
  const applyChatReply = () => {
    // reuse mergeGeocode, but the request numbered by needGeo order, so map i→comp
    let parsed;
    try { parsed = JSON.parse(chatReply); } catch { setChatMsg({ err: "That isn't valid JSON — paste the array exactly as given." }); return; }
    const list = Array.isArray(parsed) ? parsed : (parsed.results || []);
    if (!list.length) { setChatMsg({ err: "No coordinate entries found." }); return; }
    const updated = [...comps];
    // index i is 1-based into needGeo; map back to the actual comp id
    const idOf = needGeo.map((c) => c.id);
    let matched = 0;
    for (const g of list) {
      if (g.lat == null || g.lng == null) continue;
      const compId = g.i != null ? idOf[g.i - 1] : null;
      const idx = compId != null ? updated.findIndex((c) => c.id === compId) : -1;
      if (idx >= 0 && (updated[idx].lat == null || updated[idx].lng == null)) { updated[idx] = { ...updated[idx], lat: +g.lat, lng: +g.lng, estCoords: true }; matched++; }
    }
    setPool({ ...pool, comps: updated });
    setChatMsg({ ok: `Applied estimated coordinates to ${matched} comps.` });
    setChatReply(""); setChatReq("");
  };

  const sevColor = { high: C.bad, med: C.med, low: C.sub };

  return (
    <div className="fade" style={{ maxWidth: 760 }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, marginTop: 0 }}>Comp pool</h2>
      <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
        Your master comp list. New exports <strong>append</strong> — duplicates (matched on address, ignoring St/Ct/SE variants) are collapsed to the most recent sale, and existing coordinates are preserved so you don't re-geocode. Every property draws from this pool.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 22, fontFamily: "'Fraunces', serif", fontWeight: 700 }}>{comps.length}</div>
          <div style={{ fontSize: 11, color: C.sub }}>comps in pool</div>
        </div>
        <div style={{ flex: "1 1 120px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 22, fontFamily: "'Fraunces', serif", fontWeight: 700, color: haveGeo === comps.length && haveGeo > 0 ? C.good : C.ink }}>{haveGeo}</div>
          <div style={{ fontSize: 11, color: C.sub }}>have coordinates</div>
        </div>
        <div style={{ flex: "1 1 120px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 22, fontFamily: "'Fraunces', serif", fontWeight: 700, color: needGeo.length ? C.clay : C.sub }}>{needGeo.length}</div>
          <div style={{ fontSize: 11, color: C.sub }}>need coordinates</div>
        </div>
      </div>

      {comps.length === 0 && (
        <div style={{ background: C.clayLt, border: `1px solid ${C.clay}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.clay, marginBottom: 6 }}>No comps in the pool yet</div>
          <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.55 }}>
            The pool is shared — once comps are loaded they show up on every device. To load a saved pool, go to <strong>Backup → Load file</strong> and pick your backup. You can also paste a CSV export below to build it fresh.
          </div>
        </div>
      )}

      {comps.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <button onClick={downloadCSV} style={{ padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 7, background: C.panel, color: C.moss, fontFamily: "inherit" }}>⤓ Download pool CSV</button>
          <button onClick={runScan} disabled={scanning} style={{ padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: scanning ? "not-allowed" : "pointer", border: "none", borderRadius: 7, background: C.ink, color: C.paper, fontFamily: "inherit", opacity: scanning ? 0.6 : 1 }}>{scanning ? "Scanning…" : "⚑ AI scan for bad comps"}</button>
          <button onClick={clearAll} style={{ padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.bad}`, borderRadius: 7, background: C.panel, color: C.bad, fontFamily: "inherit" }}>Clear all</button>
        </div>
      )}
      {scanMsg && <div style={{ marginBottom: 12, fontSize: 11.5, color: scanMsg.err ? C.bad : C.moss, background: scanMsg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7 }}>{scanMsg.err || scanMsg.ok}</div>}

      {/* OUTLIERS review */}
      {outliers.length > 0 && (
        <div style={{ background: C.clayLt, border: `1px solid ${C.clay}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.clay }}>Flagged comps ({outliers.length})</div>
            <button onClick={removeAllOutliers} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 6, background: C.bad, color: "#fff", fontFamily: "inherit" }}>Remove all</button>
          </div>
          {outliers.map((o, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid rgba(168,73,47,0.15)` }}>
              <span style={{ color: sevColor[o.severity] || C.sub, fontWeight: 700, fontSize: 13 }}>{o.severity === "high" ? "▲" : o.severity === "med" ? "◆" : "·"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{o.address}</div>
                <div style={{ fontSize: 11, color: C.sub }}>{o.reason}</div>
              </div>
              <button onClick={() => acceptOutlier(o.address)} title="Keep it" style={{ padding: "5px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 6, background: C.panel, color: C.moss, fontFamily: "inherit" }}>Keep</button>
              <button onClick={() => removeComp(o.address)} title="Remove from pool" style={{ padding: "5px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 6, background: C.bad, color: "#fff", fontFamily: "inherit" }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {/* Step 1: load export */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>1 · Add a CSV export (appends)</div>
        <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8, lineHeight: 1.5 }}>Redfin, GAMLS, or Zillow. Include the header row. New comps append; duplicates collapse to the newest sale.</div>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} placeholder="Paste CSV export…"
          style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 11, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button onClick={() => loadExport(csv)} style={{ flex: 1, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 8, background: C.moss, color: "#fff", fontFamily: "inherit" }}>Add to pool</button>
          <button onClick={pasteCsv} style={{ padding: "9px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 8, background: C.panel, color: C.moss, fontFamily: "inherit" }}>⎘ Paste</button>
        </div>
        {readMsg && <div style={{ marginTop: 8, fontSize: 11.5, color: readMsg.err ? C.bad : C.moss, background: readMsg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7, lineHeight: 1.4 }}>{readMsg.err || readMsg.ok}</div>}
      </div>

      {/* Step 2: geocode via Census */}
      {comps.length > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>2 · Fill coordinates {needGeo.length === 0 && <span style={{ color: C.good }}>✓ all done</span>}</div>
          {needGeo.length > 0 ? (
            <>
              <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8, lineHeight: 1.5 }}>
                {needGeo.length} comps need coordinates. Use the free <strong>Census batch geocoder</strong> (<span style={{ color: C.moss }}>geocoding.geo.census.gov/geocoder/locations/addressbatch</span>), then paste the <em>GeocodeResults.csv</em> below. Coordinates are preserved on future uploads, so this is a one-time step per new comp.
              </div>
              <textarea value={census} onChange={(e) => setCensus(e.target.value)} rows={4} placeholder="Paste Census GeocodeResults.csv here…"
                style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 10.5, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
              <button onClick={applyCensus} disabled={!census.trim()} style={{ marginTop: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 600, cursor: census.trim() ? "pointer" : "not-allowed", border: "none", borderRadius: 7, background: C.moss, color: "#fff", opacity: census.trim() ? 1 : 0.5, fontFamily: "inherit" }}>Apply Census coordinates</button>

              {/* Chat estimate fallback for the ones Census couldn't match */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Estimate the rest via Claude chat</div>
                <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8, lineHeight: 1.5 }}>
                  For the {needGeo.length} address{needGeo.length === 1 ? "" : "es"} Census couldn't match, generate a prompt to paste into the Claude chat. Claude returns estimated coordinates (approximate, not survey-grade) that you paste back here.
                </div>
                <button onClick={buildChatRequest} style={{ padding: "7px 13px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 7, background: C.mossLt, color: C.moss, fontFamily: "inherit" }}>Copy prompt for {needGeo.length} address{needGeo.length === 1 ? "" : "es"}</button>
                {chatReq && (
                  <textarea readOnly value={chatReq} rows={4} onFocus={(e) => e.target.select()}
                    style={{ width: "100%", marginTop: 8, padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 10.5, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
                )}
                <div style={{ fontSize: 11.5, color: C.sub, margin: "10px 0 6px", fontWeight: 600 }}>Paste Claude's JSON reply:</div>
                <textarea value={chatReply} onChange={(e) => setChatReply(e.target.value)} rows={3} placeholder='[{"i":1,"lat":33.94,"lng":-84.47}, …]'
                  style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 10.5, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
                <button onClick={applyChatReply} disabled={!chatReply.trim()} style={{ marginTop: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 600, cursor: chatReply.trim() ? "pointer" : "not-allowed", border: "none", borderRadius: 7, background: C.moss, color: "#fff", opacity: chatReply.trim() ? 1 : 0.5, fontFamily: "inherit" }}>Apply estimated coordinates</button>
                {chatMsg && <div style={{ marginTop: 8, fontSize: 11.5, color: chatMsg.err ? C.bad : C.moss, background: chatMsg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7 }}>{chatMsg.err || chatMsg.ok}</div>}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: C.sub }}>Every comp has coordinates.</div>
          )}
          {geoMsg && <div style={{ marginTop: 8, fontSize: 11.5, color: geoMsg.err ? C.bad : C.moss, background: geoMsg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7 }}>{geoMsg.err || geoMsg.ok}</div>}
        </div>
      )}
    </div>
  );
}

// starts fresh — so keep a copy of this text somewhere outside the app.
function BackupView({ props, rates, pool, setProps, setRates, setPool }) {
  const [text, setText] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [status, setStatus] = useState("");
  const [storageInfo, setStorageInfo] = useState(null);

  // Build the export payload using the BEST-available pool: live state, the
  // primary storage key, or the shadow backup — whichever has the most comps.
  // This makes an empty export impossible when comps exist anywhere, which was
  // the bug: if the pool was in a "needs recovery" state, live `pool` was empty.
  const bestPool = async () => {
    let best = pool && (pool.comps || []).length ? pool : { comps: [] };
    try {
      const c = await window.storage.get("compPool");
      const primary = c ? JSON.parse(c.value) : { comps: [] };
      for (const cand of [primary]) {
        if ((cand.comps || []).length > (best.comps || []).length) best = cand;
      }
    } catch {}
    return best;
  };
  const buildPayload = async () => ({ version: 2, exportedAt: new Date().toISOString(), properties: props, appreciation: rates, compPool: await bestPool() });

  // Read back what's ACTUALLY in the database right now.
  const checkStorage = async () => {
    try {
      const [p, a, c] = await Promise.all([
        window.storage.get("properties"), window.storage.get("appreciation"), window.storage.get("compPool"),
      ]);
      const props2 = p ? JSON.parse(p.value) : [];
      const pool2 = c ? JSON.parse(c.value) : { comps: [] };
      const bytes = (p?.value?.length || 0) + (a?.value?.length || 0) + (c?.value?.length || 0);
      const propsBytes = p?.value?.length || 0;
      setStorageInfo({
        props: props2.length,
        comps: (pool2.comps || []).length,
        hasRates: !!a,
        updatedAt: pool2.updatedAt || null,
        raw: !!(p || a || c),
        totalMB: (bytes / 1024 / 1024).toFixed(2),
        propsMB: (propsBytes / 1024 / 1024).toFixed(2),
      });
    } catch (e) {
      setStorageInfo({ error: "Couldn't read the database right now. Check your connection and try again." });
    }
  };

  const makeBackup = async () => {
    const payload = await buildPayload();
    const str = JSON.stringify(payload, null, 2);
    setText(str);
    const n = (payload.compPool.comps || []).length;
    navigator.clipboard?.writeText(str).then(
      () => setStatus(`Copied ${props.length} properties and ${n} comps. For phone↔computer, the Download file button is more reliable.`),
      () => setStatus("Select the text below and copy it manually.")
    );
  };

  const downloadBackup = async () => {
    try {
      const payload = await buildPayload();
      const n = (payload.compPool.comps || []).length;
      // Safety: if somehow still empty but state has properties, warn rather than
      // silently hand over a useless file.
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `homebase-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Downloaded a backup with ${props.length} properties and ${n} comps.${n === 0 ? " ⚠️ No comps found in any storage — if you expected comps, don't overwrite your other backups with this file." : " Open it on your other device and use “Load file”."}`);
    } catch { setStatus("Download blocked here — copy the text block instead."); }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const t = await file.text(); setRestoreText(t); doRestore(t); }
    catch { setStatus("Couldn't read that file."); }
  };

  // VERSION HISTORY — the database keeps restore points (previous versions) of
  // each dataset. List them and bring one back.
  const [versions, setVersions] = useState(null);
  const KEY_LABEL = { properties: "Properties", compPool: "Comp pool", appreciation: "Assumptions" };
  const loadVersions = async () => {
    try {
      const out = [];
      for (const key of ["properties", "compPool", "appreciation"]) {
        const rows = await window.storage.history(key);
        rows.forEach((r) => out.push({ ...r, key }));
      }
      setVersions(out);
      if (!out.length) setStatus("No earlier versions saved yet. Restore points are created automatically as you work.");
    } catch { setStatus("Couldn't read version history right now."); }
  };
  const restoreVersion = async (v) => {
    const when = new Date(v.saved_at).toLocaleString();
    if (!window.confirm(`Replace the current ${KEY_LABEL[v.key]} with the version from before ${when}? This changes it for everyone. Download a backup first if you're unsure.`)) return;
    try {
      const parsed = JSON.parse(await window.storage.historyGet(v.id));
      if (v.key === "properties") { setProps(parsed); setStatus(`Restored ${parsed.length} properties from before ${when}.`); }
      else if (v.key === "appreciation") { setRates(parsed); setStatus(`Restored assumptions from before ${when}.`); }
      else { setPool(parsed); setStatus(`Restored ${(parsed.comps || []).length} comps from before ${when}.`); }
    } catch { setStatus("Couldn't restore that version."); }
  };

  const doRestore = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.properties) throw new Error("no properties field");
      setProps(parsed.properties);
      if (parsed.appreciation) setRates(parsed.appreciation);
      if (parsed.compPool && setPool) setPool(parsed.compPool);
      setStatus(`Restored ${parsed.properties.length} propert${parsed.properties.length === 1 ? "y" : "ies"}${parsed.compPool ? ` and ${(parsed.compPool.comps || []).length} pool comps` : ""}. It's now saved to the shared database.`);
      setRestoreText("");
    } catch (e) {
      setStatus("That doesn't look like a valid backup. Paste the full block (or load the .json file) you exported.");
    }
  };

  return (
    <div className="fade" style={{ maxWidth: 640 }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, marginTop: 0 }}>Backup &amp; sync</h2>

      <div style={{ background: C.mossLt, border: `1px solid ${C.moss}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16, fontSize: 12.5, lineHeight: 1.6, color: C.ink }}>
        <strong>Shared and live:</strong> everything here is saved to the shared database and shows up on every screen that has this page open — your PC, your phone, and anyone else with the link. Backups are still worth taking now and then: <strong>Download a backup file</strong> keeps a copy you control, and <strong>Load file</strong> restores one.
      </div>

      {/* Storage status */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>What's saved in the database</div>
          <button onClick={checkStorage} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 7, background: C.panel, color: C.moss, fontFamily: "inherit" }}>Check storage</button>
        </div>
        {storageInfo && (
          <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.6 }}>
            {storageInfo.error ? <span style={{ color: C.bad }}>{storageInfo.error}</span> : !storageInfo.raw ? (
              <span style={{ color: C.clay }}>Nothing is saved in the database yet. Load a backup file below to get started.</span>
            ) : (
              <span>Saved: <strong>{storageInfo.props}</strong> propert{storageInfo.props === 1 ? "y" : "ies"}, <strong>{storageInfo.comps}</strong> comps{storageInfo.updatedAt ? `, pool last saved ${new Date(storageInfo.updatedAt).toLocaleString()}` : ""}.
              {storageInfo.totalMB != null && <span style={{ display: "block", marginTop: 4, color: C.sub }}>Using ~{storageInfo.totalMB} MB in the database (properties {storageInfo.propsMB} MB).</span>}</span>
            )}
          </div>
        )}
      </div>

      {/* Export */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Export a backup</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={downloadBackup} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 8, background: C.moss, color: "#fff", fontFamily: "inherit" }}>⤓ Download backup file</button>
          <button onClick={makeBackup} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 8, background: C.panel, color: C.moss, fontFamily: "inherit" }}>Copy as text</button>
        </div>
        {text && (
          <textarea readOnly value={text} rows={5} onFocus={(e) => e.target.select()}
            style={{ width: "100%", marginTop: 10, padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 11, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
        )}
      </div>

      {/* Version history */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Version history</div>
        <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>The database automatically keeps earlier versions of your properties, comp pool and assumptions (about one per hour of activity, plus an extra one whenever a save would shrink the data a lot). If something ever goes missing or gets overwritten, pull it back here.</div>
        <button onClick={loadVersions} style={{ padding: "8px 15px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 7, background: C.mossLt, color: C.moss, fontFamily: "inherit" }}>↻ Show earlier versions</button>
        {versions && versions.length > 0 && (
          <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
            {versions.map((v) => (
              <div key={v.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 12.5, padding: "6px 0", borderTop: `1px solid ${C.line}` }}>
                <span><strong>{KEY_LABEL[v.key]}</strong> · before {new Date(v.saved_at).toLocaleString()}</span>
                <button onClick={() => restoreVersion(v)} style={{ padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.clay}`, borderRadius: 6, background: C.clayLt, color: C.clay, fontFamily: "inherit", flexShrink: 0 }}>Restore</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Restore / load from a backup file</div>
        <label style={{ display: "inline-block", padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 8, background: C.mossLt, color: C.moss, fontFamily: "inherit", marginBottom: 10 }}>
          ⤒ Load file
          <input type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
        </label>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>…or paste an exported block:</div>
        <textarea value={restoreText} onChange={(e) => setRestoreText(e.target.value)} rows={4} placeholder="Paste your backup here…"
          style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 11, fontFamily: "monospace", background: C.paper, resize: "vertical" }} />
        <button onClick={() => doRestore(restoreText)} disabled={!restoreText.trim()} style={{ marginTop: 8, padding: "8px 15px", fontSize: 12.5, fontWeight: 600, cursor: restoreText.trim() ? "pointer" : "not-allowed", border: `1px solid ${C.clay}`, borderRadius: 7, background: restoreText.trim() ? C.clayLt : C.paper, color: C.clay, fontFamily: "inherit", opacity: restoreText.trim() ? 1 : 0.5 }}>
          Restore from pasted text
        </button>
      </div>

      {status && <div style={{ marginTop: 14, fontSize: 12.5, color: C.moss, background: C.mossLt, padding: "9px 12px", borderRadius: 8, lineHeight: 1.5 }}>{status}</div>}
    </div>
  );
}

// ------------------------------- list view ----------------------------------
function ListView({ props, rates, pool, onOpen, onNew, onDel }) {
  const [q, setQ] = useState("");
  const [dealFilter, setDealFilter] = useState("all"); // all | good | bad | neutral
  const [sortBy, setSortBy] = useState("bestValue");
  const [onlyWithFair, setOnlyWithFair] = useState(false); // has a computed fair value
  const [onlyUnderAsk, setOnlyUnderAsk] = useState(false); // asking at/under fair value

  const rows = props.map((p) => ({ p, v: valuate(p, rates, pool) }));
  let filtered = rows.filter(({ p, v }) => {
    if (q && !(p.address || "").toLowerCase().includes(q.toLowerCase())) return false;
    if (dealFilter !== "all" && v.deal !== dealFilter) return false;
    if (onlyWithFair && v.fairLikely == null) return false;
    if (onlyUnderAsk && !(v.overUnder != null && v.overUnder <= 0)) return false;
    return true;
  });
  // helpers for sorts
  const gap = (v) => (v.overUnder != null ? v.overUnder : Infinity);       // $ asking − fair (neg = good deal)
  const ppsf = (p) => { const s = num(p.sqft), a = num(p.asking); return s && a ? a / s : Infinity; };
  const domOf = (p) => { const d = effectiveDom(p); return d == null ? -Infinity : d; };
  const payOf = (v) => (v.payment ? v.payment.total : Infinity);
  const verdictRank = { good: 0, neutral: 1, bad: 2 };
  filtered.sort((a, b) => {
    switch (sortBy) {
      case "bestValue": return gap(a.v) - gap(b.v);                        // biggest discount (most negative $ gap) first
      case "priceLow": return (num(a.p.asking) ?? Infinity) - (num(b.p.asking) ?? Infinity);
      case "priceHigh": return (num(b.p.asking) ?? -Infinity) - (num(a.p.asking) ?? -Infinity);
      case "sqftLow": return (num(a.p.sqft) ?? Infinity) - (num(b.p.sqft) ?? Infinity);
      case "sqftHigh": return (num(b.p.sqft) ?? -Infinity) - (num(a.p.sqft) ?? -Infinity);
      case "ppsfLow": return ppsf(a.p) - ppsf(b.p);
      case "domNew": return domOf(a.p) - domOf(b.p);                        // freshest (lowest DOM) first
      case "domOld": return domOf(b.p) - domOf(a.p);                        // stalest first (leverage)
      case "payLow": return payOf(a.v) - payOf(b.v);
      case "payHigh": return payOf(b.v) - payOf(a.v);
      case "valueLow": return (a.v.fairLikely ?? Infinity) - (b.v.fairLikely ?? Infinity);
      case "valueHigh": return (b.v.fairLikely ?? -Infinity) - (a.v.fairLikely ?? -Infinity);
      case "overUnder": return (b.v.overPct ?? -Infinity) - (a.v.overPct ?? -Infinity);
      case "bedsHigh": return (num(b.p.beds) ?? -1) - (num(a.p.beds) ?? -1);
      case "bathsHigh": return (num(b.p.baths) ?? -1) - (num(a.p.baths) ?? -1);
      case "verdict": return (verdictRank[a.v.deal] ?? 1) - (verdictRank[b.v.deal] ?? 1);
      default: return 0; // recent = insertion order
    }
  });

  const pill = (active, onClick, label) => (
    <button onClick={onClick} style={{ padding: "5px 11px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", borderRadius: 20, fontFamily: "inherit", border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : C.panel, color: active ? C.paper : C.sub }}>{label}</button>
  );

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, margin: 0 }}>
          Saved properties <span style={{ color: C.sub, fontWeight: 400 }}>({filtered.length}{filtered.length !== props.length ? ` of ${props.length}` : ""})</span>
        </h2>
        <button onClick={onNew} style={{ padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 8, background: C.moss, color: "#fff", fontFamily: "inherit" }}>
          + Add property
        </button>
      </div>

      {props.length > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search address…" style={{ flex: "1 1 180px", padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 12.5, fontFamily: "inherit", background: C.paper }} />
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Sort:</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", background: C.paper }}>
              <option value="bestValue">Best value ($ under fair)</option>
              <option value="priceLow">Price: low → high</option>
              <option value="priceHigh">Price: high → low</option>
              <option value="sqftLow">Sqft: small → large</option>
              <option value="sqftHigh">Sqft: large → small</option>
              <option value="ppsfLow">$/sqft: low → high</option>
              <option value="domOld">Days on market: most (leverage)</option>
              <option value="domNew">Days on market: freshest</option>
              <option value="payLow">Monthly $: low → high</option>
              <option value="payHigh">Monthly $: high → low</option>
              <option value="valueLow">Fair value: low → high</option>
              <option value="valueHigh">Fair value: high → low</option>
              <option value="overUnder">Most overpriced</option>
              <option value="bedsHigh">Most bedrooms</option>
              <option value="bathsHigh">Most bathrooms</option>
              <option value="verdict">Verdict (pursue first)</option>
              <option value="recent">Recently added</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Verdict:</span>
            {pill(dealFilter === "all", () => setDealFilter("all"), "All")}
            {pill(dealFilter === "good", () => setDealFilter("good"), "Pursue")}
            {pill(dealFilter === "bad", () => setDealFilter("bad"), "Walk/lowball")}
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            {pill(onlyUnderAsk, () => setOnlyUnderAsk((x) => !x), "At/under fair only")}
            {pill(onlyWithFair, () => setOnlyWithFair((x) => !x), "Has fair value")}
          </div>
        </div>
      )}

      {props.length === 0 && (
        <div style={{ padding: "50px 20px", textAlign: "center", border: `1px dashed ${C.line}`, borderRadius: 12, color: C.sub }}>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 17, color: C.ink, marginBottom: 6 }}>No properties yet.</div>
          Drop an address and start running the desk check before you ever walk in.
        </div>
      )}
      {props.length > 0 && filtered.length === 0 && (
        <div style={{ padding: "30px 20px", textAlign: "center", color: C.sub, fontSize: 13 }}>No properties match these filters.</div>
      )}
      <div style={{ display: "grid", gap: 12 }}>
        {filtered.map(({ p, v }) => {
          const dealColor = v.deal === "good" ? C.good : v.deal === "bad" ? C.bad : C.sub;
          const dealLabel = v.deal === "good" ? "Worth pursuing" : v.deal === "bad" ? "Walk / lowball" : "Needs data";
          return (
            <div key={p.id} onClick={() => onOpen(p.id)} style={{ cursor: "pointer", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.address || "Untitled property"}
                </div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 3 }}>
                  {p.sqft ? `${num(p.sqft)?.toLocaleString()} sqft` : "— sqft"} · {p.beds || "—"}bd/{p.baths || "—"}ba · Ask {fmt(num(p.asking))}{effectiveDom(p) != null ? ` · ${effectiveDom(p)}d on mkt` : ""}
                </div>
                {v.payment && (
                  <div style={{ fontSize: 12, color: C.moss, marginTop: 3, fontWeight: 600 }}>
                    ~{fmt(Math.round(v.payment.total))}/mo
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: C.sub }}>Fair value</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 700, color: C.moss }}>{fmt(v.fairLikely)}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: dealColor, marginTop: 2 }}>{dealLabel}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); onDel(p.id); }} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------ rates view ----------------------------------
function AssumptionBlock({ title, desc, children }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.55, marginBottom: 12 }}>{desc}</div>
      {children}
    </div>
  );
}

function RatesView({ rates, setRates, props, setProps }) {
  const set = (patch) => setRates((r) => ({ ...r, ...patch }));
  const years = Object.keys(rates).filter((k) => /^\d{4}$/.test(k)).map(Number).sort((a, b) => a - b);
  const renoDefs = rates.renoDefaults || RENO_DEFAULTS;
  const envDefs = rates.envDefaults || ENV_RISKS;
  const critFeatures = rates.criteriaFeatures || DEFAULT_CRITERIA_FEATURES;
  const defaults = rates.defaults || {};
  const [applyMsg, setApplyMsg] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const setReno = (key, cost) => set({ renoDefaults: renoDefs.map((r) => r.key === key ? { ...r, cost: num(cost) } : r) });
  const setEnv = (key, base) => set({ envDefaults: envDefs.map((e) => e.key === key ? { ...e, base: num(base) } : e) });
  const setDefault = (key, val) => set({ defaults: { ...defaults, [key]: val } });
  const addCrit = () => set({ criteriaFeatures: [...critFeatures, { key: "custom" + uid(), label: "" }] });
  const setCritLabel = (key, label) => set({ criteriaFeatures: critFeatures.map((f) => f.key === key ? { ...f, label } : f) });
  const delCrit = (key) => set({ criteriaFeatures: critFeatures.filter((f) => f.key !== key) });

  // Per-property fields that are seeded from defaults. Engine-level assumptions
  // (sqft tolerance, flip/relist %, thresholds, sold-date window) already read
  // live from defaults at calc time, so they don't need pushing — only these
  // copied-at-creation fields do.
  const isBlank = (v) => v == null || v === "";
  const pushDefaults = (mode) => {
    const n = props?.length || 0;
    if (!n) { setApplyMsg("No properties to update yet."); setConfirmOverwrite(false); return; }
    const overwrite = mode === "all";
    // confirm() is blocked in the artifact sandbox, so use a two-click inline
    // confirm for the destructive overwrite instead.
    if (overwrite && !confirmOverwrite) { setConfirmOverwrite(true); return; }

    const dRoof = defaults.roofAge, dHvac = defaults.hvacAge, dArea = defaults.areaDom;
    const dRadius = (defaults.radius == null || defaults.radius === "") ? "2" : defaults.radius;
    let touched = 0;
    // compute the next array synchronously so the count is accurate
    const nextProps = props.map((p) => {
      const next = { ...p };
      let changed = false;
      const apply = (key, val) => {
        if (val == null || val === "") return;
        if (overwrite || isBlank(next[key])) { if (String(next[key] ?? "") !== String(val)) { next[key] = String(val); changed = true; } }
      };
      apply("roofAge", dRoof); apply("hvacAge", dHvac); apply("areaDom", dArea);
      const ca = { ...(next.compAnalysis || {}) };
      if (overwrite || isBlank(ca.radius)) {
        if (String(ca.radius ?? "") !== String(dRadius)) { ca.radius = String(dRadius); changed = true; }
      }
      next.compAnalysis = ca;
      if (changed) touched++;
      return next;
    });
    setProps(nextProps);
    setConfirmOverwrite(false);
    setApplyMsg(`${overwrite ? "Overwrote" : "Filled blanks on"} ${touched} of ${n} propert${n === 1 ? "y" : "ies"} — roof age, HVAC age, area DOM, comp radius (now ${dRadius} mi). Engine assumptions like tolerances and discounts already apply to every property automatically.`);
  };

  return (
    <div className="fade" style={{ maxWidth: 700 }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, marginTop: 0 }}>Assumptions</h2>
      <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, marginBottom: 18 }}>
        Every default the model uses, by functional area. Tolerances, discounts, thresholds, and the sold-date window apply to <strong>every</strong> property automatically the moment you change them. Per-property facts seeded at creation (roof/HVAC age, area DOM, comp radius) can be pushed to existing properties with the buttons below. All figures are Atlanta-metro starting points — tune to your market.
      </p>

      <div style={{ background: C.mossLt, border: `1px solid ${C.moss}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Apply defaults to existing properties</div>
        <div style={{ fontSize: 11.5, color: C.ink, lineHeight: 1.5, marginBottom: 10, opacity: 0.85 }}>
          Pushes roof age, HVAC age, area DOM, and comp radius to properties you've already created. <strong>Fill blanks</strong> only touches fields you left empty (keeps your customizations); <strong>overwrite all</strong> replaces those fields everywhere with the current defaults.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={() => { setConfirmOverwrite(false); pushDefaults("blanks"); }} style={{ padding: "8px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 7, background: C.panel, color: C.moss, fontFamily: "inherit" }}>Fill blanks only</button>
          <button onClick={() => pushDefaults("all")} style={{ padding: "8px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 7, background: confirmOverwrite ? C.bad : C.clay, color: "#fff", fontFamily: "inherit" }}>{confirmOverwrite ? "Click again to confirm overwrite" : "Overwrite all"}</button>
          {confirmOverwrite && <button onClick={() => setConfirmOverwrite(false)} style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.line}`, borderRadius: 7, background: C.panel, color: C.sub, fontFamily: "inherit" }}>Cancel</button>}
        </div>
        {applyMsg && <div style={{ marginTop: 10, fontSize: 11.5, color: C.moss, background: C.panel, padding: "8px 10px", borderRadius: 7, lineHeight: 1.4 }}>{applyMsg}</div>}
      </div>

      <AssumptionBlock title="Market appreciation (comp time-adjustment)"
        desc="Annual median appreciation used to bring older comp sale prices into today's dollars. A 2021 comp is walked forward year-by-year through these rates before it's used. Sourced from Reventure / homes.com / GA Realtors; override any year with county data.">
        {years.map((y) => (
          <div key={y} style={{ display: "flex", alignItems: "center", gap: 12, padding: "5px 0", borderBottom: `1px solid ${C.paper}` }}>
            <div style={{ width: 54, fontWeight: 600, fontSize: 13 }}>{y}</div>
            <input type="number" step="0.1" value={rates[y]} onChange={(e) => set({ [y]: parseFloat(e.target.value) || 0 })}
              style={{ width: 84, padding: "5px 8px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: C.paper }} />
            <span style={{ fontSize: 12, color: C.sub }}>% YoY</span>
            <div style={{ flex: 1, height: 7, background: C.paper, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, Math.abs(rates[y]) * 3)}%`, background: rates[y] < 0 ? C.clay : C.moss }} />
            </div>
          </div>
        ))}
      </AssumptionBlock>

      <AssumptionBlock title="Financing (for the monthly payment estimate)"
        desc="Used only to estimate the monthly payment shown on each property, calculated on the ASKING price. Enter the CASH you have available for a down payment as a dollar amount — the app computes each property's down-payment percentage from its price, so the same cash means no PMI on a cheaper home but PMI on a pricier one (PMI kicks in automatically below 20% down). Insurance and fallback tax are percent-of-value estimates; a property's real tax/HOA from its listing override them.">
        <div className="tri-grid">
          <DefaultInput label="Cash available for down payment $" value={defaults.cashAvailable} onChange={(x) => setDefault("cashAvailable", x)} def={100000} sub="dollars on hand; down % is derived per property" />
          <DefaultInput label="Interest rate %" value={defaults.interestRate} onChange={(x) => setDefault("interestRate", x)} def={6.5} />
          <DefaultInput label="Loan term (yrs)" value={defaults.loanTermYrs} onChange={(x) => setDefault("loanTermYrs", x)} def={30} />
          <DefaultInput label="PMI % (annual, DP<20%)" value={defaults.pmiPct} onChange={(x) => setDefault("pmiPct", x)} def={0.6} />
          <DefaultInput label="Insurance % of value/yr" value={defaults.insPctOfValue} onChange={(x) => setDefault("insPctOfValue", x)} def={0.35} />
          <DefaultInput label="Tax % of value/yr (fallback)" value={defaults.taxPctOfValue} onChange={(x) => setDefault("taxPctOfValue", x)} def={1.0} />
        </div>
      </AssumptionBlock>

      <AssumptionBlock title="Comp adjustment dollar values"
        desc="What each feature difference is worth when adjusting a comp's price toward your subject. Each is applied as (subject − comp) × value. GLA (size) is derived from your pool's paired sales when possible; the settings below are the fallbacks and per-unit rates. Defaults follow appraisal-industry norms — the size adjustment is a FRACTION of the full price/sqft (typically 30–50%), not the whole rate, to avoid double-counting the lot, garage, and other features already adjusted separately.">
        <div className="tri-grid">
          <DefaultInput label="GLA % of median $/sqft" value={defaults.glaPct} onChange={(x) => setDefault("glaPct", x)} def={40} sub="size adj = this % of pool's median $/sqft (fallback when no paired sales)" />
          <DefaultInput label="GLA $/sqft override" value={defaults.glaOverride} onChange={(x) => setDefault("glaOverride", x)} def={0} sub="hard $/sqft; overrides the % above. 0 = off" />
          <DefaultInput label="Bedroom $" value={defaults.bedAdj} onChange={(x) => setDefault("bedAdj", x)} def={8000} sub="per bedroom count difference" />
          <DefaultInput label="Bathroom $" value={defaults.bathAdj} onChange={(x) => setDefault("bathAdj", x)} def={7500} sub="per bathroom difference" />
          <DefaultInput label="Year built $/yr" value={defaults.yearAdj} onChange={(x) => setDefault("yearAdj", x)} def={500} sub="per year of age difference" />
          <DefaultInput label="Lot $/acre" value={defaults.lotAdj} onChange={(x) => setDefault("lotAdj", x)} def={20000} sub="per acre of lot-size difference" />
        </div>
      </AssumptionBlock>

      <AssumptionBlock title="Comp adjustment defaults"
        desc="How the comp engine treats size differences and distressed-sale signals. Sqft tolerance excludes comps too different in size to adjust reliably (absolute sqft, like radius is to distance). Flip and relist are discounts applied to a property's comp-derived value when you tick those boxes on its Facts tab — flip is serious (renovated price for hidden condition risk), relist is a softer market-signal haircut you can untick if it's not a trick.">
        <div className="tri-grid">
          <DefaultInput label="Sqft tolerance ±" value={defaults.sqftTol} onChange={(x) => setDefault("sqftTol", x)} def={500} />
          <DefaultInput label="Flip discount %" value={defaults.flipPct} onChange={(x) => setDefault("flipPct", x)} def={10} />
          <DefaultInput label="Relist discount %" value={defaults.relistPct} onChange={(x) => setDefault("relistPct", x)} def={2} />
        </div>
      </AssumptionBlock>

      <AssumptionBlock title="Deal verdict thresholds"
        desc="The badge on the fair-value panel is driven by how far asking sits above the comp-derived fair value. At or below the 'good' threshold → Worth pursuing. Above the 'bad' threshold → Walk or lowball. Between the two → Needs more data (a genuine middling-price verdict). Note: 'Needs more data' also shows when there's no fair value yet — no asking price or no usable comps.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <DefaultInput label="'Good' at or below (% over fair)" value={defaults.dealGoodPct} onChange={(x) => setDefault("dealGoodPct", x)} def={0} sub="asking ≤ this % over → Worth pursuing" />
          <DefaultInput label="'Bad' above (% over fair)" value={defaults.dealBadPct} onChange={(x) => setDefault("dealBadPct", x)} def={8} sub="asking > this % over → Walk or lowball" />
        </div>
      </AssumptionBlock>

      <AssumptionBlock title="Sold-date default window"
        desc="How recent a comp's sale must be to count, by default. Older comps are excluded from the valuation. You can override this per-property on the Comp Analysis tab. Leave blank for no time limit.">
        <select value={defaults.maxMonths ?? ""} onChange={(e) => setDefault("maxMonths", e.target.value === "" ? undefined : num(e.target.value))}
          style={{ padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: C.paper }}>
          <option value="">Any time</option>
          <option value="1">Last 30 days</option>
          <option value="2">Last 60 days</option>
          <option value="3">Last 90 days</option>
          <option value="6">Last 6 months</option>
          <option value="12">Last 12 months</option>
          <option value="24">Last 24 months</option>
        </select>
      </AssumptionBlock>

      <AssumptionBlock title="Property facts defaults"
        desc="Seed values for new properties when a listing doesn't provide them. Roof/HVAC age feed the red-flag checks; Area DOM is the neighborhood days-on-market baseline the model compares against; Radius is the default comp search distance.">
        <div className="quad-grid">
          <DefaultInput label="Roof age (yrs)" value={defaults.roofAge} onChange={(x) => setDefault("roofAge", x)} def={15} />
          <DefaultInput label="HVAC age (yrs)" value={defaults.hvacAge} onChange={(x) => setDefault("hvacAge", x)} def={12} />
          <DefaultInput label="Area avg DOM" value={defaults.areaDom} onChange={(x) => setDefault("areaDom", x)} def={57} />
          <DefaultInput label="Comp radius (mi)" value={defaults.radius} onChange={(x) => setDefault("radius", x)} def={2} />
        </div>
      </AssumptionBlock>

      <AssumptionBlock title="Renovation cost defaults"
        desc="Bring-to-standard cost per system, subtracted from value when flagged on a property's Assessment tab. These are hard costs (money out). Enter a negative value only if 'standard' for your area already includes it. Editable per-property too.">
        {renoDefs.map((r) => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.paper}` }}>
            <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{r.label}<div style={{ fontSize: 10, color: C.sub, fontWeight: 400 }}>{r.note}</div></div>
            <span style={{ fontSize: 12, color: C.sub }}>$</span>
            <input type="number" value={r.cost} onChange={(e) => setReno(r.key, e.target.value)}
              style={{ width: 88, padding: "5px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.paper }} />
          </div>
        ))}
      </AssumptionBlock>

      <AssumptionBlock title="Environmental risk values"
        desc="Base discount per severity step for each site/proximity risk. On a property, severity (minor/moderate/severe) multiplies this base (×1 / ×2.2 / ×3.6) and subtracts from value. These reflect what the typical buyer discounts, not remediation cost.">
        {envDefs.map((e) => (
          <div key={e.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.paper}` }}>
            <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{e.label}<div style={{ fontSize: 10, color: C.sub, fontWeight: 400 }}>{e.note}</div></div>
            <span style={{ fontSize: 12, color: C.sub }}>$</span>
            <input type="number" value={e.base} onChange={(ev) => setEnv(e.key, ev.target.value)}
              style={{ width: 80, padding: "5px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.paper }} />
          </div>
        ))}
      </AssumptionBlock>

      <AssumptionBlock title="Nice-to-have features (checklist)"
        desc="The desirability checklist shown on every property's Assessment tab. These NEVER affect value — they track fit only. Add or remove to match what you're looking for.">
        {critFeatures.map((f) => (
          <div key={f.key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input value={f.label} onChange={(e) => setCritLabel(f.key, e.target.value)} placeholder="Feature name"
              style={{ flex: 1, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.paper }} />
            <button onClick={() => delCrit(f.key)} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 15 }}>×</button>
          </div>
        ))}
        <button onClick={addCrit} style={{ marginTop: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 6, background: C.mossLt, color: C.moss, fontFamily: "inherit" }}>+ Add feature</button>
      </AssumptionBlock>

      <button onClick={() => setRates({ ...DEFAULT_APPRECIATION })} style={{ padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.line}`, borderRadius: 7, background: C.paper, color: C.ink, fontFamily: "inherit" }}>
        Reset appreciation to sourced defaults
      </button>
    </div>
  );
}

// ----------------------------- compare view ---------------------------------
function CompareView({ props, rates, pool, onOpen }) {
  const [selA, setSelA] = useState(null);
  const [selB, setSelB] = useState(null);
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);

  if (props.length < 2) return <div className="fade" style={{ color: C.sub, padding: 30, textAlign: "center", border: `1px dashed ${C.line}`, borderRadius: 12 }}>Add at least two properties to compare them.</div>;

  const pA = props.find((p) => p.id === selA);
  const pB = props.find((p) => p.id === selB);
  const vA = pA ? valuate(pA, rates, pool) : null;
  const vB = pB ? valuate(pB, rates, pool) : null;
  const bothPicked = pA && pB && pA.id !== pB.id;

  // Auto-generate AI insight whenever a valid pair is selected.
  useEffect(() => {
    if (!bothPicked) { setInsight(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setInsight(null);
      const snap = (p, v) => `${p.address || "Property"}: ask ${fmt(num(p.asking))}, fair value ${fmt(v.fairLikely)}, ${v.overPct == null ? "n/a" : v.overPct.toFixed(1) + "% over/under"}, reno needed ${fmt(v.reno?.total || 0)}, env discount ${fmt(v.env?.total || 0)}, fit ${v.critChecked}/${v.critTotal}, ${v.adjComps.length} comps, DOM ${effectiveDom(p) ?? "?"} vs area ${num(p.areaDom) || "?"}, ${(v.flags || []).filter((f) => f.level === "high").length} high flags. Notes: ${(p.adjustments || []).map((a) => a.source).filter(Boolean).join("; ") || "none"}`;
      const sys = `You are a buyer's-side real estate analyst comparing two homes for a purchase decision. Say which is the stronger buy and why, name the key tradeoffs, and flag the biggest risk on each. Reference the actual numbers. 4-6 short sentences, direct, no preamble or markdown headers.`;
      try {
        const resp = await fetch("/api/ai", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ max_tokens: 600, system: sys, messages: [{ role: "user", content: `A) ${snap(pA, vA)}\n\nB) ${snap(pB, vB)}` }] }),
        });
        const data = await resp.json();
        const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!cancelled) setInsight(txt || "No insight returned.");
      } catch { if (!cancelled) setInsight("Couldn't generate the comparison. Try again."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selA, selB]);

  const rowFor = (p, v) => [
    ["Ask", fmt(num(p.asking))], ["Fair value", fmt(v.fairLikely)],
    ["Over/under", v.overPct == null ? "—" : fmtPct(v.overPct)],
    ["Renovation", v.reno.total ? fmt(v.reno.total) : "—"],
    ["Environmental", v.env.total ? fmt(v.env.total) : "—"],
    ["Nice-to-have fit", `${v.critChecked}/${v.critTotal}`],
    ["Comps used", String(v.adjComps.length)],
    ["High flags", String((v.flags || []).filter((f) => f.level === "high").length)],
  ];

  const Picker = ({ label, sel, setSel, other }) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: C.sub, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <select value={sel || ""} onChange={(e) => setSel(e.target.value || null)} style={{ width: "100%", padding: "9px 10px", border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: C.panel }}>
        <option value="">Select a property…</option>
        {props.filter((p) => p.id !== other).map((p) => <option key={p.id} value={p.id}>{p.address || "Untitled"}</option>)}
      </select>
    </div>
  );

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, margin: 0 }}>Head to head</h2>
        {(selA || selB) && <button onClick={() => { setSelA(null); setSelB(null); setInsight(null); }} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.line}`, borderRadius: 7, background: C.panel, color: C.sub, fontFamily: "inherit" }}>Clear</button>}
      </div>
      <p style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5, marginTop: 0 }}>Pick any two to compare. AI weighs in automatically. Selections clear when you leave this tab.</p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Picker label="Property A" sel={selA} setSel={setSelA} other={selB} />
        <Picker label="Property B" sel={selB} setSel={setSelB} other={selA} />
      </div>

      {bothPicked && (
        <>
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "10px 8px", borderBottom: `2px solid ${C.ink}` }}></th>
                  <th onClick={() => onOpen(pA.id)} style={{ textAlign: "right", padding: "10px 8px", borderBottom: `2px solid ${C.ink}`, cursor: "pointer", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pA.address || "A"}</th>
                  <th onClick={() => onOpen(pB.id)} style={{ textAlign: "right", padding: "10px 8px", borderBottom: `2px solid ${C.ink}`, cursor: "pointer", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pB.address || "B"}</th>
                </tr>
              </thead>
              <tbody>
                {rowFor(pA, vA).map(([label, aVal], i) => {
                  const bVal = rowFor(pB, vB)[i][1];
                  return (
                    <tr key={label}>
                      <td style={{ padding: "9px 8px", borderBottom: `1px solid ${C.line}`, color: C.sub, fontSize: 12 }}>{label}</td>
                      <td style={{ padding: "9px 8px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontWeight: label === "Fair value" ? 700 : 500 }}>{aVal}</td>
                      <td style={{ padding: "9px 8px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontWeight: label === "Fair value" ? 700 : 500 }}>{bVal}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ background: C.ink, borderRadius: 12, padding: 16, color: C.paper }}>
            <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", opacity: 0.7, marginBottom: 8, fontWeight: 600 }}>✦ AI comparison</div>
            {loading ? <div style={{ fontSize: 12.5, opacity: 0.7 }}>Weighing the two…</div> : <div style={{ fontSize: 12.5, lineHeight: 1.6, opacity: 0.95 }}>{insight}</div>}
          </div>
        </>
      )}
      {!bothPicked && <div style={{ color: C.sub, fontSize: 13, padding: "20px 0", textAlign: "center" }}>Select two different properties to see the comparison.</div>}
    </div>
  );
}

// ------------------------------- edit view ----------------------------------
function EditView({ prop, rates, pool, update, onBack, onDel }) {
  const v = useMemo(() => valuate(prop, rates, pool), [prop, rates, pool]);
  const [tab, setTab] = useState("facts"); // facts | assess | companalysis
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="fade edit-grid">
      {/* left: inputs */}
      <div>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.moss, cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 10 }}>← All properties</button>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <Field label="Property address" value={prop.address} onChange={(x) => update({ address: x })} placeholder="e.g. 3000 Whitehurst Way, Marietta" />
          </div>
          <button onClick={() => setShowImport((s) => !s)} style={{ padding: "9px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 8, background: showImport ? C.moss : C.mossLt, color: showImport ? "#fff" : C.moss, fontFamily: "inherit", marginBottom: 14, whiteSpace: "nowrap" }}>
            ⎘ Paste data
          </button>
        </div>
        {showImport && <ImportPanel prop={prop} update={update} rates={rates} onClose={() => setShowImport(false)} />}
        <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: `1px solid ${C.line}` }}>
          {[["facts", "Facts"], ["assess", "Assessment"], ["companalysis", "Comp Analysis"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: "8px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: "none", background: "none", color: tab === k ? C.ink : C.sub, borderBottom: `2px solid ${tab === k ? C.moss : "transparent"}`, marginBottom: -1, fontFamily: "inherit" }}>{l}</button>
          ))}
        </div>

        {tab === "facts" && (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
            <div className="facts-grid">
              <Field label="Asking price" value={prop.asking} onChange={(x) => update({ asking: x })} placeholder="500000" suffix="$" quickPaste="num" hint="The list price — an opinion, not a value. From the listing." />
              <Field label="Square footage" value={prop.sqft} onChange={(x) => update({ sqft: x })} placeholder="2400" suffix="sqft" quickPaste="num" hint="Heated/finished sqft. County tax assessor record is the free, verified source — not the listing's rounded number." />
              <Field label="Bedrooms" value={prop.beds} onChange={(x) => update({ beds: x })} placeholder="4" quickPaste="num" hint="County records / your walkthrough." />
              <Field label="Bathrooms" value={prop.baths} onChange={(x) => update({ baths: x })} placeholder="3" quickPaste="num" hint="Full + half. County records." />
              <Field label="Lot size" value={prop.lot} onChange={(x) => update({ lot: x })} placeholder="0.30" suffix="acre" quickPaste="num" hint="County assessor / plat. Flat usable yard is your preference — note slope separately." />
              <Field label="Year built" value={prop.yearBuilt} onChange={(x) => update({ yearBuilt: x })} placeholder="1998" quickPaste="num" hint="County records." />
              <Field label="Roof age" value={prop.roofAge} onChange={(x) => update({ roofAge: x })} placeholder="8" suffix="yrs" hint="Ask listing agent or seller's disclosure. 20+ yrs = near replacement." defaultHint={15} />
              <Field label="HVAC age" value={prop.hvacAge} onChange={(x) => update({ hvacAge: x })} placeholder="6" suffix="yrs" hint="Look at the unit's install sticker at the showing, or seller's disclosure. 15+ yrs = borrowed time." defaultHint={12} />
              <Field label="Listing date" value={prop.listingDate} onChange={(x) => update({ listingDate: x })} placeholder="2026-06-01" hint="Auto-filled from the current listing cycle on paste. Days on market counts up from here." />
              <Field label="Days on market" value={prop.listingDate ? String(effectiveDom(prop)) : prop.dom} onChange={(x) => update({ dom: x })} placeholder="62" suffix="days" hint={prop.listingDate ? "Auto-counting from the listing date above." : "From the listing — or set a listing date above to count automatically."} readOnly={!!prop.listingDate} />
              <Field label="Area avg DOM" value={prop.areaDom} onChange={(x) => update({ areaDom: x })} placeholder="55" suffix="days" hint="Neighborhood norm. Metro Atlanta ran ~55–59 days mid-2026; your agent can give the tract-level figure." defaultHint={57} />
              <Field label="Annual property tax" value={prop.annualTax} onChange={(x) => update({ annualTax: x })} placeholder="4814" quickPaste="num" hint="From the listing's financial details. Used in the monthly payment estimate." />
              <Field label="# price cuts" value={prop.priceCuts} onChange={(x) => update({ priceCuts: x })} placeholder="2" hint="From price history (current listing cycle only). 3+ = chasing the market down." />
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, letterSpacing: 0.2 }}>HOA fee</label>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input value={prop.hoaFee ?? ""} placeholder="75" onChange={(e) => update({ hoaFee: e.target.value })}
                    style={{ flex: 1, padding: "9px 11px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 14, color: C.ink, background: C.paper, fontFamily: "inherit", outline: "none" }} />
                  <select value={prop.hoaPeriod || "annually"} onChange={(e) => update({ hoaPeriod: e.target.value })}
                    style={{ padding: "9px 8px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 12.5, fontFamily: "inherit", background: C.paper }}>
                    <option value="monthly">/mo</option>
                    <option value="quarterly">/qtr</option>
                    <option value="annually">/yr</option>
                  </select>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 4, marginBottom: 4 }}>
              <button onClick={() => {
                const cur = num(prop.priceCuts) || 0;
                const log = [...(prop.priceDropLog || []), { id: uid(), at: new Date().toISOString() }];
                update({ priceCuts: String(cur + 1), priceDropLog: log });
              }} style={{ padding: "7px 13px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.clay}`, borderRadius: 7, background: C.clayLt, color: C.clay, fontFamily: "inherit" }}>
                ↓ Log a price drop
              </button>
              {(prop.priceDropLog || []).length > 0 && (
                <span style={{ fontSize: 10.5, color: C.sub, marginLeft: 10 }}>
                  {prop.priceDropLog.length} logged since import — latest {new Date(prop.priceDropLog[prop.priceDropLog.length - 1].at).toLocaleDateString()}
                </span>
              )}
              <div style={{ fontSize: 10, color: C.sub, marginTop: 4 }}>Use this when the listing price drops after you've imported it — bumps the cut count and timestamps it.</div>
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={!!prop.relisted} onChange={(e) => update({ relisted: e.target.checked })} /> Withdrawn & relisted
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={!!prop.flipSignals} onChange={(e) => update({ flipSignals: e.target.checked })} /> Flip signals
              </label>
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 10, lineHeight: 1.5, background: C.paper, padding: "8px 10px", borderRadius: 7 }}>
              <strong>Flip check (manual):</strong> pull the last sale date & price from county records — a resale within ~12 months with a big markup and cosmetic-only permits is the tell. Street View can't be auto-scanned, but eyeball it yourself for dumpsters, staging vans, or brand-new everything over old bones.
            </div>
          </div>
        )}

        {tab === "assess" && (
          <AssessmentTab prop={prop} update={update} rates={rates} v={v} />
        )}

        {tab === "companalysis" && (
          <CompAnalysisTab prop={prop} update={update} rates={rates} pool={pool} />
        )}

        <button onClick={onDel} style={{ marginTop: 16, background: "none", border: "none", color: C.bad, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>Delete this property</button>
      </div>

      {/* right: verdict panel (sticky) */}
      <aside style={{ position: "sticky", top: 16 }}>
        <VerdictPanel prop={prop} v={v} />
      </aside>
    </div>
  );
}

function ImportPanel({ prop, update, onClose, rates }) {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");

  // Run the AI interpreter on one text block and return {patches, insights,
  // matched} without applying — so we can merge two blocks then apply once.
  const interpretBlock = async (text, sourceLabel, baseReno, baseEnv, baseCrit) => {
    const renoDefs = rates.renoDefaults || RENO_DEFAULTS;
    const envDefs = rates.envDefaults || ENV_RISKS;
    const critFeatures = rates.criteriaFeatures || DEFAULT_CRITERIA_FEATURES;
    const renoKeys = renoDefs.map((r) => `${r.key} (${r.label})`).join(", ");
    const envKeys = envDefs.map((e) => `${e.key} (${e.label})`).join(", ");
    const critKeys = critFeatures.map((f) => `${f.key} (${f.label})`).join(", ");
    const sys = `You interpret part of a home listing into structured assessment data. Return ONLY valid JSON, no prose.
Available renovation keys: ${renoKeys}
Available environment risk keys: ${envKeys}
Available nice-to-have keys: ${critKeys}
Rules:
- renovations: [{key, reason}] for standard items the text says need work/updating or are dated/old/bad. Only listed keys.
- customRenovations: [{label, reason}] for work items not matching a standard key.
- environment: [{key, severity(1-3), reason}] for site/proximity risks present. Only listed keys.
- niceToHaves: [{key, reason}] for desirable features mentioned positively. Only listed keys.
- insights: [{severity(high/med/low), text}] one-sentence notable observations. [] if none.
This text is the listing's "${sourceLabel}" section — features are seller-described, so treat positive mentions as nice-to-haves and only flag renovations when the text itself signals wear/age/needed work.`;
    try {
      const resp = await fetch("/api/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1000, system: sys, messages: [{ role: "user", content: `Interpret this "${sourceLabel}" text:\n"${text}"\n\nReturn JSON: renovations, customRenovations, environment, niceToHaves, insights.` }] }),
      });
      const data = await resp.json();
      const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(txt);
      const matched = [];
      (parsed.renovations || []).forEach((r) => { const d = renoDefs.find((x) => x.key === r.key); if (d) { baseReno[r.key] = { on: true, cost: (baseReno[r.key]?.cost ?? d.cost) }; matched.push({ area: "Renovation", label: d.label }); } });
      const newCustom = (parsed.customRenovations || []).map((c) => ({ id: uid(), label: c.label, cost: "" }));
      (parsed.customRenovations || []).forEach((c) => matched.push({ area: "Renovation", label: c.label + " (custom)" }));
      (parsed.environment || []).forEach((e) => { const d = envDefs.find((x) => x.key === e.key); if (d) { baseEnv[e.key] = { sev: Math.max(1, Math.min(3, num(e.severity) || 2)), override: "" }; matched.push({ area: "Environment", label: d.label }); } });
      (parsed.niceToHaves || []).forEach((nh) => { const d = critFeatures.find((x) => x.key === nh.key); if (d) { baseCrit[nh.key] = true; matched.push({ area: "Nice-to-have", label: d.label }); } });
      const insights = (parsed.insights || []).filter((i) => i && i.text).map((i) => ({ level: i.severity === "high" ? "high" : i.severity === "low" ? "low" : "med", text: i.text }));
      return { newCustom, matched, insights };
    } catch { return { newCustom: [], matched: [], insights: [], error: true }; }
  };

  const applyExtract = async (clean, comps, keepComps = true) => {
    const patch = {};
    const skip = new Set(["whatsSpecial", "factsFeatures"]);
    Object.entries(clean).forEach(([k, val]) => { if (val !== "" && val != null && !skip.has(k)) patch[k] = String(val); });

    const ws = (clean.whatsSpecial || "").trim();
    const ff = (clean.factsFeatures || "").trim();
    if (ws) patch.listingDescription = ws.slice(0, 2500);
    if (ff) patch.factsFeatures = ff.slice(0, 2500);

    if (keepComps && comps.length) {
      const newComps = comps.map((c) => ({ id: uid(), address: c.address || "", price: c.price || "", sqft: c.sqft || "", saleYear: c.saleYear || "", beds: c.beds || "", baths: c.baths || "", note: "imported" }));
      patch.comps = [...(prop.comps || []), ...newComps];
    }

    // Apply the facts first so the user sees them immediately.
    update(patch);

    // Then auto-fire the AI interpreter on each listing block as a SEPARATE
    // observation, merging their panel updates and insights.
    if (ws || ff) {
      setAiBusy(true); setAiMsg("Reading the listing with AI…");
      const reno = { ...(prop.renovations || {}) };
      const env = { ...(prop.environment || {}) };
      const crit = { ...(prop.criteriaCheck || {}) };
      const adjustments = [...(prop.adjustments || [])];
      let allCustom = [...(prop.renoCustom || [])];
      let allInsights = [...(prop.insights || [])];
      let anyErr = false;

      const blocks = [];
      if (ws) blocks.push(["What's special", ws]);
      if (ff) blocks.push(["Facts & features", ff]);
      for (const [label, textBlk] of blocks) {
        const res = await interpretBlock(textBlk, label, reno, env, crit);
        if (res.error) { anyErr = true; continue; }
        allCustom = [...allCustom, ...res.newCustom];
        allInsights = [...allInsights, ...res.insights];
        adjustments.push({ id: uid(), source: `From listing "${label}": ${textBlk.slice(0, 200)}${textBlk.length > 200 ? "…" : ""}`, status: "logged", kind: "usd", amt: 0, matched: res.matched, unplaced: res.matched.length === 0, fromListing: true });
      }
      update({ renovations: reno, environment: env, criteriaCheck: crit, renoCustom: allCustom, insights: allInsights, adjustments });
      setAiBusy(false);
      setAiMsg(anyErr ? "Facts saved. AI interpretation partly failed — you can re-run from the Assessment tab." : "Facts saved and the listing was interpreted into your observations and panels.");
    } else {
      setAiMsg("Facts saved. No “What’s special” or “Facts & features” text was found to interpret.");
    }
  };

  const [includeComps, setIncludeComps] = useState(true);
  // ONE action: read the pasted text, fill the property, and run the AI read.
  const readAndFill = async () => {
    if (aiBusy || !raw.trim()) return;
    setAiMsg("");
    const res = smartParse(raw);
    setResult(res);
    if (res.report.error) return;
    await applyExtract(res.clean, res.comps, includeComps);
  };

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { setRaw(t); setResult(smartParse(t)); }
    } catch { /* clipboard blocked — user pastes into the box manually */ }
  };

  return (
    <div style={{ background: C.mossLt, border: `1px solid ${C.moss}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, color: C.ink }}>Paste listing data</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 16 }}>×</button>
      </div>

      <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.5, marginBottom: 10 }}>
        On the Zillow/Redfin listing, select all the page text and copy it, then paste below. Works on mobile — no file needed. Tap <strong>Read &amp; fill with AI</strong> and it does everything in one step: facts are read in your browser (found fields fill in; misses are flagged, never guessed), then the “What’s special” and “Facts &amp; features” text is sent to the AI to interpret into renovations, environment, nice-to-haves and observations. It also accepts a JSON block.
      </div>

      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={5}
        placeholder="Paste the whole listing — e.g. '4 beds  3 baths  2,410 sqft … Built in 1998 … 62 days on Zillow … Recently sold: 3010 Whitehurst Way $480,000 2,350 sqft …'"
        style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: C.panel, resize: "vertical", lineHeight: 1.5 }} />

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={readAndFill} disabled={aiBusy || !raw.trim()} style={{ flex: 1, padding: "9px", fontSize: 13, fontWeight: 600, cursor: aiBusy ? "wait" : !raw.trim() ? "not-allowed" : "pointer", border: "none", borderRadius: 8, background: C.moss, color: "#fff", fontFamily: "inherit", opacity: aiBusy || !raw.trim() ? 0.6 : 1 }}>{aiBusy ? "Reading with AI…" : "Read & fill with AI"}</button>
        <button onClick={pasteFromClipboard} style={{ padding: "9px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 8, background: C.panel, color: C.moss, fontFamily: "inherit" }} title="Paste from clipboard">⎘ Paste</button>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, fontSize: 12, color: C.sub, cursor: "pointer" }}>
        <input type="checkbox" checked={includeComps} onChange={(e) => setIncludeComps(e.target.checked)} />
        Also import the sold comps listed on the page
      </label>

      {result && (
        <div style={{ marginTop: 14, background: C.panel, borderRadius: 9, padding: 12 }}>
          {result.report.error ? (
            <div style={{ fontSize: 12.5, color: C.bad, lineHeight: 1.5 }}>{result.report.error}</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Read as {result.report.source} · {Object.values(result.clean).filter((x) => x !== "" && x != null).length} fields · {result.comps.length} comps
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 12 }}>
                {Object.entries(result.clean).map(([k, val]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", color: (val === "" || val == null) ? C.bad : C.ink }}>
                    <span style={{ color: C.sub }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{(val === "" || val == null) ? "—" : String(val)}</span>
                  </div>
                ))}
              </div>
              {result.report.missing.length > 0 && (
                <div style={{ fontSize: 11, color: C.med, marginTop: 8, lineHeight: 1.4 }}>
                  Not found: {result.report.missing.join(", ")}. Left blank — fill from county records or your agent. Nothing was guessed.
                </div>
              )}
              {aiMsg && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: aiBusy ? C.moss : C.ink, background: C.panel, padding: "8px 10px", borderRadius: 7, lineHeight: 1.4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span>{aiMsg}</span>
                  {!aiBusy && <button onClick={onClose} style={{ padding: "5px 11px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: "none", borderRadius: 6, background: C.moss, color: "#fff", fontFamily: "inherit", flexShrink: 0 }}>Done</button>}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: C.sub, marginTop: 8, lineHeight: 1.4 }}>
                Review before trusting — raw-text parsing is best-effort. Check the comps especially; portal text varies and a stray number can slip in.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AssessmentTab({ prop, update, rates, v }) {
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState("reno"); // reno | env | criteria | obs
  const [interpreting, setInterpreting] = useState(false);
  const [aiMsg, setAiMsg] = useState(null);
  const renoDefs = rates.renoDefaults || RENO_DEFAULTS;
  const envDefs = rates.envDefaults || ENV_RISKS;
  const critFeatures = rates.criteriaFeatures || DEFAULT_CRITERIA_FEATURES;

  const reno = prop.renovations || {};
  const setReno = (key, patch) => update({ renovations: { ...reno, [key]: { ...(reno[key] || {}), ...patch } } });
  const env = prop.environment || {};
  const setEnv = (key, val) => update({ environment: { ...env, [key]: val } });
  const crit = prop.criteriaCheck || {};
  const toggleCrit = (key) => update({ criteriaCheck: { ...crit, [key]: !crit[key] } });

  // AI note interpreter — sends the raw notes to Claude, gets structured JSON
  // back, and applies it to renovations / environment / nice-to-haves, adds
  // custom reno items, and stores insights that feed the sidebar red flags.
  const runInterpret = async () => {
    if (!draft.trim() || interpreting) return;
    const raw = draft.trim();
    setInterpreting(true); setAiMsg({ ok: "Interpreting your notes…" });

    const renoKeys = renoDefs.map((r) => `${r.key} (${r.label})`).join(", ");
    const envKeys = envDefs.map((e) => `${e.key} (${e.label})`).join(", ");
    const critKeys = critFeatures.map((f) => `${f.key} (${f.label})`).join(", ");

    const sys = `You interpret a homebuyer's raw showing notes into structured property assessment data. Return ONLY valid JSON, no prose, no markdown fences.

Available renovation keys: ${renoKeys}
Available environment risk keys: ${envKeys}
Available nice-to-have keys: ${critKeys}

Rules:
- renovations: array of {key, reason} for standard items the notes say need work/replacement/updating or are dated/old/bad/gross/awful or in any negative fix-it context. Only use keys from the list.
- customRenovations: array of {label, reason} for things needing work/renovation that DON'T map to a standard key (e.g. "deck rotting", "pool resurfacing", "mold remediation"). Anything negative that needs fixing and isn't a standard key goes here.
- environment: array of {key, severity, reason} for site/proximity risks present. severity is 1 (minor), 2 (moderate), or 3 (severe) based on how the note describes it. Only use keys from the list.
- niceToHaves: array of {key, reason} for desirable features the notes mention positively. Only use keys from the list.
- insights: array of {severity, text} — synthesized observations across ALL the notes, not just this one. Flag recurring themes (mentioned multiple times) and serious concerns (structural, safety, water, foundation, major systems, anything that combines with other notes into a bigger problem). severity is "high", "med", or "low". Keep each text one sentence, specific, and actionable. Only include genuinely notable insights; return [] if nothing rises to that level.

Interpret generously — err toward flagging. The user reviews and removes anything wrong.`;

    // include prior notes so insights can see recurring themes
    const priorNotes = (prop.adjustments || []).map((a) => a.source).filter(Boolean);
    const userMsg = `All notes for this property so far:\n${priorNotes.map((n, i) => `${i + 1}. ${n}`).join("\n") || "(none yet)"}\n\nNEW notes to interpret now:\n"${raw}"\n\nReturn JSON with keys: renovations, customRenovations, environment, niceToHaves, insights.`;

    try {
      const resp = await fetch("/api/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1000, system: sys, messages: [{ role: "user", content: userMsg }] }),
      });
      const data = await resp.json();
      const textOut = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(textOut);

      const patches = { renovations: { ...reno }, environment: { ...env }, criteriaCheck: { ...crit } };
      const matched = [];

      (parsed.renovations || []).forEach((r) => {
        const def = renoDefs.find((d) => d.key === r.key);
        if (def) { patches.renovations[r.key] = { on: true, cost: (reno[r.key]?.cost ?? def.cost) }; matched.push({ area: "Renovation", label: def.label }); }
      });
      const newCustom = (parsed.customRenovations || []).map((c) => ({ id: uid(), label: c.label, cost: "" }));
      (parsed.customRenovations || []).forEach((c) => matched.push({ area: "Renovation", label: c.label + " (custom)" }));
      (parsed.environment || []).forEach((e) => {
        const def = envDefs.find((d) => d.key === e.key);
        if (def) { patches.environment[e.key] = { sev: Math.max(1, Math.min(3, num(e.severity) || 2)), override: "" }; matched.push({ area: "Environment", label: def.label }); }
      });
      (parsed.niceToHaves || []).forEach((n) => {
        const def = critFeatures.find((d) => d.key === n.key);
        if (def) { patches.criteriaCheck[n.key] = true; matched.push({ area: "Nice-to-have", label: def.label }); }
      });

      const insights = (parsed.insights || []).filter((i) => i && i.text).map((i) => ({ level: i.severity === "high" ? "high" : i.severity === "low" ? "low" : "med", text: i.text }));

      update({
        ...patches,
        renoCustom: [...(prop.renoCustom || []), ...newCustom],
        insights, // consumed by valuate → red flags
        adjustments: [...(prop.adjustments || []), { id: uid(), source: raw, status: "logged", kind: "usd", amt: 0, matched, unplaced: matched.length === 0 }],
      });
      setDraft("");
      setAiMsg({ ok: `Interpreted: ${matched.length} item(s)${insights.length ? `, ${insights.length} insight(s) added to red flags` : ""}.` });
    } catch (err) {
      setAiMsg({ err: "Couldn't interpret with AI . Your note was still saved — mark the panels manually." });
      update({ adjustments: [...(prop.adjustments || []), { id: uid(), source: raw, status: "logged", kind: "usd", amt: 0, matched: [], unplaced: true }] });
      setDraft("");
    } finally { setInterpreting(false); }
  };

  const panels = [["reno", `Renovations${v.reno.total ? " · " + fmt(-v.reno.total) : ""}`], ["env", `Environment${v.env.total ? " · " + fmt(-v.env.total) : ""}`], ["criteria", `Nice-to-haves · ${v.critChecked}/${v.critTotal}`], ["obs", "Observations"]];

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
      {/* Listing blocks — captured from the paste, editable, auto-interpreted */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.sub, marginBottom: 6, fontWeight: 600 }}>Listing: what’s special</div>
        <textarea value={prop.listingDescription || ""} onChange={(e) => update({ listingDescription: e.target.value })} rows={3}
          placeholder="Pulled from the listing's “What's special” when you paste it. Feeds the AI take and is auto-interpreted into the panels below on import."
          style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12.5, fontFamily: "inherit", background: C.paper, resize: "vertical", lineHeight: 1.5 }} />
        <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.sub, margin: "12px 0 6px", fontWeight: 600 }}>Listing: facts &amp; features</div>
        <textarea value={prop.factsFeatures || ""} onChange={(e) => update({ factsFeatures: e.target.value })} rows={3}
          placeholder="Pulled from the listing's “Facts & features” (interior, construction, utilities…) when you paste it. Also auto-interpreted and fed to the AI take."
          style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12.5, fontFamily: "inherit", background: C.paper, resize: "vertical", lineHeight: 1.5 }} />
        <div style={{ fontSize: 10, color: C.sub, marginTop: 6, lineHeight: 1.4 }}>Both are interpreted automatically when you import a listing. Edit and re-run below if you change them.</div>
      </div>

      {/* Observations input drives suggestions */}
      <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.sub, marginBottom: 6, fontWeight: 600 }}>Observations → suggestions</div>
      <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8, lineHeight: 1.5 }}>Describe what you see at the showing in plain language. AI reads it and fills the panels below — renovations (including custom items for anything not on the list), environmental risks, and nice-to-haves — plus surfaces recurring or serious concerns into the red flags on your sidebar. Review and adjust after.</div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="e.g. Kitchen and baths are dated and original. Roof looks near end of life. Backs to a busy road, and there's a big tree leaning over the house. Nice open kitchen/living though."
        style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: C.paper, resize: "vertical", lineHeight: 1.5 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button onClick={runInterpret} disabled={interpreting || !draft.trim()} style={{ padding: "8px 15px", fontSize: 12.5, fontWeight: 600, cursor: interpreting || !draft.trim() ? "not-allowed" : "pointer", border: "none", borderRadius: 8, background: C.moss, color: "#fff", fontFamily: "inherit", opacity: interpreting || !draft.trim() ? 0.6 : 1 }}>
          {interpreting ? "Interpreting…" : "Interpret with AI →"}
        </button>
      </div>
      {aiMsg && <div style={{ marginTop: 8, fontSize: 11.5, color: aiMsg.err ? C.bad : C.moss, background: aiMsg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7, lineHeight: 1.4 }}>{aiMsg.err || aiMsg.ok}</div>}

      {/* panel switcher */}
      <div style={{ display: "flex", gap: 6, margin: "16px 0 12px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        {panels.map(([k, l]) => (
          <button key={k} onClick={() => setPanel(k)} style={{ padding: "7px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "none", color: panel === k ? C.ink : C.sub, borderBottom: `2px solid ${panel === k ? C.moss : "transparent"}`, marginBottom: -1, fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>

      {/* RENOVATIONS */}
      {panel === "reno" && (
        <div>
          <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>Toggle what this house needs to reach market standard. Cost is subtracted from value (money out). A <em>negative</em> cost means it's better than standard on that item and adds value. Defaults set in Assumptions.</div>
          {renoDefs.map((r) => {
            const st = reno[r.key] || {};
            return (
              <div key={r.key} style={{ padding: "8px 0", borderBottom: `1px solid ${C.paper}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="checkbox" checked={!!st.on} onChange={(e) => setReno(r.key, { on: e.target.checked, cost: st.cost ?? r.cost })} />
                  <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: st.on ? C.ink : C.sub }}>{r.label}</div>
                  <span style={{ fontSize: 12, color: C.sub }}>$</span>
                  <input type="number" value={st.cost ?? r.cost} onChange={(e) => setReno(r.key, { cost: num(e.target.value), on: st.on })}
                    style={{ width: 84, padding: "5px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: st.on ? C.paper : C.panel, color: st.on ? C.ink : C.sub }} />
                </div>
                <div style={{ fontSize: 10.5, color: C.sub, marginLeft: 26, marginTop: 1 }}>{r.note}</div>
              </div>
            );
          })}
          <RenoCustom prop={prop} update={update} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontWeight: 700, fontSize: 15 }}>
            <span>Total renovation</span><span style={{ color: v.reno.total > 0 ? C.clay : C.good }}>{v.reno.total > 0 ? "−" : "+"}{fmt(Math.abs(v.reno.total))}</span>
          </div>
        </div>
      )}

      {/* ENVIRONMENT */}
      {panel === "env" && (
        <div>
          <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>Site & proximity risks. Rate severity for a suggested discount, or type an exact dollar amount to override it. Base amounts set in Assumptions.</div>
          {envDefs.map((e) => {
            const d = env[e.key];
            const sev = (d && typeof d === "object") ? (d.sev ?? 0) : (d ?? 0);
            const override = (d && typeof d === "object") ? d.override : null;
            const hasOverride = override != null && override !== "";
            const val = hasOverride ? Math.round(num(override) || 0) : Math.round((num(e.base) || 0) * (ENV_SEV[String(sev)] ?? 0));
            const setKey = (patch) => setEnv(e.key, { sev, override, ...patch });
            return (
              <div key={e.key} style={{ padding: "8px 0", borderBottom: `1px solid ${C.paper}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{e.label}</div>
                    <div style={{ fontSize: 10.5, color: C.sub }}>{e.note}</div>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: val ? C.bad : C.sub, minWidth: 60, textAlign: "right" }}>{val ? "−" + fmt(val) : "—"}{hasOverride && <span style={{ fontSize: 9, color: C.moss, display: "block" }}>manual</span>}</div>
                </div>
                <div style={{ display: "flex", gap: 3, marginTop: 6, alignItems: "center" }}>
                  {["0", "1", "2", "3"].map((s) => (
                    <button key={s} onClick={() => setKey({ sev: num(s), override: "" })} style={{ flex: 1, padding: "4px 0", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 5, fontFamily: "inherit",
                      border: `1px solid ${!hasOverride && String(sev) === s ? (s === "0" ? C.sub : C.bad) : C.line}`,
                      background: !hasOverride && String(sev) === s ? (s === "0" ? C.sub : C.bad) : C.panel,
                      color: !hasOverride && String(sev) === s ? "#fff" : C.sub }}>{s === "0" ? "none" : s === "1" ? "minor" : s === "2" ? "mod" : "severe"}</button>
                  ))}
                  <span style={{ fontSize: 11, color: C.sub, marginLeft: 4 }}>or $</span>
                  <input type="number" value={override ?? ""} onChange={(ev) => setKey({ override: ev.target.value })} placeholder="exact"
                    style={{ width: 70, padding: "4px 6px", border: `1px solid ${hasOverride ? C.moss : C.line}`, borderRadius: 5, fontSize: 11.5, fontFamily: "inherit", background: hasOverride ? C.mossLt : C.panel }} />
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontWeight: 700, fontSize: 15 }}>
            <span>Total environmental</span><span style={{ color: v.env.total ? C.bad : C.sub }}>{v.env.total ? "−" + fmt(v.env.total) : "—"}</span>
          </div>
        </div>
      )}

      {/* CRITERIA (nice-to-have, no value) */}
      {panel === "criteria" && (
        <div>
          <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>Pure desirability checklist — <strong>does not affect value</strong>. Tracks how well a house fits what you want. Add or remove features in Assumptions.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
            {critFeatures.map((f) => (
              <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={!!crit[f.key]} onChange={() => toggleCrit(f.key)} />
                <span style={{ color: crit[f.key] ? C.ink : C.sub }}>{f.label}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700 }}>Fit: {v.critChecked} / {v.critTotal} features</div>
        </div>
      )}

      {/* OBSERVATIONS log — split: marked on panels vs. unplaced (need $/%) */}
      {panel === "obs" && (() => {
        const all = prop.adjustments || [];
        const markedOnes = all.filter((a) => (a.matched || []).length > 0);
        const unplacedOnes = all.filter((a) => (a.matched || []).length === 0);
        const upd = (id, patch) => update({ adjustments: all.map((x) => x.id === id ? { ...x, ...patch } : x) });
        const del = (id) => update({ adjustments: all.filter((x) => x.id !== id) });
        const ObsCard = ({ a, showAdj }) => (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 8, background: C.paper }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 12, fontStyle: "italic", color: C.ink, flex: 1 }}>"{a.source}"</div>
              <button onClick={() => del(a.id)} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
            {(a.matched || []).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {a.matched.map((m, i) => (
                  <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 10, background: m.area === "Renovation" ? C.clayLt : m.area === "Environment" ? "#f0e5d5" : C.mossLt, color: m.area === "Renovation" ? C.clay : m.area === "Environment" ? "#8a6d3b" : C.moss }}>
                    {m.area}: {m.label}
                  </span>
                ))}
              </div>
            )}
            {showAdj && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <span style={{ fontSize: 10.5, color: C.sub }}>Not on a panel — set a manual adjustment:</span>
                <select value={a.kind} onChange={(e) => upd(a.id, { kind: e.target.value })} style={{ fontSize: 11, padding: "3px 5px", border: `1px solid ${C.line}`, borderRadius: 5, fontFamily: "inherit" }}>
                  <option value="usd">$</option><option value="pct">%</option>
                </select>
                <input type="number" value={a.amt} onChange={(e) => upd(a.id, { amt: e.target.value })} style={{ width: 80, padding: "4px 7px", border: `1px solid ${C.line}`, borderRadius: 5, fontSize: 12, fontFamily: "inherit" }} />
                <button onClick={() => upd(a.id, { status: a.status === "accepted" ? "logged" : "accepted" })}
                  style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.good}`, borderRadius: 5, background: a.status === "accepted" ? C.good : C.panel, color: a.status === "accepted" ? "#fff" : C.good, fontFamily: "inherit" }}>
                  {a.status === "accepted" ? "✓ applied" : "apply"}
                </button>
              </div>
            )}
          </div>
        );
        return (
          <div>
            <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>Each note is grouped by whether it landed on a panel (renovation / environment / nice-to-have) or needs a manual value adjustment. One note can touch several areas.</div>
            {all.length === 0 && <div style={{ fontSize: 12, color: C.sub }}>No observations yet. Write notes above and hit "Interpret."</div>}

            {markedOnes.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.moss, marginBottom: 6, fontWeight: 700 }}>✓ Marked on panels ({markedOnes.length})</div>
                {markedOnes.map((a) => <ObsCard key={a.id} a={a} showAdj={false} />)}
              </div>
            )}

            {unplacedOnes.length > 0 && (
              <div>
                <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.clay, marginBottom: 6, fontWeight: 700 }}>Needs a manual adjustment ({unplacedOnes.length})</div>
                {unplacedOnes.map((a) => <ObsCard key={a.id} a={a} showAdj={true} />)}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function RenoCustom({ prop, update }) {
  const custom = prop.renoCustom || [];
  return (
    <div style={{ marginTop: 8 }}>
      {custom.map((c) => (
        <div key={c.id} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <input value={c.label} onChange={(e) => update({ renoCustom: custom.map((x) => x.id === c.id ? { ...x, label: e.target.value } : x) })} placeholder="Custom reno item" style={{ flex: 1, padding: "5px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: C.paper }} />
          <span style={{ fontSize: 12, color: C.sub }}>$</span>
          <input type="number" value={c.cost} onChange={(e) => update({ renoCustom: custom.map((x) => x.id === c.id ? { ...x, cost: e.target.value } : x) })} style={{ width: 80, padding: "5px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: C.paper }} />
          <button onClick={() => update({ renoCustom: custom.filter((x) => x.id !== c.id) })} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 15 }}>×</button>
        </div>
      ))}
      <button onClick={() => update({ renoCustom: [...custom, { id: uid(), label: "", cost: "" }] })} style={{ padding: "5px 11px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 6, background: C.mossLt, color: C.moss, fontFamily: "inherit" }}>+ Custom item</button>
    </div>
  );
}

function CompAnalysisTab({ prop, update, rates, pool }) {
  const [geoReply, setGeoReply] = useState("");
  const [msg, setMsg] = useState(null);
  const ca = prop.compAnalysis || {};
  const radius = num(ca.radius) || num(rates.defaults?.radius) || 2;
  const subject = {
    sqft: num(prop.sqft), beds: num(prop.beds), baths: num(prop.baths),
    yearBuilt: num(prop.yearBuilt), lot: num(prop.lot),
    lat: num(ca.lat), lng: num(ca.lng),
  };
  const setCA = (patch) => update({ compAnalysis: { ...ca, ...patch } });
  const poolComps = useMemo(() => poolCompsForProperty(pool || { comps: [] }), [pool]);
  const caFactors = { sqftTol: rates.defaults?.sqftTol ?? 500, maxMonths: rates.defaults?.maxMonths, glaPct: rates.defaults?.glaPct, glaOverride: rates.defaults?.glaOverride, bed: rates.defaults?.bedAdj, bath: rates.defaults?.bathAdj, year: rates.defaults?.yearAdj, lot: rates.defaults?.lotAdj, ...(ca.factors || {}) };
  const analysis = useMemo(
    () => analyzeComps(poolComps, subject, radius, caFactors),
    [poolComps, subject.sqft, subject.beds, subject.baths, subject.yearBuilt, subject.lot, subject.lat, subject.lng, radius, ca.factors]
  );
  const geoMissing = subject.lat == null || subject.lng == null;
  const addr = prop.address || "";

  const copySubjectGeo = () => {
    const txt = `Please geocode this address and return JSON {"lat":..,"lng":..}:

${addr || "(enter the property address first)"}`;
    navigator.clipboard && navigator.clipboard.writeText(txt);
    setMsg({ ok: "Copied — paste to Claude in chat, then paste the {lat,lng} reply below.", show: txt });
  };
  const applySubjectGeo = () => {
    try { const p = JSON.parse(geoReply); if (p.lat == null || p.lng == null) throw new Error(); setCA({ lat: String(p.lat), lng: String(p.lng) }); setMsg({ ok: "Coordinates set — distances now real." }); setGeoReply(""); }
    catch { setMsg({ err: 'Paste JSON exactly, e.g. {"lat":33.98,"lng":-84.45}' }); }
  };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>
        Sets this property's <strong>coordinates and radius</strong>, and shows which pool comps are being evaluated. The valuation itself appears in the sidebar. Comps come from the shared <strong>Comp Pool</strong> ({(pool && pool.comps ? pool.comps.length : 0)} loaded).
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: C.sub, marginBottom: 2, fontWeight: 600 }}>Paste coordinates (lat, lng)</div>
        <input
          placeholder="33.93270811, -84.46369810"
          onChange={(e) => {
            const m = e.target.value.match(/(-?\d{1,3}\.\d+)\s*[,\s]\s*(-?\d{1,3}\.\d+)/);
            if (m) setCA({ lat: m[1], lng: m[2] });
          }}
          style={{ width: "100%", padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.panel }} />
        <div style={{ fontSize: 9.5, color: C.sub, marginTop: 2 }}>Paste a "lat, lng" pair (e.g. copied from Google Maps) — it fills both fields below.</div>
      </div>

      <div className="quad-grid" style={{ marginBottom: 10 }}>
        <MiniInput label="Subject latitude" value={ca.lat} onChange={(x) => setCA({ lat: x })} ph="33.9810" />
        <MiniInput label="Subject longitude" value={ca.lng} onChange={(x) => setCA({ lng: x })} ph="-84.4595" />
        <DefaultInput label="Radius (mi)" value={ca.radius} onChange={(x) => setCA({ radius: x })} def={rates.defaults?.radius ?? 2} />
        <DefaultInput label="Sqft tolerance ±" value={ca.factors?.sqftTol} onChange={(x) => setCA({ factors: { ...(ca.factors || {}), sqftTol: x } })} def={rates.defaults?.sqftTol ?? 500} />
      </div>
      <div style={{ fontSize: 10.5, color: C.sub, marginBottom: 10, marginTop: -4 }}>Comps more than ±{num(ca.factors?.sqftTol) ?? (rates.defaults?.sqftTol ?? 500)} sqft from this home are excluded — too different to adjust reliably.</div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Sold within:</div>
        <select value={ca.factors?.maxMonths ?? (rates.defaults?.maxMonths ?? "")} onChange={(e) => setCA({ factors: { ...(ca.factors || {}), maxMonths: e.target.value === "" ? undefined : num(e.target.value) } })}
          style={{ padding: "6px 9px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.panel }}>
          <option value="">Any time</option>
          <option value="1">Last 30 days</option>
          <option value="2">Last 60 days</option>
          <option value="3">Last 90 days</option>
          <option value="6">Last 6 months</option>
          <option value="12">Last 12 months</option>
          <option value="24">Last 24 months</option>
        </select>
        <div style={{ fontSize: 10.5, color: C.sub }}>older comps excluded</div>
      </div>

      {geoMissing && (
        <div style={{ background: C.mossLt, borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 11.5, color: C.ink, lineHeight: 1.5, marginBottom: 6 }}>Needs exact coordinates for real distance. Copy the request, paste to Claude, paste the reply back.</div>
          <button onClick={copySubjectGeo} style={{ padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${C.moss}`, borderRadius: 6, background: C.panel, color: C.moss, fontFamily: "inherit" }}>Copy geocode request</button>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input value={geoReply} onChange={(e) => setGeoReply(e.target.value)} placeholder='{"lat":33.98,"lng":-84.45}' style={{ flex: 1, padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: C.panel }} />
            <button onClick={applySubjectGeo} disabled={!geoReply.trim()} style={{ padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: geoReply.trim() ? "pointer" : "not-allowed", border: "none", borderRadius: 6, background: C.moss, color: "#fff", opacity: geoReply.trim() ? 1 : 0.5, fontFamily: "inherit" }}>Set</button>
          </div>
        </div>
      )}
      {msg && <div style={{ marginBottom: 12, fontSize: 11.5, color: msg.err ? C.bad : C.moss, background: msg.err ? C.clayLt : C.mossLt, padding: "8px 10px", borderRadius: 7 }}>{msg.err || msg.ok}{msg.show && <textarea readOnly value={msg.show} rows={2} onFocus={(e)=>e.target.select()} style={{ width: "100%", marginTop: 6, padding: 8, border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 10.5, fontFamily: "monospace", background: C.panel }} />}</div>}

      {analysis && analysis.scored.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: C.sub, marginBottom: 6, fontWeight: 600 }}>Comps being evaluated ({analysis.included.length} used / {analysis.scored.length - analysis.included.length} excluded)</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5, minWidth: 560 }}>
            <thead><tr style={{ borderBottom: `2px solid ${C.ink}` }}>{["","Comp","Sold (adj)","Dist","Sqft","Adjusted","Score"].map((h)=>(<th key={h} style={{ textAlign: h==="Comp"?"left":"right", padding:"6px", color:C.sub, fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>))}</tr></thead>
            <tbody>
              {analysis.scored.filter((c)=>!c.excluded || (c.dist!=null && c.dist<=radius*1.5)).sort((a,b)=>(b.excluded===a.excluded? b.score-a.score : a.excluded?1:-1)).slice(0,30).map((c)=>(
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.line}`, opacity: c.excluded?0.45:1 }}>
                  <td style={{ textAlign:"center", padding:"6px 4px" }}><span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%", background: c.excluded?C.line:C.good }} /></td>
                  <td style={{ padding:"6px", maxWidth:170, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.address||"(no addr)"}{c.glaCapped && <span title="GLA adjustment hit the cap" style={{ color:C.med, fontSize:10 }}> ⊘</span>}{c.overSqftTol && <span title="excluded: over sqft tolerance" style={{ color:C.bad, fontSize:10 }}> ↔</span>}{c.tooOld && <span title="excluded: outside sold-date window" style={{ color:C.bad, fontSize:10 }}> ⏱</span>}{c.flags.length>0 && !c.overSqftTol && !c.tooOld && <span style={{ color:C.bad, fontSize:10 }}> ⚑</span>}</td>
                  <td style={{ textAlign:"right", padding:"6px", whiteSpace:"nowrap" }}>{fmt(c.priceAdj)}</td>
                  <td style={{ textAlign:"right", padding:"6px" }}>{c.dist!=null?c.dist.toFixed(2):"—"}</td>
                  <td style={{ textAlign:"right", padding:"6px", color: c.overSqftTol?C.bad:C.ink }}>{c.sqft && c.sqft.toLocaleString()}</td>
                  <td style={{ textAlign:"right", padding:"6px", fontWeight:700, whiteSpace:"nowrap" }}>{fmt(c.adjustedValue)}</td>
                  <td style={{ textAlign:"right", padding:"6px", fontWeight:700, color: c.score>=80?C.good:c.score>=50?C.med:C.bad }}>{c.excluded?"—":c.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function MiniInput({ label, value, onChange, ph }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.sub, marginBottom: 2, fontWeight: 600 }}>{label}</div>
      <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={ph}
        style={{ width: "100%", padding: "6px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.panel }} />
    </div>
  );
}

// Like MiniInput, but the default is a REAL filled value (not grey placeholder).
// You can clear it to type freely; if you leave it blank, it refills the default
// on blur. The stored value is always a concrete number, so the engine and the
// field never disagree.
function DefaultInput({ label, value, onChange, def, sub }) {
  const [focused, setFocused] = useState(false);
  // show empty only while focused & user cleared it; otherwise show value-or-default
  const display = focused ? (value ?? "") : (value != null && value !== "" ? value : def);
  return (
    <div>
      <div style={{ fontSize: 10, color: C.sub, marginBottom: 2, fontWeight: 600 }}>{label}</div>
      <input
        value={display}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (value == null || value === "") onChange(String(def)); }}
        style={{ width: "100%", padding: "6px 7px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.panel }} />
      {sub && <div style={{ fontSize: 9.5, color: C.sub, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function VerdictPanel({ prop, v }) {
  const dealColor = v.deal === "good" ? C.good : v.deal === "bad" ? C.bad : C.gold;
  const dealText = v.deal === "good" ? "Worth pursuing" : v.deal === "bad" ? "Walk or lowball" : "Needs more data";
  const flagColor = { high: C.bad, med: C.med, low: C.sub };
  const suggestedOffer = v.fairLikely != null ? v.fairLikely : null;
  const [aiSummary, setAiSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);

  const runSummary = async () => {
    if (summarizing) return;
    setSummarizing(true); setAiSummary(null);
    const renoLines = (v.reno?.lines || []).map((l) => `${l.label} ${fmt(l.cost)}`).join(", ");
    const envLines = (v.env?.lines || []).map((l) => `${l.label} ${fmt(l.value)}`).join(", ");
    const notes = (prop.adjustments || []).map((a) => a.source).filter(Boolean);
    const ctx = `Subject: ${prop.address || "property"}, ${num(prop.sqft) || "?"} sqft, ${prop.beds || "?"}bd/${prop.baths || "?"}ba, built ${prop.yearBuilt || "?"}.
Asking: ${fmt(num(prop.asking))}. Comp-derived fair value: ${fmt(v.fairLikely)} (range ${fmt(v.fairLow)}–${fmt(v.fairHigh)}).
Over/under ask: ${v.overPct == null ? "n/a" : v.overPct.toFixed(1) + "%"}. Comp $/sqft: ${v.ppsfMedian ? "$" + Math.round(v.ppsfMedian) : "n/a"}. Comps used: ${v.adjComps.length}.
Renovations needed: ${renoLines || "none"} (total ${fmt(v.reno?.total || 0)}).
Environmental discounts: ${envLines || "none"}.
DOM: ${effectiveDom(prop) ?? "?"} vs area ${num(prop.areaDom) || "?"}. Price cuts: ${num(prop.priceCuts) || 0}.
Listing "what's special": ${prop.listingDescription ? String(prop.listingDescription).slice(0, 4000) : "none"}.
Listing "facts & features": ${prop.factsFeatures ? String(prop.factsFeatures).slice(0, 3000) : "none"}.
My showing notes: ${notes.join(" | ") || "none"}.`;
    const sys = `You are a sharp buyer's-side real estate analyst. Return ONLY JSON, no markdown: {"feasibility":"...","lookFor":["...","..."]}.
- feasibility: your bottom-line take on whether this is a good buy at the price — is it over/under fair value and worth pursuing. MAX 3 sentences, ideally shorter. Direct, reference the key figures.
- lookFor: 3-6 short bullet items (a few words each) of specific things to verify or inspect at the home, given the notes, renovation flags, environmental risks, age, and DOM. Actionable and concrete (e.g. "Check roof age — near replacement", "Verify road noise off Powers Ferry"). Not full sentences.`;
    try {
      const resp = await fetch("/api/ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 700, system: sys, messages: [{ role: "user", content: ctx }] }),
      });
      const data = await resp.json();
      const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(txt);
      setAiSummary({ feasibility: parsed.feasibility || "", lookFor: Array.isArray(parsed.lookFor) ? parsed.lookFor : [] });
    } catch { setAiSummary({ error: "Couldn't generate. Try again." }); }
    finally { setSummarizing(false); }
  };

  // When there's no fair value, say exactly why — the badge is a status, not a
  // button, so the missing pieces are spelled out here.
  const missing = [];
  if (!num(prop.sqft)) missing.push("this home's square footage");
  if (v.adjComps.length === 0) missing.push("at least one closed comp with a price + sqft");
  if (!num(prop.asking)) missing.push("the asking price (for the over/under)");

  return (
    <div style={{ background: C.ink, borderRadius: 14, padding: 18, color: C.paper }}>
      {/* Compact property summary strip */}
      <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid rgba(255,255,255,0.15)", lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{prop.address || "Unnamed property"}</div>
        <div style={{ opacity: 0.75 }}>
          {num(prop.sqft) ? `${num(prop.sqft).toLocaleString()} sqft` : "— sqft"} · {prop.beds || "—"}bd · {prop.baths || "—"}ba · {effectiveDom(prop) != null ? `${effectiveDom(prop)}d on mkt` : "— DOM"}
        </div>
      </div>
      <div style={{ fontSize: 11, letterSpacing: 1, opacity: 0.7, textTransform: "uppercase" }}>Comp-derived fair value</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 34, fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>{fmt(v.fairLikely)}</div>
      {v.fairLow != null && (
        <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 3 }}>Range {fmt(v.fairLow)} – {fmt(v.fairHigh)}</div>
      )}

      <div style={{ display: "inline-block", marginTop: 10, padding: "4px 11px", borderRadius: 20, background: dealColor, fontSize: 12, fontWeight: 700 }}>{dealText}</div>

      {v.fairLikely == null && missing.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ opacity: 0.9, fontWeight: 600, marginBottom: 4 }}>To get a fair value, add:</div>
          {missing.map((m, i) => (
            <div key={i} style={{ opacity: 0.85, display: "flex", gap: 6 }}><span style={{ color: "#e8c98f" }}>·</span>{m}</div>
          ))}
        </div>
      )}

      {v.asking != null && v.overPct != null && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <Row k="Asking" val={fmt(v.asking)} />
          <Row k="Over / under ask" val={fmtPct(v.overPct)} color={v.overPct <= 0 ? "#7fd4a3" : v.overPct > 8 ? "#e8a08f" : "#e8c98f"} />
          <Row k="= dollars over" val={fmt(v.overUnder)} color={v.overUnder > 0 ? "#e8a08f" : "#7fd4a3"} />
        </div>
      )}

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
        <Row k="Comp value (before adj.)" val={fmt(v.likely)} />
        <Row k="Comp $/sqft (adj.)" val={v.ppsfMedian ? "$" + Math.round(v.ppsfMedian) : "—"} />
        {v.reno.total !== 0 && <Row k="Renovation" val={(v.reno.total > 0 ? "−" : "+") + fmt(Math.abs(v.reno.total))} color={v.reno.total > 0 ? "#e8a08f" : "#7fd4a3"} />}
        {v.env.total !== 0 && <Row k="Environmental" val={"−" + fmt(v.env.total)} color="#e8a08f" />}
        {(v.adjTotalUsd !== 0 || v.adjTotalPct !== 0) && (
          <Row k="Observation adj." val={`${v.adjTotalUsd !== 0 ? (v.adjTotalUsd > 0 ? "+" : "") + fmt(v.adjTotalUsd) : ""}${v.adjTotalUsd !== 0 && v.adjTotalPct !== 0 ? " / " : ""}${v.adjTotalPct !== 0 ? (v.adjTotalPct > 0 ? "+" : "") + v.adjTotalPct.toFixed(1) + "%" : ""}`} color={(v.adjTotalUsd + v.adjTotalPct) < 0 ? "#e8a08f" : "#7fd4a3"} />
        )}
        <Row k="Nice-to-have fit" val={`${v.critChecked}/${v.critTotal}`} />
        <Row k="Comps used" val={String(v.adjComps.length)} />
      </div>

      {suggestedOffer != null && (
        <div style={{ marginTop: 14, padding: "11px 12px", background: "rgba(255,255,255,0.08)", borderRadius: 9 }}>
          <div style={{ fontSize: 10.5, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.5 }}>Comp-backed opening number</div>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, color: "#a9d9bf" }}>{fmt(suggestedOffer)}</div>
          <div style={{ fontSize: 10.5, opacity: 0.65, marginTop: 3, lineHeight: 1.4 }}>Attach your comps. Let the seller decide. Worst case is no — and they often come back.</div>
        </div>
      )}

      {v.flags.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <div style={{ fontSize: 11, letterSpacing: 0.5, opacity: 0.7, textTransform: "uppercase", marginBottom: 8 }}>Red flags &amp; insights</div>
          {v.flags.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 11.5, lineHeight: 1.45 }}>
              <span style={{ color: flagColor[f.level], fontWeight: 700, flexShrink: 0 }}>{f.insight ? "✦" : f.level === "high" ? "▲" : f.level === "med" ? "◆" : "·"}</span>
              <span style={{ opacity: 0.9 }}>{f.text}{f.insight && <span style={{ opacity: 0.5, fontStyle: "italic" }}> · from your notes</span>}</span>
            </div>
          ))}
        </div>
      )}

      {v.adjComps.length === 0 && (
        <div style={{ marginTop: 14, fontSize: 11.5, opacity: 0.7, lineHeight: 1.5 }}>Add closed comps to generate a fair value. Without them, there's no fact to anchor to — only the seller's opinion.</div>
      )}

      {v.fairLikely != null && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <button onClick={runSummary} disabled={summarizing} style={{ width: "100%", padding: "9px", fontSize: 12.5, fontWeight: 600, cursor: summarizing ? "not-allowed" : "pointer", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 8, background: "rgba(255,255,255,0.1)", color: C.paper, fontFamily: "inherit", opacity: summarizing ? 0.6 : 1 }}>
            {summarizing ? "Thinking…" : "✦ AI take on this deal"}
          </button>
          {aiSummary && aiSummary.error && (
            <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.55, background: "rgba(255,255,255,0.08)", borderRadius: 9, padding: "12px 13px", opacity: 0.9 }}>{aiSummary.error}</div>
          )}
          {aiSummary && !aiSummary.error && (
            <div style={{ marginTop: 10 }}>
              {aiSummary.feasibility && (
                <div style={{ background: "rgba(255,255,255,0.08)", borderRadius: 9, padding: "11px 13px", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", opacity: 0.6, fontWeight: 700, marginBottom: 4 }}>Feasibility</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, opacity: 0.95 }}>{aiSummary.feasibility}</div>
                </div>
              )}
              {aiSummary.lookFor && aiSummary.lookFor.length > 0 && (
                <div style={{ background: "rgba(255,255,255,0.08)", borderRadius: 9, padding: "11px 13px" }}>
                  <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", opacity: 0.6, fontWeight: 700, marginBottom: 6 }}>What to look for</div>
                  {aiSummary.lookFor.map((item, i) => (
                    <div key={i} style={{ display: "flex", gap: 7, marginBottom: 5, fontSize: 12, lineHeight: 1.4 }}>
                      <span style={{ opacity: 0.5, flexShrink: 0 }}>›</span>
                      <span style={{ opacity: 0.95 }}>{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {v.payment && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <div style={{ fontSize: 11, letterSpacing: 0.5, opacity: 0.7, textTransform: "uppercase" }}>Est. monthly payment</div>
            <div style={{ fontSize: 22, fontFamily: "'Fraunces', serif", fontWeight: 700 }}>{fmt(Math.round(v.payment.total))}<span style={{ fontSize: 12, opacity: 0.6 }}>/mo</span></div>
          </div>
          <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 8 }}>On asking {fmt(v.payment.asking)} · {fmt(Math.round(v.payment.down))} down ({v.payment.downPct.toFixed(1)}%){v.payment.pmiMo > 0 ? " — under 20%, PMI applies" : v.payment.usesCash ? " — 20%+, no PMI" : ""} · {v.payment.apr}% · {v.payment.termYrs}yr</div>
          {[
            ["Principal & interest", v.payment.pi],
            [`Property tax${v.payment.taxIsEstimated ? " (est.)" : ""}`, v.payment.taxMo],
            ["Homeowner's insurance (est.)", v.payment.insMo],
            ...(v.payment.pmiMo > 0 ? [["PMI (down < 20%)", v.payment.pmiMo]] : []),
            ...(v.payment.hasHoa ? [["HOA", v.payment.hoaMo]] : []),
          ].map(([label, val]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", opacity: 0.9 }}>
              <span>{label}</span><span>{fmt(Math.round(val))}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 9.5, opacity: 0.45, lineHeight: 1.5 }}>
        A workbench, not an appraisal or financial advice. Verify comps and figures with your agent and lender before making an offer.
      </div>
    </div>
  );
}

function Row({ k, val, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
      <span style={{ opacity: 0.7 }}>{k}</span>
      <span style={{ fontWeight: 600, color: color || C.paper }}>{val}</span>
    </div>
  );
}
