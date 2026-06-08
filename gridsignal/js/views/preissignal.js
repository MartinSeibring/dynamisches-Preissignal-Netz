import { getApi, localCsvDownload } from "../api.js";
import { store } from "../store.js";
import { chartManager } from "../charts.js";
import { priceEngine, DEFAULT_PARAMS } from "../priceSignal.js";
import { showToast } from "../toast.js";

export default {
  id: "preissignal",
  label: "Preissignal",
  icon: "zap",
  _signals: null,

  render(container) {
    container.innerHTML = buildHTML();
    this.bindEvents(container);
    this.load(container);
  },

  destroy() {
    chartManager.destroy("signal-chart");
    chartManager.destroy("signal-daily");
    this._signals = null;
  },

  async renderStationSelector(container) {
    const api    = getApi();
    const trafos = await api.getStammdaten();
    if (trafos.length <= 1) return;

    const card = container.querySelector("#ps-station-card");
    if (card) card.style.display = "";

    const sel    = container.querySelector("#ps-station-sel");
    const filter = container.querySelector("#ps-station-filter");
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
    container.querySelector("#btn-calc-signal")
      ?.addEventListener("click", () => this.calculate(container));

    container.querySelector("#btn-export-csv")
      ?.addEventListener("click", () => this.exportCsv());

    container.querySelector("#btn-export-today")
      ?.addEventListener("click", () => this.exportToday());

    container.querySelector("#btn-export-fleet")
      ?.addEventListener("click", () => this.exportAllStations());

    // Live-Vorschau bei Parameter-Änderung
    const inputs = container.querySelectorAll(".signal-param");
    inputs.forEach(input => {
      input.addEventListener("change", () => this.calculate(container));
    });

    // Tagesselektor
    container.querySelector("#signal-day-select")
      ?.addEventListener("change", () => this.renderDayChart(container));
  },

  async load(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    await this.renderStationSelector(container);
    try {
      const api     = getApi();
      const lastgang = await api.getLastgang(trafoId);
      if (!lastgang.length) {
        container.querySelector("#no-data-ps").style.display = "";
        container.querySelector("#ps-content").style.display = "none";
        return;
      }
      store.set("lastgang_cache_ps_" + trafoId, lastgang);
      await this.calculate(container);
    } catch (e) {
      showToast("error", "Ladefehler", e.message);
    }
  },

  async calculate(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    const api = getApi();
    const trafos = await api.getStammdaten();
    const trafo = trafos.find(t => t.id === trafoId);
    const nenn = trafo?.nennleistung || 630;

    let lastgang = store.get("lastgang_cache_ps_" + trafoId);
    if (!lastgang) {
      lastgang = await api.getLastgang(trafoId);
      store.set("lastgang_cache_ps_" + trafoId, lastgang);
    }
    if (!lastgang?.length) return;

    const params = readParams(container);
    const signals = priceEngine.generate(lastgang, nenn, params);
    this._signals = signals;

    container.querySelector("#no-data-ps").style.display = "none";
    container.querySelector("#ps-content").style.display = "";

    this.renderKpis(container, signals, params);
    this.populateDaySelector(container, signals);
    this.renderDayChart(container);
    this.renderDailySummaryChart(container, signals);
    this.renderTable(container, signals);
  },

  renderKpis(container, signals, params) {
    const utils  = signals.map(s => s.util);
    const prices = signals.map(s => s.price);
    const dist   = priceEngine.zoneDistribution(signals);
    const total  = signals.length || 1;

    setTextById(container, "ps-kpi-avgprice", mean(prices).toFixed(2) + " ct/kWh");
    setTextById(container, "ps-kpi-maxprice", Math.max(...prices).toFixed(2) + " ct/kWh");
    setTextById(container, "ps-kpi-basisct",  params.basisCt.toFixed(2) + " ct/kWh");
    setTextById(container, "ps-kpi-redpct",   ((dist.red / total) * 100).toFixed(1) + "%");

    // Zonen-Balken
    const bar = container.querySelector("#zone-dist-bar");
    if (bar) {
      bar.innerHTML = ["green","yellow","orange","red"].map(z => {
        const pct = ((dist[z] / total) * 100).toFixed(1);
        const colors = { green:"#16a34a", yellow:"#ca8a04", orange:"#ea580c", red:"#dc2626" };
        return `<div title="${z}: ${pct}%" style="width:${pct}%;background:${colors[z]};height:8px;border-radius:4px;min-width:${pct>0?3:0}px"></div>`;
      }).join("");
    }
  },

  populateDaySelector(container, signals) {
    const sel = container.querySelector("#signal-day-select");
    if (!sel) return;
    const days = [...new Set(signals.map(s => s.ts.substring(0, 10)))];
    sel.innerHTML = days.map(d =>
      `<option value="${d}">${new Date(d).toLocaleDateString("de-DE", { weekday:"short", day:"2-digit", month:"2-digit", year:"numeric" })}</option>`
    ).join("");
    // Standard: letzter Tag
    if (days.length) sel.value = days[days.length - 1];
  },

  renderDayChart(container) {
    const sel = container.querySelector("#signal-day-select");
    const day = sel?.value;
    if (!day || !this._signals) return;

    const daySignals = this._signals.filter(s => s.ts.startsWith(day));
    const canvas = container.querySelector("#signal-chart-canvas");
    if (!canvas || !daySignals.length) return;

    chartManager.destroy("signal-chart");
    chartManager.createSignalChart("signal-chart", canvas, daySignals, {
      label: "Preis ct/kWh",
    });
  },

  renderDailySummaryChart(container, signals) {
    const canvas = container.querySelector("#signal-daily-canvas");
    if (!canvas) return;

    const summary = priceEngine.dailySummary(signals);
    const days  = summary.map(d => new Date(d.day).toLocaleDateString("de-DE", { day:"2-digit", month:"2-digit" }));
    const avgs  = summary.map(d => d.avgPrice);
    const maxes = summary.map(d => d.maxPrice);

    chartManager.destroy("signal-daily");
    chartManager.createBarChart("signal-daily", canvas, {
      labels: days,
      datasets: [
        {
          label: "Ø Tagespreis",
          data: avgs.map(v => round2(v)),
          backgroundColor: "#2563eb88",
          borderColor: "#2563eb",
          borderWidth: 1,
          borderRadius: 2,
        },
        {
          label: "Tagesmaximum",
          data: maxes.map(v => round2(v)),
          backgroundColor: "#dc262655",
          borderColor: "#dc2626",
          borderWidth: 1,
          borderRadius: 2,
        },
      ],
    }, {
      yScale: { title: { display: true, text: "ct/kWh" } },
    });
  },

  renderTable(container, signals) {
    const day = container.querySelector("#signal-day-select")?.value;
    const tbody = container.querySelector("#signal-tbody");
    if (!tbody) return;

    const daySignals = day
      ? signals.filter(s => s.ts.startsWith(day))
      : signals.slice(-96);

    tbody.innerHTML = daySignals.map(s => `
      <tr>
        <td class="mono">${formatTs(s.ts)}</td>
        <td class="mono right">${s.util.toFixed(1)}</td>
        <td>${zoneBadge(s.zone)}</td>
        <td class="mono right">${s.price.toFixed(2)}</td>
        <td class="mono right">${s.s?.toFixed(0) ?? "–"}</td>
      </tr>`).join("");
  },

  exportCsv() {
    if (!this._signals?.length) { showToast("warning", "Keine Daten", "Zuerst Signale berechnen."); return; }
    const csv = priceEngine.toCsvString(this._signals);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `preissignal_${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("success", "Export", "CSV-Datei wird heruntergeladen.");
  },

  exportToday() {
    if (!this._signals?.length) { showToast("warning", "Keine Daten", "Zuerst Signale berechnen."); return; }
    const todayStr = new Date().toISOString().substring(0, 10);
    const todaySignals = this._signals.filter(s => s.ts.startsWith(todayStr));
    if (!todaySignals.length) {
      showToast("warning", "Keine Daten", "Keine Signale für heute vorhanden.");
      return;
    }
    const csv = priceEngine.toCsvString(todaySignals);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `preissignal_heute_${todayStr}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("success", "Export", "Tagessignal exportiert.");
  },

  async exportAllStations() {
    const api    = getApi();
    const trafos = await api.getStammdaten();
    if (!trafos.length) { showToast("warning", "Keine Stationen", "Keine Stationen in der Flotte."); return; }

    const params = DEFAULT_PARAMS; // Use default params for fleet export
    const rows   = [];
    let processed = 0;

    for (const trafo of trafos) {
      const lg = await api.getLastgang(trafo.id);
      if (!lg.length) continue;
      const signals = priceEngine.generate(lg, trafo.nennleistung || 630, params);
      for (const s of signals) {
        rows.push({
          station:  trafo.name || trafo.id,
          plz:      trafo.plz  || "",
          ts:       s.ts,
          util:     s.util.toFixed(1),
          zone:     s.zone,
          price:    s.price.toFixed(2),
          s_kva:    s.s?.toFixed(0) ?? "",
        });
      }
      processed++;
    }

    if (!rows.length) { showToast("warning", "Keine Daten", "Keine Lastgangdaten in der Flotte."); return; }

    const header = Object.keys(rows[0]).join(";");
    const body   = rows.map(r => Object.values(r).join(";")).join("\n");
    const csv    = `﻿${header}\n${body}`;
    const blob   = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href = url;
    a.download = `preissignal_flotte_${new Date().toISOString().substring(0,10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("success", "Flotten-Export", `${processed} Station${processed !== 1 ? "en" : ""} exportiert.`);
  },
};

function readParams(container) {
  return {
    basisCt:        parseFloat(container.querySelector("#ps-basis")?.value)        || DEFAULT_PARAMS.basisCt,
    schwelleGelb:   parseFloat(container.querySelector("#ps-schwelle-gelb")?.value) || DEFAULT_PARAMS.schwelleGelb,
    schwelleOrange: parseFloat(container.querySelector("#ps-schwelle-orange")?.value)|| DEFAULT_PARAMS.schwelleOrange,
    schwelleRot:    parseFloat(container.querySelector("#ps-schwelle-rot")?.value)  || DEFAULT_PARAMS.schwelleRot,
    multGelb:       parseFloat(container.querySelector("#ps-mult-gelb")?.value)     || DEFAULT_PARAMS.multGelb,
    multOrange:     parseFloat(container.querySelector("#ps-mult-orange")?.value)   || DEFAULT_PARAMS.multOrange,
    multRot:        parseFloat(container.querySelector("#ps-mult-rot")?.value)      || DEFAULT_PARAMS.multRot,
    modell:         container.querySelector("#ps-modell")?.value                    || DEFAULT_PARAMS.modell,
    minCt:          parseFloat(container.querySelector("#ps-min-ct")?.value)        || DEFAULT_PARAMS.minCt,
    maxCt:          parseFloat(container.querySelector("#ps-max-ct")?.value)        || DEFAULT_PARAMS.maxCt,
  };
}

function setTextById(container, id, text) {
  const el = container.querySelector(`#${id}`);
  if (el) el.textContent = text;
}

function formatTs(ts) {
  return new Date(ts).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function zoneBadge(zone) {
  const labels = { green: "Grün", yellow: "Gelb", orange: "Orange", red: "Rot" };
  return `<span class="zone-badge ${zone}">${labels[zone] || zone}</span>`;
}

function mean(arr) {
  const v = arr.filter(isFinite);
  return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
}

function round2(v) { return Math.round(v * 100) / 100; }

function today() { return new Date().toISOString().substring(0, 10); }

function buildHTML() {
  const d = DEFAULT_PARAMS;
  return `
<div class="view-header">
  <div class="view-title">Preissignal</div>
  <div class="view-subtitle">Dynamische Netzentgelte auf Basis der Trafo-Auslastung</div>
</div>

<!-- Station selector (hidden when fleet has only 1 station) -->
<div class="card" id="ps-station-card" style="display:none;margin-bottom:var(--space-4)">
  <div class="card-body" style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap">
    <svg viewBox="0 0 24 24" style="width:18px;height:18px;flex-shrink:0"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    <label class="form-label" style="margin:0;white-space:nowrap">Station:</label>
    <input class="form-input" id="ps-station-filter" placeholder="PLZ oder Name filtern…"
           style="max-width:180px;height:32px;font-size:var(--text-sm)">
    <select id="ps-station-sel" class="form-select" style="max-width:340px;height:32px;font-size:var(--text-sm)"></select>
  </div>
</div>

<div id="no-data-ps" class="alert alert-warning" style="display:none">
  <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  Keine Lastgangdaten vorhanden. Bitte zuerst unter <strong>Lastgangdaten</strong> importieren.
</div>

<div class="param-panel">
  <div class="param-panel-title">
    <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    Preissignal-Parameter
  </div>
  <div class="form-grid">
    <div class="form-group">
      <label class="form-label">Basis-Netzentgelt <span class="form-label-sub">ct/kWh</span></label>
      <input id="ps-basis" type="number" class="form-input mono signal-param" min="1" max="100" step="0.5" value="${d.basisCt}">
    </div>
    <div class="form-group">
      <label class="form-label">Preismodell</label>
      <select id="ps-modell" class="form-select signal-param">
        <option value="step">Stufen (step)</option>
        <option value="linear">Linear (interpoliert)</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Min. Preis <span class="form-label-sub">ct/kWh</span></label>
      <input id="ps-min-ct" type="number" class="form-input mono signal-param" min="0" step="0.5" value="${d.minCt}">
    </div>
    <div class="form-group">
      <label class="form-label">Max. Preis <span class="form-label-sub">ct/kWh</span></label>
      <input id="ps-max-ct" type="number" class="form-input mono signal-param" min="1" step="1" value="${d.maxCt}">
    </div>
  </div>

  <div style="margin-bottom:var(--space-4)">
    <div class="section-title" style="font-size:var(--text-sm);margin-bottom:var(--space-3)">Auslastungs-Schwellen und Preis-Multiplikatoren</div>
    <div class="zone-grid-3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-4)">
      <div style="border-left:3px solid var(--color-zone-yellow);padding-left:var(--space-3)">
        <div class="form-label" style="color:var(--color-zone-yellow)">Zone Gelb</div>
        <div class="form-grid" style="margin-top:var(--space-2)">
          <div class="form-group">
            <label class="form-label">Schwelle %</label>
            <input id="ps-schwelle-gelb" type="number" class="form-input mono signal-param" min="50" max="90" value="${d.schwelleGelb}">
          </div>
          <div class="form-group">
            <label class="form-label">Faktor ×</label>
            <input id="ps-mult-gelb" type="number" class="form-input mono signal-param" min="1" max="10" step="0.1" value="${d.multGelb}">
          </div>
        </div>
      </div>
      <div style="border-left:3px solid var(--color-zone-orange);padding-left:var(--space-3)">
        <div class="form-label" style="color:var(--color-zone-orange)">Zone Orange</div>
        <div class="form-grid" style="margin-top:var(--space-2)">
          <div class="form-group">
            <label class="form-label">Schwelle %</label>
            <input id="ps-schwelle-orange" type="number" class="form-input mono signal-param" min="60" max="95" value="${d.schwelleOrange}">
          </div>
          <div class="form-group">
            <label class="form-label">Faktor ×</label>
            <input id="ps-mult-orange" type="number" class="form-input mono signal-param" min="1" max="20" step="0.1" value="${d.multOrange}">
          </div>
        </div>
      </div>
      <div style="border-left:3px solid var(--color-zone-red);padding-left:var(--space-3)">
        <div class="form-label" style="color:var(--color-zone-red)">Zone Rot</div>
        <div class="form-grid" style="margin-top:var(--space-2)">
          <div class="form-group">
            <label class="form-label">Schwelle %</label>
            <input id="ps-schwelle-rot" type="number" class="form-input mono signal-param" min="70" max="100" value="${d.schwelleRot}">
          </div>
          <div class="form-group">
            <label class="form-label">Faktor ×</label>
            <input id="ps-mult-rot" type="number" class="form-input mono signal-param" min="1" max="30" step="0.1" value="${d.multRot}">
          </div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:var(--space-3);flex-wrap:wrap">
    <button class="btn btn-primary" id="btn-calc-signal">
      <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      Preissignale berechnen
    </button>
    <button class="btn btn-secondary" id="btn-export-csv">
      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Gesamt-Export CSV
    </button>
    <button class="btn btn-secondary" id="btn-export-today">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Heute exportieren
    </button>
    <button class="btn btn-ghost" id="btn-export-fleet">
      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Alle Stationen exportieren
    </button>
  </div>
</div>

<div id="ps-content" style="display:none">
  <div class="kpi-grid" style="margin-bottom:var(--space-4)">
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">Ø Preis</div>
      <div class="kpi-value mono" id="ps-kpi-avgprice">–</div>
    </div>
    <div class="kpi-tile zone-red">
      <div class="kpi-label">Max. Preis</div>
      <div class="kpi-value mono" id="ps-kpi-maxprice">–</div>
    </div>
    <div class="kpi-tile zone-green">
      <div class="kpi-label">Basis-Entgelt</div>
      <div class="kpi-value mono" id="ps-kpi-basisct">–</div>
    </div>
    <div class="kpi-tile zone-red">
      <div class="kpi-label">Anteil Rot-Zone</div>
      <div class="kpi-value mono" id="ps-kpi-redpct">–</div>
    </div>
  </div>

  <div style="margin-bottom:var(--space-4);background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-4)">
    <div style="font-size:var(--text-xs);color:var(--color-text-secondary);margin-bottom:var(--space-2);font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Zonen-Verteilung Gesamtzeitraum</div>
    <div style="display:flex;gap:2px;border-radius:4px;overflow:hidden;height:8px" id="zone-dist-bar"></div>
    <div class="zone-legend" style="margin-top:var(--space-3)">
      <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-green)"></div>Grün</div>
      <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-yellow)"></div>Gelb</div>
      <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-orange)"></div>Orange</div>
      <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-red)"></div>Rot</div>
    </div>
  </div>

  <div class="chart-card" style="margin-bottom:var(--space-4)">
    <div class="chart-card-header">
      <div class="chart-card-title">Preissignal-Verlauf (Tagesansicht)</div>
      <div class="chart-card-actions">
        <select id="signal-day-select" class="form-select" style="height:30px;font-size:var(--text-xs)"></select>
      </div>
    </div>
    <div class="chart-card-body">
      <div class="chart-wrapper" style="height:260px">
        <canvas id="signal-chart-canvas"></canvas>
      </div>
    </div>
  </div>

  <div class="chart-card" style="margin-bottom:var(--space-4)">
    <div class="chart-card-header">
      <div class="chart-card-title">Ø Tagespreis und Tagesmaximum</div>
    </div>
    <div class="chart-card-body">
      <div class="chart-wrapper" style="height:220px">
        <canvas id="signal-daily-canvas"></canvas>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-title">Preissignaltabelle (ausgewählter Tag)</div>
    </div>
    <div class="table-wrapper" style="max-height:400px;overflow-y:auto">
      <table>
        <thead><tr>
          <th>Zeitstempel</th>
          <th class="right">Auslastung %</th>
          <th>Zone</th>
          <th class="right">Preis ct/kWh</th>
          <th class="right">S kVA</th>
        </tr></thead>
        <tbody id="signal-tbody"></tbody>
      </table>
    </div>
  </div>
</div>`;
}
