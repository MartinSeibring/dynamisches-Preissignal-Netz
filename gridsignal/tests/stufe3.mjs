/**
 * Stufe-3-Verifikation: signiertes P als Regressionsziel der Wetterkalibrierung.
 * Ausführen:  node tests/stufe3.mjs   (aus dem gridsignal/-Verzeichnis)
 *
 * Prüft:
 *  1) aPv-Rückgewinnung bei Rückspeisung (Nulldurchgang) — signiertes Ziel.
 *  2) Bias-Nachweis: altes |S|-Ziel unterschätzt aPv deutlich.
 *  3) Magnitude-Invarianz: Demo-PV-Daten → |pSigned| ≈ s; Preissignal ≥ 0.
 *  4) Rückwärtskompatibilität: Entries ohne pSigned → Fallback = |S|.
 */

// Minimaler localStorage-Shim (store.js instanziiert beim Import einen Store).
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const { calibrateStation } = await import("../js/calibration.js");
const { generateDemoData }  = await import("../js/store.js");
const { priceEngine }       = await import("../js/priceSignal.js");

let failures = 0;
function assert(cond, msg) {
  const ok = !!cond;
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!ok) failures++;
}

// Seeded PRNG (deterministisch, da Math.random hier erlaubt, aber reproduzierbar gewünscht)
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const T_HEIZ = 15, T_KUEHL = 21;
const A_HEAT_TRUE = 6.0, A_PV_TRUE = -0.45;

// ── Synthetische Reihe mit bekannter Wahrheit + Rückspeisung (Nulldurchgang) ──
function buildScenario() {
  const start = Date.UTC(2026, 2, 1, 0, 0, 0); // 1. März 2026 UTC
  const days = 70;
  const synoptic = []; let sv = 8;
  for (let d = 0; d < days; d++) { sv += (rnd() - 0.5) * 4; sv = Math.max(-5, Math.min(22, sv)); synoptic.push(sv); }

  const wtime = [], wtemp = [], wghi = [];
  for (let h = 0; h < days * 24; h++) {
    const dd = new Date(start + h * 3600000);
    const hod = dd.getUTCHours(), day = Math.floor(h / 24), cloud = rnd();
    wtime.push(dd.toISOString().slice(0, 16)); // wie Open-Meteo (UTC, ohne Z)
    wtemp.push(synoptic[day] + 6 * Math.sin((hod - 9) / 24 * 2 * Math.PI) + (1 - cloud) * 2);
    wghi.push(Math.max(0, 800 * Math.sin(Math.max(0, (hod - 6) / 12) * Math.PI)) * (0.35 + 0.65 * (1 - cloud)));
  }
  const lerp = (a, i, f) => a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * f;

  const entries = [];
  for (let i = 0; i < days * 96; i++) {
    const dd = new Date(start + i * 15 * 60000);
    const hod = dd.getUTCHours() + dd.getUTCMinutes() / 60;
    const base = 230 + 70 * Math.sin((hod - 18) / 24 * 2 * Math.PI); // moderat → Nulldurchgang mittags
    const hi = Math.floor(i / 4), fr = (i % 4) / 4;
    const T = lerp(wtemp, hi, fr), G = lerp(wghi, hi, fr);
    const netP = base + A_HEAT_TRUE * Math.max(0, T_HEIZ - T) + A_PV_TRUE * G + (rnd() - 0.5) * 12;
    entries.push({ ts: dd.toISOString(), s: Math.max(1, Math.abs(netP)), pSigned: netP });
  }
  return { entries, weather: { time: wtime, temp: wtemp, ghi: wghi } };
}

// ── Test 1: aPv-Rückgewinnung (signiertes Ziel) ──────────────────────────────
console.log("Test 1 — aPv-Rückgewinnung bei Rückspeisung (signiert):");
const { entries, weather } = buildScenario();
const nCross = entries.filter(e => e.pSigned < 0).length;
assert(nCross > 200, `Szenario enthält Rückspeisung (${nCross} Slots pSigned<0)`);
const c1 = calibrateStation(entries, weather, { tHeiz: T_HEIZ, fitHeat: true, fitCool: false, fitPv: true });
assert(c1 !== null, "Kalibrierung liefert Ergebnis");
console.log(`     aHeat=${c1.aHeat} (Wahrheit ${A_HEAT_TRUE})  aPv=${c1.aPv} (Wahrheit ${A_PV_TRUE})  R²=${c1.r2}`);
assert(Math.abs(c1.aPv - A_PV_TRUE) / Math.abs(A_PV_TRUE) < 0.12, "aPv innerhalb 12 % der Wahrheit");
assert(c1.r2 > 0.9, "R² > 0.9");

// ── Test 2: Bias-Nachweis (altes |S|-Ziel) ───────────────────────────────────
console.log("Test 2 — altes |S|-Ziel unterschätzt aPv (Bias-Nachweis):");
const entriesMag = entries.map(e => ({ ts: e.ts, s: e.s, pSigned: Math.abs(e.pSigned) })); // Vorzeichen entfernt = |S|-Ziel
const c2 = calibrateStation(entriesMag, weather, { tHeiz: T_HEIZ, fitHeat: true, fitCool: false, fitPv: true });
console.log(`     |S|-Ziel aPv=${c2.aPv}  vs  signiert aPv=${c1.aPv}`);
assert(Math.abs(c2.aPv) < Math.abs(c1.aPv) * 0.7, "|S|-Ziel liefert deutlich kleineres |aPv| (Bias vorhanden)");
assert(Math.abs(c1.aPv - A_PV_TRUE) < Math.abs(c2.aPv - A_PV_TRUE), "signiertes Ziel ist näher an der Wahrheit");

// ── Test 3: Magnitude-Invarianz (Demo-PV-Daten + Preissignal) ────────────────
console.log("Test 3 — Magnitude-Invarianz Demo-PV-Daten:");
const demo = generateDemoData("trafo-pv", 630, 30, { pvLeistung: 500, netzgebiet: "pv" });
const demoCross = demo.filter(e => e.pSigned < 0).length;
assert(demoCross > 50, `Demo-PV-Station erzeugt Rückspeisung (${demoCross} Slots pSigned<0)`);
const magOk = demo.every(e => Math.abs(Math.abs(e.pSigned) - e.s) <= 1.01); // s = max(1,|netP|)
assert(magOk, "|pSigned| ≈ s (bis auf Floor 1) für alle Demo-Slots");
const signals = priceEngine.generate(demo, 630, {});
assert(signals.every(s => s.util >= 0), "Preissignal-util ≥ 0 trotz Rückspeisung (|S|-basiert)");
assert(signals.every(s => isFinite(s.price) && s.price > 0), "Preise endlich und positiv");

// Vergleich: Nicht-PV-Demo (fernwaerme) erzeugt keine Rückspeisung
const demoFW = generateDemoData("trafo-fw", 630, 30, { pvLeistung: 0, netzgebiet: "fernwaerme" });
assert(demoFW.every(e => e.pSigned >= 0), "Fernwärme-Demo (keine PV) ohne Rückspeisung");

// ── Test 4: Rückwärtskompatibilität (kein pSigned) ───────────────────────────
console.log("Test 4 — Rückwärtskompatibilität ohne pSigned-Feld:");
const legacy = entries.map(e => ({ ts: e.ts, s: e.s })); // altes Format, kein pSigned
const cLegacy = calibrateStation(legacy, weather, { tHeiz: T_HEIZ, fitHeat: true, fitCool: false, fitPv: true });
assert(cLegacy !== null, "Legacy-Daten kalibrierbar (Fallback pSigned=s)");
// Fallback pSigned=s muss exakt dem explizit auf s gesetzten Ziel entsprechen.
const refSTarget = entries.map(e => ({ ts: e.ts, s: e.s, pSigned: e.s }));
const cRef = calibrateStation(refSTarget, weather, { tHeiz: T_HEIZ, fitHeat: true, fitCool: false, fitPv: true });
assert(Math.abs(cLegacy.aPv - cRef.aPv) < 1e-9, "Legacy-Fallback identisch zu explizitem pSigned=s");

console.log(`\n${failures === 0 ? "✓ ALLE TESTS BESTANDEN" : "✗ " + failures + " TEST(S) FEHLGESCHLAGEN"}`);
process.exit(failures === 0 ? 0 : 1);
