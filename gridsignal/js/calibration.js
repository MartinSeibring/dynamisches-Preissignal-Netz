/**
 * Wettermodell-Kalibrierung (Stufe 2)
 * ===================================
 *
 * Lernt die wetterabhängigen Lastsensitivitäten einer Trafostation datenbasiert
 * aus ihrem eigenen historischen Lastgang – statt fester Literaturwerte (Stufe 1).
 *
 * Methode: Wetter-Normalisierung + multiple lineare Regression (OLS).
 *
 *   1) Baseline-Profil: Für jeden Zeitslot (Werktag/Wochenende × Viertelstunde
 *      des Tages) wird die mittlere Last gebildet – der wetterneutrale Grundgang.
 *
 *   2) Anomalien: Pro Messpunkt werden Last UND Wettergrößen als Abweichung von
 *      ihrem jeweiligen Slot-Mittel ausgedrückt. Damit wird der Tages-/Wochengang
 *      herausgerechnet und nur der wetterbedingte Anteil isoliert.
 *
 *   3) OLS-Regression der Last-Anomalie auf drei physikalische Prädiktoren:
 *        ΔLast = a_heat·ΔHDD + a_cool·ΔCDD + a_pv·ΔGHI + ε
 *      - HDD (heating degrees)  = max(0, T_heiz − T)   → Wärmepumpen/Heizlast
 *      - CDD (cooling degrees)  = max(0, T − T_kühl)   → Klimatisierung (Metropol)
 *      - GHI (Globalstrahlung)  W/m²                    → PV-Einspeisung (negativ)
 *
 * Die geschätzten Koeffizienten sind die tatsächlichen, stationsindividuellen
 * Sensitivitäten (kVA/°C bzw. kVA je W/m²). Sie ersetzen in der Prognose die
 * heuristischen Stufe-1-Faktoren und werden in den Stammdaten persistiert.
 *
 * Datenquelle Historie: Open-Meteo Archive API (ERA5-Reanalyse), CORS-fähig.
 *
 * STUFE 3 (umgesetzt): Das Regressionsziel ist die vorzeichenbehaftete Netto-
 * Wirkleistung `pSigned` (negativ = Rückspeisung), nicht mehr die Scheinleistung
 * |S|. Damit bleibt das Ziel bei PV-Einspeisung monoton in der Strahlung und die
 * PV-Sensitivität aPv wird nicht mehr durch den |S|-Nulldurchgang (V-Form) zu
 * Null verzerrt. Fallback für Bestandsdaten ohne Vorzeichen: pSigned = |S|.
 *
 * Restnäherung: aPv schätzt die Sensitivität der WIRKleistung P; die Korrektur
 * (weather.js) wird additiv auf |S| angewandt. Bei nennenswertem Q gilt
 * d|S|/dP = cosφ ≠ 1, die angewandte PV-Entlastung ist also eine First-Order-
 * Näherung (leicht überzeichnet nahe der Rückspeisung). Das R² zeigt die Güte.
 */

import { parseUtcMs } from "./weather.js?v=20260712";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

// Standard-Schwellen (überschreibbar). Heizgrenze aus Stationskonfiguration,
// Kühlgrenze klimatologisch für Innenraum-Klimatisierung.
const DEFAULT_T_HEIZ = 15;
const DEFAULT_T_KUEHL = 21;

// Archive-API hat eine Verzögerung von ~5 Tagen (ERA5). Jüngere Tage ausschließen.
const ARCHIVE_LAG_DAYS = 5;

// ── Open-Meteo Archive Abruf ─────────────────────────────────────────────────

/**
 * Ruft stündliche Reanalyse-Wetterdaten für einen historischen Zeitraum ab.
 * @param {string} startDate  ISO-Datum "YYYY-MM-DD"
 * @param {string} endDate    ISO-Datum "YYYY-MM-DD"
 * @returns {Promise<{time:string[], temp:number[], ghi:number[]}>}
 */
export async function fetchWeatherArchive(lat, lon, startDate, endDate) {
  const params = new URLSearchParams({
    latitude:  lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: startDate,
    end_date:   endDate,
    hourly:    "temperature_2m,shortwave_radiation",
    timezone:  "UTC", // UTC-Zeitstempel → zeitzonenunabhängige Ausrichtung
  });
  const resp = await fetch(`${ARCHIVE_URL}?${params}`);
  if (!resp.ok) throw new Error(`Open-Meteo Archive HTTP ${resp.status}`);
  const json = await resp.json();
  const h = json.hourly || {};
  return {
    time: h.time || [],
    temp: h.temperature_2m || [],
    ghi:  h.shortwave_radiation || [],
  };
}

/** Bestimmt den nutzbaren Kalibrierzeitraum aus einem Lastgang (mit Archive-Lag). */
export function calibrationDateRange(lastgang, now) {
  if (!lastgang.length) return null;
  const firstTs = new Date(lastgang[0].ts);
  const lastTs  = new Date(lastgang[lastgang.length - 1].ts);
  const maxEnd  = new Date(now.getTime() - ARCHIVE_LAG_DAYS * 86400000);
  const end     = lastTs < maxEnd ? lastTs : maxEnd;
  if (end < firstTs) return null;
  return { start: iso(firstTs), end: iso(end), startMs: firstTs.getTime(), endMs: end.getTime() };
}

function iso(d) { return d.toISOString().slice(0, 10); }

// ── Wetter-Ausrichtung auf Lastgang-Zeitstempel ──────────────────────────────

function alignArchiveToLastgang(weather, lastgang) {
  // Open-Meteo-Archiv (timezone=UTC) liefert Strings ohne Suffix → als UTC parsen.
  const hourMs = weather.time.map(t => parseUtcMs(t));
  if (!hourMs.length) return [];

  return lastgang.map(e => {
    const target = parseUtcMs(e.ts);
    if (target < hourMs[0] || target > hourMs[hourMs.length - 1]) return null;
    let i = 0;
    while (i < hourMs.length - 1 && hourMs[i + 1] <= target) i++;
    const t0 = hourMs[i], t1 = hourMs[Math.min(i + 1, hourMs.length - 1)];
    const frac = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    const lerp = (arr) => {
      const a = arr[i] ?? 0, b = arr[Math.min(i + 1, arr.length - 1)] ?? a;
      return a + (b - a) * Math.max(0, Math.min(1, frac));
    };
    return {
      ts: e.ts,
      s: e.s ?? e.p ?? 0,
      // Regressionsziel: vorzeichenbehaftete Netto-Wirkleistung. Fallback = |S|
      // (Bestandsdaten ohne Vorzeichen → altes Verhalten, Bezug angenommen).
      pSigned: e.pSigned ?? e.s ?? e.p ?? 0,
      temp: lerp(weather.temp),
      ghi: lerp(weather.ghi),
    };
  });
}

// ── Kalibrierung ─────────────────────────────────────────────────────────────

/**
 * Schätzt die wetterabhängigen Lastsensitivitäten per OLS.
 *
 * @param {Array}  lastgang  [{ts, s|p}, …]
 * @param {object} weather   Ergebnis von fetchWeatherArchive
 * @param {object} opts      { tHeiz, tKuehl }
 * @returns {object|null} {
 *   aHeat, aCool, aPv,       // Sensitivitäten (kVA/°C, kVA/°C, kVA je W/m²)
 *   tHeiz, tKuehl,
 *   r2, rmse, n,             // Güte
 *   tMin, tMax, ghiMax,      // abgedeckter Wetterbereich (für Plausibilität)
 *   calibratedAt             // ISO-Zeitstempel (vom Aufrufer gesetzt)
 * }
 */
export function calibrateStation(lastgang, weather, opts = {}) {
  const tHeiz  = opts.tHeiz  ?? DEFAULT_T_HEIZ;
  const tKuehl = opts.tKuehl ?? DEFAULT_T_KUEHL;

  // Prädiktor-Gating aus der Gebiets-Charakteristik (physikalischer Prior).
  // Reduziert Multikollinearität: irrelevante Prädiktoren würden Signal von
  // relevanten stehlen (z.B. spuriose Kühllast raubt PV-Signal bei Sonne=Wärme).
  const fitHeat = opts.fitHeat !== false;      // Heizen fast immer relevant
  const fitCool = opts.fitCool === true;       // nur wo Klimatisierung plausibel
  const fitPv   = opts.fitPv   === true;       // nur bei installierter PV
  if (!fitHeat && !fitCool && !fitPv) return null;

  const aligned = alignArchiveToLastgang(weather, lastgang).filter(Boolean);
  if (aligned.length < 200) return null; // zu wenig überlappende Daten

  const rows = aligned.map(a => {
    const d = new Date(a.ts);
    const isWknd = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0;
    const qod = d.getHours() * 4 + Math.floor(d.getMinutes() / 15); // 0..95
    return {
      bucket: isWknd * 96 + qod,
      s:   a.s,
      ps:  a.pSigned,   // vorzeichenbehaftete Netto-Wirkleistung (Regressionsziel)
      hdd: Math.max(0, tHeiz - a.temp),
      cdd: Math.max(0, a.temp - tKuehl),
      ghi: a.ghi,
      temp: a.temp,
    };
  });

  // Slot-Mittelwerte (Baseline je Bucket) für Zielgröße + alle Prädiktoren.
  // Ziel-Baseline läuft auf pSigned (signiert), damit die Anomalie bei
  // Rückspeisung monoton in der Strahlung bleibt (kein |S|-V-Bias).
  const acc = {};
  for (const r of rows) {
    const b = acc[r.bucket] ||= { n: 0, ps: 0, hdd: 0, cdd: 0, ghi: 0 };
    b.n++; b.ps += r.ps; b.hdd += r.hdd; b.cdd += r.cdd; b.ghi += r.ghi;
  }
  for (const k in acc) {
    const b = acc[k];
    b.ps /= b.n; b.hdd /= b.n; b.cdd /= b.n; b.ghi /= b.n;
  }

  // Nur aktive Prädiktoren in die Designmatrix (Anomalien gegen Slot-Mittel)
  const cols = [];
  if (fitHeat) cols.push("hdd");
  if (fitCool) cols.push("cdd");
  if (fitPv)   cols.push("ghi");

  const X = [], y = [];
  for (const r of rows) {
    const b = acc[r.bucket];
    y.push(r.ps - b.ps);
    X.push(cols.map(c => r[c] - b[c]));
  }

  const coef = olsWithIntercept(X, y); // [b0, …Prädiktor-Koeffizienten in cols-Reihenfolge]
  if (!coef) return null;

  // Güte
  const yMean = mean(y);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < y.length; i++) {
    let pred = coef[0];
    for (let j = 0; j < cols.length; j++) pred += coef[j + 1] * X[i][j];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const rmse = Math.sqrt(ssRes / y.length);

  // Koeffizienten den physikalischen Größen zuordnen (0 wenn nicht gefittet)
  const idx = (name) => cols.indexOf(name);
  const getC = (name) => idx(name) >= 0 ? coef[idx(name) + 1] : 0;

  const temps = rows.map(r => r.temp), ghis = rows.map(r => r.ghi);

  return {
    aHeat:  round3(getC("hdd")),
    aCool:  round3(getC("cdd")),
    aPv:    round4(getC("ghi")),
    tHeiz, tKuehl,
    fitHeat, fitCool, fitPv,
    r2:     round3(r2),
    rmse:   round1(rmse),
    n:      y.length,
    tMin:   round1(Math.min(...temps)),
    tMax:   round1(Math.max(...temps)),
    ghiMax: round1(Math.max(...ghis)),
  };
}

// ── OLS über Normalengleichungen (X'X)b = X'y ────────────────────────────────
// X: n×3 (ohne Intercept-Spalte), intern um 1er-Spalte ergänzt → 4 Parameter.

function olsWithIntercept(X, y) {
  const k = X.length ? X[0].length : 0; // Anzahl Prädiktoren
  const p = k + 1;                      // + Intercept
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);

  for (let i = 0; i < X.length; i++) {
    const xi = [1, ...X[i]];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  return solveLinearSystem(XtX, Xty);
}

/** Löst A·x = b via Gauß-Elimination mit partieller Pivotisierung. */
function solveLinearSystem(A, b) {
  const n = b.length;
  // Augmentierte Matrix
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Pivot suchen
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null; // singulär
    [M[col], M[piv]] = [M[piv], M[col]];

    // Eliminieren
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// ── Utilities ────────────────────────────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
