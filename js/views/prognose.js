import { getApi } from "../api.js";
import { store } from "../store.js";
import { chartManager } from "../charts.js";
import { forecast } from "../forecast.js";
import { showToast } from "../toast.js";

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

  bindEvents(container) {
    const methodSel = container.querySelector("#fc-method");
    methodSel?.addEventListener("change", () => this.toggleParams(container));

    container.querySelector("#btn-run-forecast")
      ?.addEventListener("click", () => this.runForecast(container));

    // Dynamische Range-Labels
    ["alpha","beta","gamma"].forEach(p => {
      const input = container.querySelector(`#fc-${p}`);
      const label = container.querySelector(`#fc-${p}-val`);
      input?.addEventListener("input", () => { if (label) label.textContent = input.value; });
    });
  },

  async load(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
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

      this.renderResult(container, result, params);
    } catch (e) {
      showToast("error", "Prognose-Fehler", e.message);
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

    // Chart
    const canvas = container.querySelector("#forecast-chart-canvas");
    if (canvas) this.renderChart(canvas, result);

    // Tabelle
    this.renderTable(container, result);
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
            label: "Prognose",
            data: [...Array(nHist - 1).fill(null), histSlice[nHist - 1], ...fcVals],
            borderColor: "#ea580c",
            backgroundColor: "rgba(234,88,12,0.08)",
            borderWidth: 2,
            borderDash: [4, 3],
            pointRadius: 0,
            fill: false,
          },
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
  <div style="display:flex;gap:var(--space-3);margin-top:var(--space-2)">
    <button class="btn btn-primary" id="btn-run-forecast">
      <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Prognose berechnen
    </button>
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
