/**
 * Zentraler State-Store (localStorage + Memory)
 * Unterstützt Subscriptions für reaktive UI-Updates.
 */

const LS_PREFIX = "gs_state_";

export class Store {
  #memory = {};
  #subs = {};          // key → Set<callback>
  #persist = new Set(); // keys, die in localStorage gespeichert werden

  constructor() {
    this.#persist = new Set(["activeTrafoId", "darkMode", "sidebarCollapsed"]);
    this.#loadFromStorage();
  }

  #loadFromStorage() {
    for (const key of this.#persist) {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw !== null) {
        try { this.#memory[key] = JSON.parse(raw); }
        catch { this.#memory[key] = raw; }
      }
    }
  }

  get(key, defaultValue = null) {
    return key in this.#memory ? this.#memory[key] : defaultValue;
  }

  set(key, value) {
    const old = this.#memory[key];
    this.#memory[key] = value;
    if (this.#persist.has(key)) {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    }
    if (old !== value) this.#notify(key, value, old);
    return this;
  }

  /** Merge-Update für Objekte */
  merge(key, partial) {
    const current = this.get(key, {});
    this.set(key, { ...current, ...partial });
    return this;
  }

  subscribe(key, callback) {
    if (!this.#subs[key]) this.#subs[key] = new Set();
    this.#subs[key].add(callback);
    return () => this.#subs[key].delete(callback); // Unsubscribe
  }

  #notify(key, newVal, oldVal) {
    this.#subs[key]?.forEach(cb => {
      try { cb(newVal, oldVal); }
      catch (e) { console.error("[store] Subscriber-Fehler:", e); }
    });
  }

  getState() {
    return { ...this.#memory };
  }
}

export const store = new Store();

// ── Demo-Daten Generator ──────────────────────────────────────────────────────

/**
 * Generiert einen realistischen 30-Tage-Lastgang für einen 630 kVA Trafo.
 * 15-Minuten-Auflösung → 30 × 96 = 2880 Datenpunkte.
 */
export function generateDemoData(trafoId = "trafo-1", nennleistung = 630, days = 30) {
  const entries = [];
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  for (let d = 0; d < days; d++) {
    const date = new Date(start);
    date.setDate(date.getDate() + d);
    const dow = date.getDay(); // 0=So, 6=Sa
    const isWeekend = dow === 0 || dow === 6;

    for (let slot = 0; slot < 96; slot++) {
      const h = slot / 4;            // Stunde (0..23.75)
      const baseLoad = loadProfile(h, isWeekend);
      const noise = 1 + (Math.random() - 0.5) * 0.15;
      const seasonal = seasonalFactor(date);

      const s = Math.max(20, baseLoad * nennleistung * noise * seasonal);
      const pf = 0.88 + Math.random() * 0.08; // cos φ 0.88–0.96
      const p = s * pf;
      const q = Math.sqrt(Math.max(0, s * s - p * p));

      const ts = new Date(date);
      ts.setMinutes(slot * 15);

      entries.push({
        ts: ts.toISOString(),
        p:  round2(p),
        q:  round2(q),
        s:  round2(s),
      });
    }
  }
  return entries;
}

/** Normalisiertes Lastprofil (0..1) für eine Stunde des Tages */
function loadProfile(hour, isWeekend) {
  const weekday = [
    // h=0..23 (interpoliert)
    [0, 0.18], [1, 0.16], [2, 0.15], [3, 0.15], [4, 0.16], [5, 0.20],
    [6, 0.35], [7, 0.58], [8, 0.75], [9, 0.80], [10, 0.78], [11, 0.72],
    [12, 0.68], [13, 0.65], [14, 0.62], [15, 0.64], [16, 0.70], [17, 0.82],
    [18, 0.90], [19, 0.88], [20, 0.80], [21, 0.65], [22, 0.50], [23, 0.30],
  ];
  const weekend = weekday.map(([h, v]) => [h, v * 0.72]);
  const profile = isWeekend ? weekend : weekday;
  return interpolate(profile, hour);
}

function interpolate(points, x) {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return points[points.length - 1][1];
}

function seasonalFactor(date) {
  const month = date.getMonth(); // 0=Jan
  // Winter (Dez-Feb): +15%, Sommer (Jun-Aug): -8%
  const factors = [1.12, 1.10, 1.05, 0.98, 0.94, 0.92, 0.90, 0.92, 0.96, 1.00, 1.05, 1.12];
  return factors[month];
}

function round2(v) { return Math.round(v * 100) / 100; }

// ── Stationsflotte ─────────────────────────────────────────────────────────────

const LS_FLEET = "gs_fleet";

export function getTrafoIds() {
  try { return JSON.parse(localStorage.getItem(LS_FLEET) || '["trafo-1"]'); }
  catch { return ["trafo-1"]; }
}

export function addTrafoId(id) {
  const ids = getTrafoIds();
  if (!ids.includes(id)) localStorage.setItem(LS_FLEET, JSON.stringify([...ids, id]));
}

export function removeTrafoId(id) {
  const ids = getTrafoIds().filter(i => i !== id);
  localStorage.setItem(LS_FLEET, JSON.stringify(ids.length ? ids : ["trafo-1"]));
}

export function nextTrafoId() {
  const ids  = getTrafoIds();
  const nums = ids.map(id => parseInt(id.replace("trafo-", ""))).filter(n => !isNaN(n));
  return `trafo-${nums.length ? Math.max(...nums) + 1 : 2}`;
}

/** Demo-Stammdaten (Werte technisch korrekt für SWM-Netz München: 10-kV-MS-Netz, Dyn5, uk=4 %) */
export function getDemoStammdaten() {
  return [
    {
      id: "trafo-1",
      name: "Trafostation Mitte",
      nennleistung: 630,
      spannungOS: 10,      // SWM München: Mittelspannungsnetz 10 kV
      spannungUS: 0.4,
      baujahr: 2008,
      standort: "Musterstraße 1, 80331 München",
      schaltgruppe: "Dyn5",
      kurzschlussspannung: 4.0,
      kosFi: 0.92,
      lat: 48.13513,
      lon: 11.58198,
    },
  ];
}
