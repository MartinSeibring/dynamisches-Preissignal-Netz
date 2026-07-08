/**
 * Wetterintegration für die Lastprognose (Stufe 1)
 * ================================================
 *
 * Quelle: Open-Meteo (https://open-meteo.com) – kostenlos, ohne API-Key, CORS-fähig.
 *
 * Ziel: Die rein datengetriebene Holt-Winters-Prognose wird um eine physikalisch
 * motivierte Wetterkorrektur ergänzt, um zwei in Süddeutschland dominierende
 * Effekte abzubilden:
 *
 *   1) Wärmepumpen-Zusatzlast (temperaturabhängig)
 *      → relevant für ländliche Randgebiete ohne Fernwärme.
 *      Modell: Heizgradabhängige Mehrlast relativ zur klimatologischen Normaltemperatur.
 *
 *   2) PV-Einspeisung (strahlungsabhängig)
 *      → relevant für PV-starke Konzessionen (z.B. Moosburg a. d. Isar).
 *      Modell: Abweichung der prognostizierten Solarstrahlung vom klimatologischen
 *      Erwartungswert korrigiert die am Trafo gemessene Netto-Last.
 *
 * Die Korrektur ist bewusst als transparentes First-Order-Modell ausgelegt:
 * jede Komponente ist einzeln nachvollziehbar und pro Station parametrierbar.
 * Eine datenbasierte Regression (Stufe 2/3) kann später darauf aufsetzen.
 */

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// ── Klimatologie München / Oberbayern ────────────────────────────────────────
// Monatliche Normaltemperatur (°C, Referenzperiode ~1991–2020, Station München)
const T_NORMAL_MONTH = [0.3, 1.5, 5.5, 9.8, 14.3, 17.6, 19.5, 19.0, 14.4, 9.7, 4.5, 1.2];

// Klimatologischer Clearness-Index (Verhältnis realer GHI zu Clear-Sky-GHI im Mittel).
// Für Oberbayern liegt der Jahresmittelwert bei ~0.50–0.55; monatlich leicht variierend
// (im Sommer höher, im Nebelwinter niedriger).
const CLEARNESS_MONTH = [0.42, 0.46, 0.50, 0.53, 0.55, 0.56, 0.56, 0.55, 0.52, 0.47, 0.40, 0.38];

// Performance Ratio einer typischen Aufdach-PV-Anlage (Verluste Wechselrichter,
// Temperatur, Verkabelung, Verschmutzung).
const PV_PERFORMANCE_RATIO = 0.82;

// Standard-Test-Bedingungen: 1000 W/m² Bestrahlungsstärke.
const GHI_STC = 1000;

// Sensitivität der Wärmepumpen-Last: relativer Lastzuwachs je °C unter Normaltemperatur,
// bezogen auf den wärmepumpenabhängigen Lastanteil. ~6 %/°C ist ein belastbarer
// First-Order-Wert (Kennfeld Luft/Wasser-WP inkl. sinkendem COP bei Kälte).
const WP_SENSITIVITY_PER_K = 0.06;

// ── Netzgebietstypen mit Voreinstellungen ────────────────────────────────────
// Setzen sinnvolle Default-Parameter je Charakteristik. Pro Station überschreibbar.
export const NETZGEBIET_PRESETS = {
  fernwaerme: {
    label: "Metropol / Fernwärme",
    hint:  "Wärme elektrisch entkoppelt → geringe Temperaturabhängigkeit",
    wpAnteil: 0, pvLeistung: 0, heizgrenze: 15,
  },
  waermepumpe: {
    label: "Ländlich / Wärmepumpen",
    hint:  "Starke temperaturabhängige Heizlast im Winter",
    wpAnteil: 40, pvLeistung: 0, heizgrenze: 15,
  },
  pv: {
    label: "PV-stark (z.B. Moosburg)",
    hint:  "Netto-Last stark strahlungsabhängig (Duck-Curve)",
    wpAnteil: 10, pvLeistung: 500, heizgrenze: 15,
  },
  gemischt: {
    label: "Gemischt (WP + PV)",
    hint:  "Temperatur- und strahlungsabhängige Anteile",
    wpAnteil: 25, pvLeistung: 250, heizgrenze: 15,
  },
};

export function getNetzgebietDefaults(typ) {
  return NETZGEBIET_PRESETS[typ] || NETZGEBIET_PRESETS.gemischt;
}

// ── Open-Meteo Abruf ─────────────────────────────────────────────────────────

/**
 * Ruft die stündliche Wetterprognose für die kommenden `days` Tage ab.
 * @returns {Promise<{time:string[], temp:number[], ghi:number[], cloud:number[]}>}
 */
export async function fetchWeatherForecast(lat, lon, days = 7) {
  const params = new URLSearchParams({
    latitude:     lat.toFixed(4),
    longitude:    lon.toFixed(4),
    hourly:       "temperature_2m,shortwave_radiation,cloud_cover",
    forecast_days: String(Math.min(16, Math.max(1, days))),
    timezone:     "Europe/Berlin",
  });

  const resp = await fetch(`${OPEN_METEO_URL}?${params}`);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const json = await resp.json();
  const h = json.hourly || {};

  return {
    time:  h.time || [],
    temp:  h.temperature_2m || [],
    ghi:   h.shortwave_radiation || [],
    cloud: h.cloud_cover || [],
  };
}

// ── Solargeometrie (Clear-Sky-GHI nach Haurwitz) ─────────────────────────────
// Liefert die theoretische wolkenfreie Globalstrahlung für einen Zeitpunkt.
// Dient als Referenzform, gegen die die prognostizierte Strahlung normiert wird.

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start;
  return Math.floor(diff / 86400000);
}

/** Sonnenhöhe (Elevation) in Grad für lat/lon zu einem lokalen Zeitpunkt. */
function solarElevation(lat, lon, date) {
  const rad = Math.PI / 180;
  const N = dayOfYear(date);
  // Deklination der Sonne
  const decl = 23.45 * rad * Math.sin(2 * Math.PI * (284 + N) / 365);
  // Lokale Sonnenzeit (grobe Näherung ohne Zeitgleichung; für Formzwecke ausreichend)
  const localHour = date.getHours() + date.getMinutes() / 60;
  const solarTime = localHour + (lon - 15) / 15; // 15° = Referenzmeridian MEZ
  const H = 15 * rad * (solarTime - 12);         // Stundenwinkel
  const latR = lat * rad;
  const sinElev = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / rad;
}

/** Clear-Sky-GHI (W/m²) nach dem Haurwitz-Modell. 0 bei Sonne unter Horizont. */
function clearSkyGHI(lat, lon, date) {
  const elev = solarElevation(lat, lon, date);
  if (elev <= 0) return 0;
  const sinElev = Math.sin(elev * Math.PI / 180);
  return 1098 * sinElev * Math.exp(-0.059 / sinElev);
}

// ── Interpolation stündlich → 15-min-Slots ───────────────────────────────────

/**
 * Bildet stündliche Wetterwerte auf die Prognose-Zeitstempel (15-min-Raster) ab.
 * @param weather  Ergebnis von fetchWeatherForecast
 * @param slotTsIso  Array von ISO-Zeitstempeln der Prognoseslots
 * @returns Array<{ts, temp, ghi, cloud}>
 */
function alignWeatherToSlots(weather, slotTsIso) {
  // Baue Lookup von Stunden-Timestamp (ms) → Index
  const hourMs = weather.time.map(t => new Date(t).getTime());

  return slotTsIso.map(ts => {
    const target = new Date(ts).getTime();
    // Finde die umschließende Stunde für lineare Interpolation
    let i = 0;
    while (i < hourMs.length - 1 && hourMs[i + 1] <= target) i++;
    const t0 = hourMs[i];
    const t1 = hourMs[Math.min(i + 1, hourMs.length - 1)];
    const frac = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    const lerp = (arr) => {
      const a = arr[i] ?? 0;
      const b = arr[Math.min(i + 1, arr.length - 1)] ?? a;
      return a + (b - a) * Math.max(0, Math.min(1, frac));
    };
    return {
      ts,
      temp:  lerp(weather.temp),
      ghi:   lerp(weather.ghi),
      cloud: lerp(weather.cloud),
    };
  });
}

// ── Wetterkorrektur der Prognose ─────────────────────────────────────────────

/**
 * Wendet die Wetterkorrektur auf eine Basis-Prognose an.
 *
 * @param {number[]} baseForecast  Basis-Lastprognose (kVA) je Slot
 * @param {string[]} slotTsIso     Zeitstempel je Slot (ISO)
 * @param {object}   weather       Ergebnis von fetchWeatherForecast
 * @param {object}   cfg           Stationskonfiguration:
 *                                  { lat, lon, wpAnteil (%), pvLeistung (kWp), heizgrenze (°C) }
 * @returns {{
 *   corrected: number[],   // wetterkorrigierte Prognose (kVA)
 *   deltaWp:   number[],   // Wärmepumpen-Beitrag je Slot (kVA)
 *   deltaPv:   number[],   // PV-Beitrag je Slot (kVA, i.d.R. negativ)
 *   slots:     Array,      // ausgerichtete Wetterwerte je Slot
 * }}
 */
export function applyWeatherCorrection(baseForecast, slotTsIso, weather, cfg) {
  const slots = alignWeatherToSlots(weather, slotTsIso);
  const wpShare = Math.max(0, (cfg.wpAnteil || 0) / 100);
  const pvKwp   = Math.max(0, cfg.pvLeistung || 0);
  const heiz    = cfg.heizgrenze ?? 15;
  const lat = cfg.lat, lon = cfg.lon;

  const corrected = [];
  const deltaWp = [];
  const deltaPv = [];

  for (let i = 0; i < baseForecast.length; i++) {
    const base = baseForecast[i] || 0;
    const w = slots[i];
    const date = new Date(w.ts);
    const month = date.getMonth();

    // ── Wärmepumpen-Korrektur (Temperatur) ──────────────────────────────────
    // Nur im Heizregime (Außentemperatur unter Heizgrenze). Mehrlast proportional
    // zur Abweichung von der monatlichen Normaltemperatur.
    let dWp = 0;
    if (wpShare > 0 && w.temp < heiz) {
      const deltaT = T_NORMAL_MONTH[month] - w.temp; // >0 = kälter als normal
      dWp = base * wpShare * WP_SENSITIVITY_PER_K * deltaT;
    }

    // ── PV-Korrektur (Strahlung) ────────────────────────────────────────────
    // Die Basis-Prognose enthält bereits die durchschnittliche PV-Einspeisung
    // (im Netto-Lastgang gelernt). Korrigiert wird die ABWEICHUNG der
    // prognostizierten Strahlung vom klimatologischen Erwartungswert.
    let dPv = 0;
    if (pvKwp > 0 && lat != null && lon != null) {
      const clearSky = clearSkyGHI(lat, lon, date);
      if (clearSky > 5) {
        const ghiExpected = clearSky * CLEARNESS_MONTH[month]; // klimatolog. Erwartung
        const ghiDelta = w.ghi - ghiExpected;                  // >0 = sonniger als normal
        // Mehr PV als normal → geringere Netto-Last (negativer Beitrag)
        const dPvKw = -pvKwp * PV_PERFORMANCE_RATIO * (ghiDelta / GHI_STC);
        dPv = dPvKw; // kW ≈ kVA-Größenordnung für die Korrektur
      }
    }

    deltaWp.push(round1(dWp));
    deltaPv.push(round1(dPv));
    corrected.push(Math.max(0, round1(base + dWp + dPv)));
  }

  return { corrected, deltaWp, deltaPv, slots };
}

/** Kompakte Wetter-Kennzahlen für die UI-Anzeige. */
export function weatherSummary(weather, slotTsIso) {
  const slots = alignWeatherToSlots(weather, slotTsIso);
  if (!slots.length) return null;
  const temps = slots.map(s => s.temp);
  const ghis  = slots.map(s => s.ghi);
  return {
    tMin:    Math.min(...temps),
    tMax:    Math.max(...temps),
    ghiMax:  Math.max(...ghis),
    ghiSum:  ghis.reduce((a, b) => a + b, 0) * 0.25 / 1000, // grobe kWh/m²-Summe (15-min)
    cloudAvg: slots.reduce((a, s) => a + s.cloud, 0) / slots.length,
  };
}

function round1(v) { return Math.round(v * 10) / 10; }
