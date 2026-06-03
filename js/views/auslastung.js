import { getApi } from "../api.js";
import { store } from "../store.js";
import { chartManager } from "../charts.js";
import { showToast } from "../toast.js";
import { priceEngine, DEFAULT_PARAMS } from "../priceSignal.js";

export default {
  id: "auslastung",
  label: "Auslastung",
  icon: "gauge",

  render(container) {
    container.innerHTML = buildHTML();
    this.load(container);
  },

  destroy() {
    chartManager.destroy("load-line");
    chartManager.destroy("hourly-bar");
    chartManager.destroy("zone-doughnut");
    chartManager.destroy("daily-max");
  },

  async load(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    try {
      const api = getApi();
      const [trafos, lastgang] = await Promise.all([
        api.getStammdaten(),
        api.getLastgang(trafoId),
      ]);
      const trafo = trafos.find(t => t.id === trafoId);
      const nenn  = trafo?.nennleistung || 630;

      if (!lastgang.length) {
        container.querySelector("#no-data-msg").style.display = "";
        container.querySelector("#auslastung-content").style.display = "none";
        return;
      }

      const signals = priceEngine.generate(lastgang, nenn, DEFAULT_PARAMS);
      this.renderKpis(container, signals, nenn);
      this.renderLoadChart(container, lastgang, nenn, signals);
      this.renderHourlyChart(container, lastgang, nenn);
      this.renderZoneChart(container, signals);
      this.renderDailyMaxChart(container, signals, nenn);
      this.renderStatsTable(container, signals, nenn);
    } catch (e) {
      showToast("error", "Ladefehler", e.message);
    }
  },

  renderKpis(container, signals, nenn) {
    const utils = signals.map(s => s.util).filter(isFinite);
    const powers = signals.map(s => s.s).filter(isFinite);

    const maxUtil = Math.max(...utils);
    const avgUtil = mean(utils);
    const peakKva = Math.max(...powers);
    const hoursRed = signals.filter(s => s.zone === "red").length * 0.25;

    const zone = (u) => u >= 90 ? "zone-red" : u >= 80 ? "zone-orange" : u >= 60 ? "zone-yellow" : "zone-green";

    setKpi(container, "kpi-maxutil",  maxUtil.toFixed(1), "%",    zone(maxUtil));
    setKpi(container, "kpi-avgutil",  avgUtil.toFixed(1), "%",    zone(avgUtil));
    setKpi(container, "kpi-peakkva",  peakKva.toFixed(0), "kVA",  "zone-blue");
    setKpi(container, "kpi-redhours", hoursRed.toFixed(1), "h",   hoursRed > 0 ? "zone-red" : "zone-green");
  },

  renderLoadChart(container, lastgang, nenn, signals) {
    const canvas = container.querySelector("#chart-load");
    if (!canvas) return;

    // Dezimiere auf max 672 Punkte (7 Tage × 96)
    const step = Math.max(1, Math.floor(lastgang.length / 672));
    const dec = lastgang.filter((_, i) => i % step === 0);
    const sig = signals.filter((_, i) => i % step === 0);

    const labels = dec.map(e => formatLabel(e.ts));
    const pData  = dec.map(e => e.s);
    const nennLine = Array(dec.length).fill(nenn);

    chartManager.createLoadChart("load-line", canvas, {
      labels,
      datasets: [
        {
          label: "Scheinleistung (kVA)",
          data: pData,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.06)",
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: `Nennleistung ${nenn} kVA`,
          data: nennLine,
          borderColor: "#dc2626",
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    }, {
      yLabel: "kVA",
      yScale: { max: nenn * 1.15 },
      tooltip: {
        callbacks: {
          label: (item) => {
            const s = sig[item.dataIndex];
            const util = s ? ` (${s.util.toFixed(1)}%)` : "";
            return ` ${item.dataset.label}: ${item.raw?.toFixed(1)}${util}`;
          },
        },
      },
    });
  },

  renderHourlyChart(container, lastgang, nenn) {
    const canvas = container.querySelector("#chart-hourly");
    if (!canvas) return;

    // Durchschnittliche Last je Stunde (0..23)
    const hours = Array.from({ length: 24 }, () => []);
    for (const e of lastgang) {
      const h = new Date(e.ts).getHours();
      if (isFinite(e.s)) hours[h].push(e.s);
    }
    const avgByHour = hours.map(vals => vals.length ? mean(vals) : 0);
    const pctByHour = avgByHour.map(v => (v / nenn) * 100);

    chartManager.createBarChart("hourly-bar", canvas, {
      labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
      datasets: [{
        label: "Ø Auslastung %",
        data: pctByHour.map(v => round2(v)),
        backgroundColor: pctByHour.map(v =>
          v >= 90 ? "#dc2626" : v >= 80 ? "#ea580c" : v >= 60 ? "#ca8a04" : "#16a34a"
        ),
        borderWidth: 0,
        borderRadius: 3,
      }],
    }, {
      legend: false,
      yScale: { max: 100, title: { display: true, text: "% Auslastung" } },
    });
  },

  renderZoneChart(container, signals) {
    const canvas = container.querySelector("#chart-zones");
    if (!canvas) return;
    const dist = priceEngine.zoneDistribution(signals);
    const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
    const pct = (v) => round2((v / total) * 100);

    const chart = chartManager.create("zone-doughnut", canvas, "doughnut", {
      labels: ["Grün (< 60%)", "Gelb (60–80%)", "Orange (80–90%)", "Rot (> 90%)"],
      datasets: [{
        data: [pct(dist.green), pct(dist.yellow), pct(dist.orange), pct(dist.red)],
        backgroundColor: ["#16a34a", "#ca8a04", "#ea580c", "#dc2626"],
        borderWidth: 2,
        borderColor: "var(--color-surface)",
      }],
    }, {
      legend: true,
      chartOptions: {
        cutout: "60%",
        plugins: {
          legend: { position: "right" },
          tooltip: {
            callbacks: {
              label: (item) => ` ${item.label}: ${item.raw}%`,
            },
          },
        },
      },
    });

    // Prozent im Zentrum anzeigen
    setTextById(container, "zone-center-text",
      `${pct(dist.green + dist.yellow)}% OK`);
  },

  renderDailyMaxChart(container, signals, nenn) {
    const canvas = container.querySelector("#chart-daily-max");
    if (!canvas) return;

    const byDay = {};
    for (const s of signals) {
      const d = s.ts.substring(0, 10);
      if (!byDay[d] || s.util > byDay[d]) byDay[d] = s.util;
    }
    const days   = Object.keys(byDay).slice(-14);
    const maxPct = days.map(d => byDay[d]);

    chartManager.createBarChart("daily-max", canvas, {
      labels: days.map(d => formatDay(d)),
      datasets: [{
        label: "Tagesmaximum Auslastung %",
        data: maxPct,
        backgroundColor: maxPct.map(v =>
          v >= 90 ? "#dc2626" : v >= 80 ? "#ea580c" : v >= 60 ? "#ca8a04" : "#16a34a"
        ),
        borderWidth: 0,
        borderRadius: 3,
      }],
    }, {
      legend: false,
      yScale: { max: 110, title: { display: true, text: "%" } },
    });
  },

  renderStatsTable(container, signals, nenn) {
    const tbody = container.querySelector("#stats-tbody");
    if (!tbody) return;

    const summary = priceEngine.dailySummary(signals).slice(-7);
    tbody.innerHTML = summary.map(d => `
      <tr>
        <td class="mono">${formatDay(d.day)}</td>
        <td class="mono right">${d.avgUtil.toFixed(1)}</td>
        <td class="mono right">${d.maxUtil.toFixed(1)}</td>
        <td>${zoneBadge(d.maxUtil)}</td>
        <td class="right">${d.zones.green}</td>
        <td class="right text-warning">${d.zones.yellow}</td>
        <td class="right text-danger">${d.zones.orange + d.zones.red}</td>
      </tr>`).join("");
  },
};

// ---- Helpers ---- //
function mean(arr) {
  const v = arr.filter(isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function round2(v) { return Math.round(v * 100) / 100; }

function setKpi(container, id, value, unit, zone) {
  const el = container.querySelector(`#${id}`);
  if (!el) return;
  el.closest(".kpi-tile")?.classList.remove("zone-green","zone-yellow","zone-orange","zone-red","zone-blue");
  el.closest(".kpi-tile")?.classList.add(zone);
  el.innerHTML = `${value}<span class="kpi-unit">${unit}</span>`;
}

function setTextById(container, id, text) {
  const el = container.querySelector(`#${id}`);
  if (el) el.textContent = text;
}

function formatLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) +
         " " + d.getHours().toString().padStart(2, "0") + ":00";
}

function formatDay(ts) {
  return new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function zoneBadge(util) {
  const zone = util >= 90 ? ["red","Rot"] : util >= 80 ? ["orange","Orange"] : util >= 60 ? ["yellow","Gelb"] : ["green","Grün"];
  return `<span class="zone-badge ${zone[0]}">${zone[1]}</span>`;
}

function buildHTML() {
  return `
<div class="view-header">
  <div class="view-title">Auslastung</div>
  <div class="view-subtitle">Trafo-Auslastung analysieren – Spitzenwerte, Zonenzuordnung, Tagesmuster</div>
</div>

<div id="no-data-msg" class="alert alert-warning" style="display:none">
  <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  Keine Lastgangdaten vorhanden. Bitte zuerst unter <strong>Lastgangdaten</strong> importieren oder Demo-Daten laden.
</div>

<div id="auslastung-content">
  <div class="kpi-grid">
    <div class="kpi-tile zone-green">
      <div class="kpi-label">Max. Auslastung</div>
      <div class="kpi-value mono" id="kpi-maxutil">–<span class="kpi-unit">%</span></div>
    </div>
    <div class="kpi-tile zone-green">
      <div class="kpi-label">Ø Auslastung</div>
      <div class="kpi-value mono" id="kpi-avgutil">–<span class="kpi-unit">%</span></div>
    </div>
    <div class="kpi-tile zone-blue">
      <div class="kpi-label">Spitzenlast</div>
      <div class="kpi-value mono" id="kpi-peakkva">–<span class="kpi-unit">kVA</span></div>
    </div>
    <div class="kpi-tile zone-green">
      <div class="kpi-label">Stunden im Rot-Bereich</div>
      <div class="kpi-value mono" id="kpi-redhours">–<span class="kpi-unit">h</span></div>
    </div>
  </div>

  <div class="chart-grid single" style="margin-bottom:var(--space-4)">
    <div class="chart-card">
      <div class="chart-card-header">
        <div class="chart-card-title">Scheinleistung und Nennleistung (Zeitverlauf)</div>
      </div>
      <div class="chart-card-body">
        <div class="chart-wrapper" style="height:260px">
          <canvas id="chart-load"></canvas>
        </div>
      </div>
    </div>
  </div>

  <div class="chart-grid">
    <div class="chart-card">
      <div class="chart-card-header">
        <div class="chart-card-title">Ø Auslastung nach Tagesstunde</div>
      </div>
      <div class="chart-card-body">
        <div class="chart-wrapper" style="height:220px">
          <canvas id="chart-hourly"></canvas>
        </div>
        <div class="zone-legend">
          <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-green)"></div>Grün &lt; 60%</div>
          <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-yellow)"></div>Gelb 60–80%</div>
          <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-orange)"></div>Orange 80–90%</div>
          <div class="zone-legend-item"><div class="zone-legend-swatch" style="background:var(--color-zone-red)"></div>Rot &gt; 90%</div>
        </div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-header">
        <div class="chart-card-title">Zonenverteilung (Gesamtzeitraum)</div>
      </div>
      <div class="chart-card-body" style="position:relative">
        <div class="chart-wrapper" style="height:220px">
          <canvas id="chart-zones"></canvas>
        </div>
      </div>
    </div>
  </div>

  <div class="chart-grid single" style="margin-top:var(--space-4)">
    <div class="chart-card">
      <div class="chart-card-header">
        <div class="chart-card-title">Tagesmaximum Auslastung (letzte 14 Tage)</div>
      </div>
      <div class="chart-card-body">
        <div class="chart-wrapper" style="height:200px">
          <canvas id="chart-daily-max"></canvas>
        </div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:var(--space-4)">
    <div class="card-header"><div class="card-title">Tagesstatistik (letzte 7 Tage)</div></div>
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>Datum</th>
          <th class="right">Ø Auslas. %</th>
          <th class="right">Max. Auslas. %</th>
          <th>Zone Max</th>
          <th class="right">Slots Grün</th>
          <th class="right">Slots Gelb</th>
          <th class="right">Slots ≥ Orange</th>
        </tr></thead>
        <tbody id="stats-tbody">
          <tr><td colspan="7" style="text-align:center;color:var(--color-text-secondary)">Lade…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`;
}
