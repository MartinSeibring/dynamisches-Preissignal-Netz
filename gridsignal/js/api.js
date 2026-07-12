/*
 * ============================================================
 * BACKEND API CONTRACT (OpenAPI 3.0 summary)
 * ============================================================
 *
 * Base URL: BRAND.api.baseUrl (z.B. "https://api.mein-netz.de/v1")
 *
 * GET    /health
 *        → { status: "ok", version: string, timestamp: string }
 *
 * GET    /trafos
 *        → Trafo[]
 * POST   /trafos
 *        Body: Trafo (ohne id) → Trafo (mit id)
 * PUT    /trafos/:id
 *        Body: Trafo → Trafo
 *
 * GET    /lastgang?trafoId=&from=ISO&to=ISO
 *        → LastgangEntry[]
 *        LastgangEntry: { ts: string, p: number, q: number, s: number }
 *
 * POST   /lastgang/upload
 *        Content-Type: multipart/form-data
 *        Fields: file (CSV), trafoId (string)
 *        → { count: number, from: string, to: string }
 *
 * WS     /lastgang/live/:trafoId
 *        Server → Client: LastgangEntry (JSON)
 *
 * GET    /prognose?trafoId=&methode=ma|ets|holt|holtwinters&horizont=&alpha=&beta=&gamma=&seasonLen=&konfidenz=
 *        → { forecast: ForecastEntry[], method: string, params: object }
 *        ForecastEntry: { ts: string, value: number, lower: number, upper: number }
 *
 * GET    /preissignal?trafoId=&basisCt=&schwelleGelb=&schwelleOrange=&schwelleRot=
 *                    &multGelb=&multOrange=&multRot=&modell=linear|step
 *        → SignalEntry[]
 *        SignalEntry: { ts: string, util: number, zone: string, price: number }
 *
 * POST   /export
 *        Body: { format: "csv"|"json", data: any[], filename?: string }
 *        → file download (Content-Disposition: attachment)
 *
 * ============================================================
 */

const LS_KEYS = {
  stammdaten: "gs_stammdaten",
  lastgang:   "gs_lastgang",
};

export class ApiClient {
  #brand;
  #baseUrl;
  #ws = null;

  constructor(brand) {
    this.#brand = brand;
    this.#baseUrl = brand.api.baseUrl || null;
  }

  get isOnline() { return !!this.#baseUrl; }

  // ---- Auth header ---- //
  #authHeaders() {
    const { authType, authHeader } = this.#brand.api;
    const token = localStorage.getItem("gs_auth_token");
    if (!token || authType === "none") return {};
    if (authType === "apikey") return { [authHeader]: token };
    return { [authHeader]: `Bearer ${token}` };
  }

  // ---- Fetch wrapper ---- //
  async #fetch(path, opts = {}) {
    const url = this.#baseUrl + path;
    const headers = {
      "Content-Type": "application/json",
      ...this.#brand.api.defaultHeaders,
      ...this.#authHeaders(),
      ...(opts.headers || {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#brand.api.timeout);

    try {
      const res = await fetch(url, {
        ...opts,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ApiError(res.status, text || res.statusText, path);
      }
      const ct = res.headers.get("Content-Type") || "";
      if (ct.includes("application/json")) return res.json();
      return res.text();
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") throw new ApiError(408, "Timeout", path);
      throw err;
    }
  }

  // ---- Health ---- //
  async ping() {
    if (!this.isOnline) return { status: "offline", mode: "localStorage" };
    try {
      return await this.#fetch("/health");
    } catch {
      return { status: "error" };
    }
  }

  // ---- Stammdaten ---- //
  async getStammdaten() {
    if (!this.isOnline) {
      const raw = localStorage.getItem(LS_KEYS.stammdaten);
      return raw ? JSON.parse(raw) : [];
    }
    return this.#fetch("/trafos");
  }

  async saveStammdaten(data) {
    if (!this.isOnline) {
      const all = await this.getStammdaten();
      const idx = all.findIndex(t => t.id === data.id);
      if (idx >= 0) {
        all[idx] = data;
      } else {
        data.id = data.id || `trafo-${Date.now()}`;
        all.push(data);
      }
      localStorage.setItem(LS_KEYS.stammdaten, JSON.stringify(all));
      return data;
    }
    if (data.id) {
      return this.#fetch(`/trafos/${data.id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    }
    return this.#fetch("/trafos", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ---- Lastgang ---- //
  async getLastgang(trafoId, from, to) {
    if (!this.isOnline) {
      const raw = localStorage.getItem(LS_KEYS.lastgang);
      if (!raw) return [];
      const all = JSON.parse(raw);
      const entries = all[trafoId] || [];
      if (!from && !to) return entries;
      const f = from ? new Date(from).getTime() : 0;
      const t = to   ? new Date(to).getTime()   : Infinity;
      return entries.filter(e => {
        const ts = new Date(e.ts).getTime();
        return ts >= f && ts <= t;
      });
    }
    const params = new URLSearchParams({ trafoId });
    if (from) params.set("from", from);
    if (to)   params.set("to", to);
    return this.#fetch(`/lastgang?${params}`);
  }

  async saveLastgangLocal(trafoId, entries) {
    const raw = localStorage.getItem(LS_KEYS.lastgang);
    const all = raw ? JSON.parse(raw) : {};
    all[trafoId] = entries;
    localStorage.setItem(LS_KEYS.lastgang, JSON.stringify(all));
  }

  async uploadLastgang(trafoId, csvText) {
    if (!this.isOnline) {
      const parsed = parseCsv(csvText);
      await this.saveLastgangLocal(trafoId, parsed);
      return { count: parsed.length };
    }
    const blob = new Blob([csvText], { type: "text/csv" });
    const form = new FormData();
    form.append("file", blob, "lastgang.csv");
    form.append("trafoId", trafoId);
    return this.#fetch("/lastgang/upload", {
      method: "POST",
      headers: { ...this.#authHeaders() },
      body: form,
    });
  }

  streamLastgang(trafoId, callback) {
    if (!this.isOnline) {
      console.warn("[api] streamLastgang: kein Backend, WebSocket nicht verfügbar");
      return () => {};
    }
    const wsUrl = this.#baseUrl.replace(/^http/, "ws") + `/lastgang/live/${trafoId}`;
    this.#ws = new WebSocket(wsUrl);
    this.#ws.onmessage = e => {
      try { callback(null, JSON.parse(e.data)); } catch (err) { callback(err); }
    };
    this.#ws.onerror = err => callback(err);
    return () => { if (this.#ws) { this.#ws.close(); this.#ws = null; } };
  }

  // ---- Prognose ---- //
  async getPrognose(trafoId, params = {}) {
    if (!this.isOnline) return null; // Fallback auf lokale Berechnung
    const p = new URLSearchParams({ trafoId, ...params });
    try {
      return await this.#fetch(`/prognose?${p}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ---- Preissignal ---- //
  async getPreissignal(trafoId, params = {}) {
    if (!this.isOnline) return null;
    const p = new URLSearchParams({ trafoId, ...params });
    return this.#fetch(`/preissignal?${p}`);
  }

  async exportPreissignal(data, format = "csv") {
    if (!this.isOnline || format === "csv") {
      return localCsvDownload(data);
    }
    return this.#fetch("/export", {
      method: "POST",
      body: JSON.stringify({ format, data }),
    });
  }
}

// ---- Fehlerklasse ---- //
export class ApiError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

// ---- CSV-Parser ---- //
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(/[;,]/).map(h => h.trim().toLowerCase());

  // Spalten-Mapping: akzeptiert verschiedene Spaltennamen
  const colMap = {
    ts: ["timestamp", "ts", "zeit", "time", "datum", "date", "datetime"],
    p:  ["p_kw", "p", "wirkleistung", "kw", "power", "active_power", "p_active"],
    q:  ["q_kvar", "q", "blindleistung", "kvar", "reactive_power"],
    s:  ["s_kva", "s", "scheinleistung", "kva", "apparent_power"],
  };

  const indices = {};
  for (const [field, aliases] of Object.entries(colMap)) {
    indices[field] = aliases.reduce((found, alias) => {
      if (found >= 0) return found;
      const i = header.findIndex(h => h.includes(alias));
      return i >= 0 ? i : -1;
    }, -1);
  }

  if (indices.ts < 0) throw new Error("CSV: Keine Zeitstempel-Spalte gefunden");
  if (indices.p < 0 && indices.s < 0)
    throw new Error("CSV: Keine Leistungsspalte (P oder S) gefunden");

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/[;,]/).map(c => c.trim().replace(",", "."));
    if (cols.length < 2 || !cols[0]) continue;

    const tsRaw = cols[indices.ts];
    const ts = parseTimestamp(tsRaw);
    if (!ts) continue;

    const p = indices.p >= 0 ? parseFloat(cols[indices.p]) : NaN;
    const q = indices.q >= 0 ? parseFloat(cols[indices.q]) : NaN;
    const s = indices.s >= 0 ? parseFloat(cols[indices.s]) : NaN;

    // Berechne fehlende Werte. `p`/`s` bleiben Beträge (Magnitude) für alle
    // bestehenden Verbraucher; das Vorzeichen (Einspeisung) lebt in `pSigned`.
    const pMag = isFinite(p) ? Math.abs(p) : NaN;
    const pFin = isFinite(pMag) ? pMag : (isFinite(s) ? s * 0.9 : 0);
    const qFin = isFinite(q) ? q : (isFinite(s) && isFinite(pMag) ? Math.sqrt(Math.max(0, s*s - pMag*pMag)) : 0);
    const sFin = isFinite(s) ? s : Math.sqrt(pFin * pFin + qFin * qFin);

    // Vorzeichenbehaftete Netto-Wirkleistung (negativ = Rückspeisung/Einspeisung).
    // Liegt nur |S| vor, wird Bezug angenommen (pSigned = s), da keine Richtungsinfo existiert.
    const pSigned = isFinite(p) ? p : (isFinite(s) ? s : pFin);

    entries.push({ ts, p: round2(pFin), q: round2(qFin), s: round2(sFin), pSigned: round2(pSigned) });
  }

  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

function parseTimestamp(raw) {
  if (!raw) return null;
  // DD.MM.YYYY HH:MM
  const de = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (de) {
    const [, d, m, y, h, min] = de;
    return new Date(+y, +m - 1, +d, +h, +min).toISOString();
  }
  // ISO or standard
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

function round2(v) { return Math.round(v * 100) / 100; }

// ---- Lokaler CSV-Download ---- //
export function localCsvDownload(rows, filename = "preissignal.csv") {
  if (!rows || !rows.length) return;
  const header = Object.keys(rows[0]).join(";");
  const body = rows.map(r => Object.values(r).join(";")).join("\n");
  const csv = `﻿${header}\n${body}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Singleton ---- //
let _api = null;
export function initApi(brand) {
  _api = new ApiClient(brand);
  return _api;
}
export function getApi() { return _api; }
