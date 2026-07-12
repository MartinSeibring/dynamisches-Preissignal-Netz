import { getApi } from "../api.js?v=20260712";
import { store } from "../store.js?v=20260712";
import { chartManager } from "../charts.js?v=20260712";
import { forecast } from "../forecast.js?v=20260712";
import { showToast } from "../toast.js?v=20260712";
import { fetchWeatherForecast, applyWeatherCorrection, weatherSummary } from "../weather.js?v=20260712";
import { fetchWeatherArchive, calibrateStation, calibrationDateRange } from "../calibration.js?v=20260712";

const METHODS = [
  { value: "ma",         label: "Moving Average (MA)",            params: ["window","horizont"] },
  { value: "ses",        label: "Exp. Glättung (SES)",            params: ["alpha","horizont"] },
  { value: "holt",       label: "Holt (Trend + Level)",           params: ["alpha","beta","horizont"] },
  { value: "holtwinters",label: "Holt-Winters (Saison + Trend)",  params: ["alpha","beta","gamma","seasonLen","horizont"] },
];

export default {
  id: "prognose",
  label: "Prognose",
  icon: "trending",

  render(container) {
    container.innerHTML = buildHTML();
    this.bindEvents(container);
    this.load(container);
  },

  destroy() {
    chartManager.destroy("forecast-chart");
  },

  async renderStationSelector(container) {
    const api    = getApi();
    const trafos = await api.getStammdaten();
    if (trafos.length <= 1) return;

    const card = container.querySelector("#prognose-station-card");
    if (card) card.style.display = "";

    const sel    = container.querySelector("#prognose-station-sel");
    const filter = container.querySelector("#prognose-station-filter");
    const active = store.get("activeTrafoId", "trafo-1");

    const populate = (txt = "") => {
      const lf = txt.toLowerCase();
      const visible = lf
        ? trafos.filter(t =>
            (t.name || "").toLowerCase().includes(lf) ||
            (t.plz  || "").toLowerCase().includes(lf))
        : trafos;
      sel.innerHTML = visible.map(t =>
        `<option value="${t.id}" ${t.id === active ? "selected" : ""}>${t.name || t.id}${t.plz ? " · " + t.plz : ""}</option>`
      ).join("");
    };

    populate();
    filter?.addEventListener("input", e => populate(e.target.value.trim()));

    sel.onchange = () => {
      store.set("activeTrafoId", sel.value);
      this.load(container);
    };
  },

  bindEvents(container) {
    const methodSel = container.querySelector("#fc-method");
    methodSel?.addEventListener("change", () => this.toggleParams(container));

    container.querySelector("#btn-run-forecast")
      ?.addEventListener("click", () => this.runForecast(container));

    container.querySelector("#btn-calibrate")
      ?.addEventListener("click", () => this.calibrate(container));

    // Dynamische Range-Labels
    ["alpha","beta","gamma"].forEach(p => {
      const input = container.querySelector(`#fc-${p}`);
      const label = container.querySelector(`#fc-${p}-val`);
      input?.addEventListener("input", () => { if (label) label.textContent = input.value; });
    });
  },

  async load(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    await this.renderStationSelector(container);
    try {
      const api     = getApi();
      const lastgang = await api.getLastgang(trafoId);
      if (lastgang.length) {
        store.set("lastgang_cache_" + trafoId, lastgang);
        this.runForecast(container);
      } else {
        container.querySelector("#no-data-fc").style.display = "";
        container.querySelector("#fc-result").style.display = "none";
      }
    } catch (e) {
      showToast("error", "Ladefehler", e.message);
    }
  },

  toggleParams(container) {
    const method = container.querySelector("#fc-method")?.value;
    const m = METHODS.find(m => m.value === method);
    const allParams = ["window","alpha","beta","gamma","seasonLen","horizont"];
    allParams.forEach(p => {
      const row = container.querySelector(`#param-row-${p}`);
      if (row) row.style.display = m?.params?.includes(p) ? "" : "none";
    });
  },

  async runForecast(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    const method  = container.querySelector("#fc-method")?.value || "holtwinters";
    const horizont = parseInt(container.querySelector("#fc-horizont")?.value) || 96;

    const params = {
      window:    parseInt(container.querySelector("#fc-window")?.value) || 96,
      alpha:     parseFloat(container.querySelector("#fc-alpha")?.value) || 0.3,
      beta:      parseFloat(container.querySelector("#fc-beta")?.value)  || 0.1,
      gamma:     parseFloat(container.querySelector("#fc-gamma")?.value) || 0.2,
      seasonLen: parseInt(container.querySelector("#fc-seasonlen")?.value) || 96,
      horizont,
    };

    const btn = container.querySelector("#btn-run-forecast");
    if (btn) { btn.disabled = true; btn.classList.add("btn-loading"); }

    try {
      // Zuerst Backend-Prognose versuchen
      const api = getApi();
      let result = await api.getPrognose(trafoId, { methode: method, horizont, ...params });

      if (!result) {
        // Lokale Berechnung
        let lastgang = store.get("lastgang_cache_" + trafoId);
        if (!lastgang) {
          lastgang = await api.getLastgang(trafoId);
          store.set("lastgang_cache_" + trafoId, lastgang);
        }
        if (!lastgang?.length) {
          showToast("warning", "Keine Daten", "Bitte zuerst Lastgangdaten laden.");
          return;
        }
        const series = lastgang.map(e => e.s || e.p || 0);
        result = forecast(series, method, params);
        result._local = true;

        // Timestamps für Prognose generieren
        const lastTs = new Date(lastgang[lastgang.length - 1].ts);
        result._histTs  = lastgang.map(e => e.ts);
        result._histVal = lastgang.map(e => e.s || e.p || 0);
        result._fcTs = Array.from({ length: horizont }, (_, i) => {
          const d = new Date(lastTs);
          d.setMinutes(d.getMinutes() + (i + 1) * 15);
          return d.toISOString();
        });
      }

      // ── Wetterkorrektur (Stufe 1) ─────────────────────────────────────────
      const weatherOn = container.querySelector("#fc-weather-toggle")?.checked;
      if (weatherOn && result.forecast?.length && result._fcTs?.length) {
        await this.applyWeather(container, result, trafoId, api);
      }

      this.renderResult(container, result, params);
    } catch (e) {
      showToast("error", "Prognose-Fehler", e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("btn-loading"); }
    }
  },

  async applyWeather(container, result, trafoId, api) {
    try {
      const trafos = await api.getStammdaten();
      const trafo  = trafos.find(t => t.id === trafoId) || {};
      const lat = trafo.lat ?? 48.1351;   // Fallback: München-Zentrum
      const lon = trafo.lon ?? 11.582;
      const cfg = {
        lat, lon,
        wpAnteil:   trafo.wpAnteil   ?? 0,
        pvLeistung: trafo.pvLeistung ?? 0,
        heizgrenze: trafo.heizgrenze ?? 15,
        netzgebiet: trafo.netzgebiet ?? "gemischt",
        calib:      trafo.calib || null,   // Stufe 2: gelernte Sensitivitäten
      };
      const days    = Math.min(16, Math.ceil(result._fcTs.length / 96) + 1);
      const weather = await fetchWeatherForecast(lat, lon, days);
      const corr    = applyWeatherCorrection(result.forecast, result._fcTs, weather, cfg);

      result._corrected = corr.corrected;
      result._deltaWp   = corr.deltaWp;
      result._deltaCool = corr.deltaCool;
      result._deltaPv   = corr.deltaPv;
      result._corrMode  = corr.mode;
      result._weather   = weatherSummary(weather, result._fcTs);
      result._weatherCfg = cfg;

      if (!trafo.lat || !trafo.lon) {
        showToast("info", "Wetterkorrektur", "Keine GPS-Koordinaten hinterlegt – München-Zentrum als Näherung verwendet.");
      }
    } catch (e) {
      showToast("warning", "Wetterdaten", "Open-Meteo nicht erreichbar – zeige unkorrigierte Prognose.");
    }
  },

  async calibrate(container) {
    const btn = container.querySelector("#btn-calibrate");
    const trafoId = store.get("activeTrafoId", "trafo-1");
    const api = getApi();

    if (btn) { btn.disabled = true; btn.classList.add("btn-loading"); }
    try {
      const trafos = await api.getStammdaten();
      const trafo  = trafos.find(t => t.id === trafoId);
      if (!trafo) { showToast("warning", "Keine Station", "Aktive Station nicht gefunden."); return; }
      if (!trafo.lat || !trafo.lon) {
        showToast("warning", "Kalibrierung", "Station benötigt GPS-Koordinaten (Stammdaten) für Archivabruf.");
        return;
      }

      let lastgang = store.get("lastgang_cache_" + trafoId);
      if (!lastgang) { lastgang = await api.getLastgang(trafoId); }
      if (!lastgang?.length) { showToast("warning", "Keine Daten", "Kein Lastgang zum Kalibrieren."); return; }

      const range = calibrationDateRange(lastgang, new Date());
      if (!range) { showToast("warning", "Zeitraum", "Lastgang liegt außerhalb des Archivzeitraums."); return; }

      showToast("info", "Kalibrierung", `Lade Archiv-Wetter ${range.start} … ${range.end} …`);
      const archive = await fetchWeatherArchive(trafo.lat, trafo.lon, range.start, range.end);

      // Nur überlappende Messpunkte verwenden
      const usable = lastgang.filter(e => {
        const t = new Date(e.ts).getTime();
        return t >= range.startMs && t <= range.endMs;
      });

      // Prädiktor-Gating aus Gebiets-Charakteristik (physikalischer Prior)
      const gebiet = trafo.netzgebiet || "gemischt";
      const calib = calibrateStation(usable, archive, {
        tHeiz:   trafo.heizgrenze ?? 15,
        fitHeat: true,
        fitCool: gebiet === "fernwaerme" || gebiet === "gemischt",
        fitPv:   (trafo.pvLeistung ?? 0) > 0 || gebiet === "pv" || gebiet === "gemischt",
      });
      if (!calib) {
        showToast("error", "Kalibrierung fehlgeschlagen", "Zu wenige überlappende Daten oder keine Wettervariation.");
        return;
      }
      calib.calibratedAt = new Date().toISOString();

      // Persistieren in Stammdaten
      const updated = { ...trafo, calib };
      await api.saveStammdaten(updated);
      store.set("stammdaten_" + trafoId, updated);

      showToast("success", "Kalibrierung abgeschlossen",
        `R² = ${(calib.r2 * 100).toFixed(0)} % · ${calib.n} Messpunkte ausgewertet.`);

      // Prognose mit gelerntem Modell neu rechnen
      await this.runForecast(container);
    } catch (e) {
      showToast("error", "Kalibrierungsfehler", e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("btn-loading"); }
    }
  },

  renderResult(container, result, params) {
    const fc = container.querySelector("#fc-result");
    if (fc) fc.style.display = "";
    container.querySelector("#no-data-fc").style.display = "none";

    // KPIs
    const fc96 = result.forecast.slice(0, 96);
    const maxFc = fc96.length ? Math.max(...fc96).toFixed(1) : "–";
    const avgFc = fc96.length ? (fc96.reduce((a,b)=>a+b,0)/fc96.length).toFixed(1) : "–";
    const rmse  = result.rmse?.toFixed(1) ?? "–";
    const method = METHODS.find(m => m.value === result.method?.toLowerCase())?.label || result.method;

    setTextById(container, "fc-kpi-method",  method || "–");
    setTextById(container, "fc-kpi-maxval",  maxFc + " kVA");
    setTextById(container, "fc-kpi-avgval",  avgFc + " kVA");
    setTextById(container, "fc-kpi-rmse",    rmse + " kVA");

    // Wetterkorrektur-Anzeige
    this.renderWeather(container, result);

    // Chart
    const canvas = container.querySelector("#forecast-chart-canvas");
    if (canvas) this.renderChart(canvas, result);

    // Tabelle
    this.renderTable(container, result);
  },

  renderWeather(container, result) {
    const card = container.querySelector("#fc-weather-card");
    if (!card) return;

    if (!result._corrected || !result._weather) {
      card.style.display = "none";
      return;
    }
    card.style.display = "";

    const w   = result._weather;
    const cfg = result._weatherCfg || {};

    // Spitzenlast Basis vs. wetterkorrigiert
    const basePeak = Math.max(...result.forecast);
    const corrPeak = Math.max(...result._corrected);
    const peakDelta = corrPeak - basePeak;

    // Größte Einzelbeiträge
    const maxWp = Math.max(0, ...result._deltaWp);
    const minPv = Math.min(0, ...result._deltaPv); // negativster PV-Beitrag

    const GEBIET_LABEL = {
      fernwaerme: "Metropol / Fernwärme",
      waermepumpe: "Ländlich / Wärmepumpen",
      pv: "PV-stark",
      gemischt: "Gemischt (WP + PV)",
    };

    setTextById(container, "fc-w-temp",  `${w.tMin.toFixed(1)} … ${w.tMax.toFixed(1)} °C`);
    setTextById(container, "fc-w-ghi",   `${w.ghiMax.toFixed(0)} W/m² max`);
    setTextById(container, "fc-w-cloud", `${w.cloudAvg.toFixed(0)} % Ø`);
    setTextById(container, "fc-w-gebiet", GEBIET_LABEL[cfg.netzgebiet] || "–");

    const sign = peakDelta >= 0 ? "+" : "";
    setTextById(container, "fc-w-peak",
      `${basePeak.toFixed(0)} → ${corrPeak.toFixed(0)} kVA (${sign}${peakDelta.toFixed(0)})`);

    // Modus-Anzeige (Stufe 1 Heuristik vs. Stufe 2 kalibriert)
    const calib = cfg.calib;
    const modeBadge = container.querySelector("#fc-w-mode");
    if (modeBadge) {
      if (result._corrMode === "calibrated" && calib) {
        modeBadge.textContent = `Kalibriert · R² ${(calib.r2 * 100).toFixed(0)} %`;
        modeBadge.className = "zone-badge green";
      } else {
        modeBadge.textContent = "Heuristik (Stufe 1)";
        modeBadge.className = "zone-badge yellow";
      }
    }

    const parts = [];
    if (result._corrMode === "calibrated" && calib) {
      // Datenbasiert gelernte Sensitivitäten
      const maxCool = Math.max(0, ...(result._deltaCool || [0]));
      parts.push(`Heizsteigung ${fmtSlope(calib.aHeat)} kVA/°C`);
      if (Math.abs(calib.aCool) > 0.05) parts.push(`Kühlsteigung ${fmtSlope(calib.aCool)} kVA/°C`);
      parts.push(`PV-Sensitivität ${fmtSlope(calib.aPv * 100)} kVA/100·W/m²`);
      parts.push(`gelernt aus ${calib.n} Messpunkten (${calib.tMin}…${calib.tMax} °C)`);
    } else {
      if (cfg.wpAnteil > 0)   parts.push(`WP-Anteil ${cfg.wpAnteil}% · max. Mehrlast +${maxWp.toFixed(0)} kVA`);
      if (cfg.pvLeistung > 0) parts.push(`PV ${cfg.pvLeistung} kWp · max. Entlastung ${minPv.toFixed(0)} kVA`);
      if (!parts.length) parts.push("Keine wetterabhängigen Anteile konfiguriert (Fernwärmegebiet).");
    }
    setTextById(container, "fc-w-detail", parts.join(" · "));
  },

  renderChart(canvas, result) {
    const histTs  = result._histTs  || [];
    const histVal = result._histVal || result.fitted || [];
    const fcTs    = result._fcTs    || [];
    const fcVals  = result.forecast || [];
    const lower   = result.lower    || [];
    const upper   = result.upper    || [];

    // Letzte 96 historische Punkte
    const nHist = Math.min(histVal.length, 96);
    const histSlice = histVal.slice(-nHist);
    const histTsSlice = histTs.slice(-nHist);

    const allLabels = [...histTsSlice, ...fcTs].map(ts => formatSlot(ts));

    const dm = document.documentElement.getAttribute("data-theme") === "dark";

    chartManager.destroy("forecast-chart");
    chartManager.create("forecast-chart", canvas, "line",
      {
        labels: allLabels,
        datasets: [
          {
            label: "Historisch",
            data: [...histSlice, ...Array(fcVals.length).fill(null)],
            borderColor: "#2563eb",
            backgroundColor: "rgba(37,99,235,0.07)",
            borderWidth: 1.5,
            pointRadius: 0,
            fill: true,
          },
          {
            label: result._corrected ? "Prognose (Basis)" : "Prognose",
            data: [...Array(nHist - 1).fill(null), histSlice[nHist - 1], ...fcVals],
            borderColor: "#ea580c",
            backgroundColor: "rgba(234,88,12,0.08)",
            borderWidth: 2,
            borderDash: [4, 3],
            pointRadius: 0,
            fill: false,
          },
          ...(result._corrected ? [{
            label: "Prognose (wetterkorrigiert)",
            data: [...Array(nHist - 1).fill(null), histSlice[nHist - 1], ...result._corrected],
            borderColor: "#16a34a",
            backgroundColor: "rgba(22,163,74,0.08)",
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
          }] : []),
          {
            label: "Konfidenzband oben",
            data: [...Array(nHist).fill(null), ...upper],
            borderColor: "rgba(234,88,12,0.2)",
            backgroundColor: "rgba(234,88,12,0.06)",
            borderWidth: 1,
            pointRadius: 0,
            fill: "+1",
          },
          {
            label: "Konfidenzband unten",
            data: [...Array(nHist).fill(null), ...lower],
            borderColor: "rgba(234,88,12,0.2)",
            backgroundColor: "transparent",
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      {
        yLabel: "kVA",
        yScale: { beginAtZero: true },
        chartOptions: {
          plugins: { legend: { display: true } },
          elements: {
            line: { tension: 0.3 },
            point: { radius: 0, hoverRadius: 4 },
          },
        },
      }
    );
  },

  renderTable(container, result) {
    const tbody = container.querySelector("#fc-table-body");
    if (!tbody) return;
    const fcTs   = result._fcTs   || [];
    const fcVals = result.forecast || [];
    const lower  = result.lower   || [];
    const upper  = result.upper   || [];

    const rows = fcTs.slice(0, 96).map((ts, i) => `
      <tr>
        <td class="mono">${formatTs(ts)}</td>
        <td class="mono right">${fcVals[i]?.toFixed(1) ?? "–"}</td>
        <td class="mono right">${lower[i]?.toFixed(1) ?? "–"}</td>
        <td class="mono right">${upper[i]?.toFixed(1) ?? "–"}</td>
      </tr>`).join("");

    tbody.innerHTML = rows || '<tr><td colspan="4" style="text-align:center">–</td></tr>';
  },
};

function setTextById(container, id, text) {
  const el = container.querySelector(`#${id}`);
  if (el) el.textContent = text;
}

function fmtSlope(v) {
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}`;
}

function formatSlot(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) +
         " " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatTs(ts) {
  return new Date(ts).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function buildHTML() {
  return `
<div class="view-header">
  <div class="view-title">Prognose</div>
  <div class="view-subtitle">Lastprognose für die nächsten 24 Stunden (96 × 15-min-Slots)</div>
</div>

<!-- Station selector (hidden when fleet has only 1 station) -->
<div class="card" id="prognose-station-card" style="display:none;margin-bottom:var(--space-4)">
  <div class="card-body" style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap">
    <svg viewBox="0 0 24 24" style="width:18px;height:18px;flex-shrink:0"><rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="9" width="20" height="6" rx="1"/><rect x="2" y="15" width="20" height="6" rx="1"/></svg>
    <label class="form-label" style="margin:0;white-space:nowrap">Station für Prognose:</label>
    <input class="form-input" id="prognose-station-filter" placeholder="PLZ oder Name filtern…"
           style="max-width:180px;height:32px;font-size:var(--text-sm)">
    <select id="prognose-station-sel" class="form-select" style="max-width:340px;height:32px;font-size:var(--text-sm)"></select>
  </div>
</div>

<div id="no-data-fc" class="alert alert-warning" style="display:none">
  <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  Keine Lastgangdaten vorhanden. Bitte zuerst unter <strong>Lastgangdaten</strong> importieren.
</div>

<div class="param-panel">
  <div class="param-panel-title">
    <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
    Prognose-Parameter
  </div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">Methode</label>
      <select id="fc-method" class="form-select">
        <option value="holtwinters">Holt-Winters (Saison + Trend) — empfohlen</option>
        <option value="holt">Holt (Trend + Level)</option>
        <option value="ses">Einfache Exp. Glättung (SES)</option>
        <option value="ma">Moving Average (MA)</option>
      </select>
    </div>
    <div class="form-group" id="param-row-horizont">
      <label class="form-label">Horizont <span class="form-label-sub">Zeitschritte à 15 min</span></label>
      <select id="fc-horizont" class="form-select">
        <option value="96">96 (1 Tag)</option>
        <option value="192">192 (2 Tage)</option>
        <option value="336">336 (3,5 Tage)</option>
        <option value="672">672 (7 Tage)</option>
      </select>
    </div>
  </div>
  <div class="form-grid">
    <div class="form-group" id="param-row-alpha">
      <label class="form-label">Level α = <span id="fc-alpha-val">0.30</span></label>
      <input type="range" id="fc-alpha" class="form-range" min="0.05" max="0.95" step="0.05" value="0.30">
    </div>
    <div class="form-group" id="param-row-beta">
      <label class="form-label">Trend β = <span id="fc-beta-val">0.10</span></label>
      <input type="range" id="fc-beta" class="form-range" min="0.01" max="0.5" step="0.01" value="0.10">
    </div>
    <div class="form-group" id="param-row-gamma" style="display:none">
      <label class="form-label">Saison γ = <span id="fc-gamma-val">0.20</span></label>
      <input type="range" id="fc-gamma" class="form-range" min="0.01" max="0.8" step="0.01" value="0.20">
    </div>
    <div class="form-group" id="param-row-seasonLen" style="display:none">
      <label class="form-label">Saisonlänge <span class="form-label-sub">Slots</span></label>
      <select id="fc-seasonlen" class="form-select">
        <option value="96">96 (1 Tag = 96 × 15 min)</option>
        <option value="672">672 (1 Woche)</option>
      </select>
    </div>
    <div class="form-group" id="param-row-window" style="display:none">
      <label class="form-label">Fenstergröße <span class="form-label-sub">Slots</span></label>
      <select id="fc-window" class="form-select">
        <option value="96">96 (1 Tag)</option>
        <option value="192">192 (2 Tage)</option>
        <option value="672">672 (1 Woche)</option>
      </select>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:var(--space-4);margin-top:var(--space-2);flex-wrap:wrap">
    <button class="btn btn-primary" id="btn-run-forecast">
      <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Prognose berechnen
    </button>
    <label style="display:flex;align-items:center;gap:var(--space-2);cursor:pointer;font-size:var(--text-sm)">
      <input type="checkbox" id="fc-weather-toggle" checked style="width:16px;height:16px;cursor:pointer">
      <span style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>
        Wetterkorrektur (Open-Meteo)
      </span>
    </label>
  </div>
  <div class="form-hint" style="margin-top:var(--space-2)">
    Berücksichtigt Temperatur (Wärmepumpen-Heizlast) und Solarstrahlung (PV-Einspeisung) auf Basis der
    Netzgebiet-Charakteristik der Station. Konfiguration unter <strong>Stammdaten → Netzgebiet-Charakteristik</strong>.
  </div>
</div>

<div id="fc-result" style="display:none">
  <div class="kpi-grid" style="margin-bottom:var(--space-4)">
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">Methode</div>
      <div style="font-size:var(--text-sm);font-weight:var(--weight-semibold);margin-top:var(--space-1)" id="fc-kpi-method">–</div>
    </div>
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">Prognose-Maximum</div>
      <div class="kpi-value mono" id="fc-kpi-maxval">–</div>
    </div>
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">Prognose-Mittel</div>
      <div class="kpi-value mono" id="fc-kpi-avgval">–</div>
    </div>
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">RMSE (Güte)</div>
      <div class="kpi-value mono" id="fc-kpi-rmse">–</div>
    </div>
  </div>

  <!-- Wetterkorrektur-Infokarte -->
  <div class="card" id="fc-weather-card" style="display:none;margin-bottom:var(--space-4);border-left:3px solid #16a34a">
    <div class="card-header">
      <div>
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;color:#16a34a"><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>
          Wetterkorrektur aktiv
          <span id="fc-w-mode" class="zone-badge yellow" style="font-size:var(--text-xs)">–</span>
        </div>
        <div class="card-subtitle" id="fc-w-detail">–</div>
      </div>
      <button class="btn btn-secondary btn-sm" id="btn-calibrate"
              title="Wettersensitivitäten aus historischem Lastgang + Open-Meteo-Archiv lernen (Stufe 2)">
        <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Wettermodell kalibrieren
      </button>
    </div>
    <div class="card-body">
      <div class="kpi-grid">
        <div class="kpi-tile zone-blue">
          <div class="kpi-label">Gebietstyp</div>
          <div style="font-size:var(--text-sm);font-weight:var(--weight-semibold);margin-top:var(--space-1)" id="fc-w-gebiet">–</div>
        </div>
        <div class="kpi-tile zone-blue">
          <div class="kpi-label">Temperatur (Prognosezeitraum)</div>
          <div class="kpi-value mono" style="font-size:var(--text-lg)" id="fc-w-temp">–</div>
        </div>
        <div class="kpi-tile zone-blue">
          <div class="kpi-label">Solarstrahlung</div>
          <div class="kpi-value mono" style="font-size:var(--text-lg)" id="fc-w-ghi">–</div>
        </div>
        <div class="kpi-tile zone-green">
          <div class="kpi-label">Spitzenlast Basis → korrigiert</div>
          <div class="kpi-value mono" style="font-size:var(--text-lg)" id="fc-w-peak">–</div>
        </div>
      </div>
      <div class="form-hint" style="margin-top:var(--space-2)">
        Bewölkung Ø <span id="fc-w-cloud">–</span> · Modell: Holt-Winters-Basisprognose + physikalische
        Wetterkorrektur (First-Order, transparent parametriert je Station).<br>
        PV-Sensitivität wird auf die vorzeichenbehaftete Netto-Wirkleistung geschätzt
        (berücksichtigt Rückspeisung); Anwendung auf |S| ist eine First-Order-Näherung.
      </div>
    </div>
  </div>

  <div class="chart-card" style="margin-bottom:var(--space-4)">
    <div class="chart-card-header">
      <div class="chart-card-title">Lastprognose (historisch + Vorschau)</div>
    </div>
    <div class="chart-card-body">
      <div class="chart-wrapper" style="height:300px">
        <canvas id="forecast-chart-canvas"></canvas>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-title">Prognosetabelle (nächste 24h / 96 Slots)</div>
    </div>
    <div class="table-wrapper" style="max-height:360px;overflow-y:auto">
      <table>
        <thead><tr>
          <th>Zeitstempel</th>
          <th class="right">Prognose kVA</th>
          <th class="right">Unteres KI</th>
          <th class="right">Oberes KI</th>
        </tr></thead>
        <tbody id="fc-table-body"></tbody>
      </table>
    </div>
  </div>
</div>`;
}
