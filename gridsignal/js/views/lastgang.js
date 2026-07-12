import { getApi, parseCsv } from "../api.js?v=20260712";
import { store, generateDemoData } from "../store.js?v=20260712";
import { showToast } from "../toast.js?v=20260712";

export default {
  id: "lastgang",
  label: "Lastgangdaten",
  icon: "upload",

  render(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    container.innerHTML = buildHTML();
    this.bindEvents(container, trafoId);
    this.updateStats(container, trafoId);
  },

  destroy() {},

  bindEvents(container, trafoId) {
    const dropZone  = container.querySelector("#drop-zone");
    const fileInput = container.querySelector("#csv-file-input");
    const demoBtn   = container.querySelector("#btn-demo-data");
    const clearBtn  = container.querySelector("#btn-clear-data");

    // Drag & Drop
    dropZone?.addEventListener("dragover", e => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone?.addEventListener("drop", async e => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) await this.processFile(container, trafoId, file);
    });
    dropZone?.addEventListener("click", () => fileInput?.click());

    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (file) await this.processFile(container, trafoId, file);
      fileInput.value = "";
    });

    demoBtn?.addEventListener("click", async () => {
      await this.loadDemoData(container, trafoId);
    });

    clearBtn?.addEventListener("click", async () => {
      if (!confirm("Alle Lastgangdaten löschen?")) return;
      await getApi().saveLastgangLocal(trafoId, []);
      store.set("lastgang_loaded", false);
      this.updateStats(container, trafoId);
      const preview = container.querySelector("#data-preview-wrap");
      if (preview) preview.innerHTML = "";
      showToast("info", "Daten gelöscht", "Lastgangdaten wurden entfernt.");
    });
  },

  async processFile(container, trafoId, file) {
    if (!file.name.endsWith(".csv") && file.type !== "text/csv") {
      showToast("warning", "Falsches Format", "Bitte eine CSV-Datei hochladen.");
      return;
    }
    this.setLoading(container, true);
    try {
      const text = await file.text();
      const entries = parseCsv(text);
      if (!entries.length) throw new Error("Keine gültigen Datenpunkte in der CSV gefunden.");

      const api = getApi();
      await api.uploadLastgang(trafoId, text);
      store.set("lastgang_loaded", true);
      store.set("lastgang_count_" + trafoId, entries.length);

      showToast("success", "Importiert", `${entries.length} Datenpunkte geladen (${file.name}).`);
      this.updateStats(container, trafoId);
      this.renderPreview(container, entries.slice(0, 50));
    } catch (e) {
      showToast("error", "Import-Fehler", e.message);
    } finally {
      this.setLoading(container, false);
    }
  },

  async loadDemoData(container, trafoId) {
    this.setLoading(container, true);
    try {
      const api = getApi();
      const trafos = await api.getStammdaten();
      const trafo = trafos.find(t => t.id === trafoId);
      const nenn = trafo?.nennleistung || 630;

      const entries = generateDemoData(trafoId, nenn, 30, {
        pvLeistung: trafo?.pvLeistung ?? 0,
        netzgebiet: trafo?.netzgebiet ?? "gemischt",
      });
      await api.saveLastgangLocal(trafoId, entries);
      store.set("lastgang_loaded", true);
      store.set("lastgang_count_" + trafoId, entries.length);

      showToast("success", "Demo-Daten geladen", `${entries.length} synthetische Messpunkte (30 Tage, 15-min-Auflösung).`);
      this.updateStats(container, trafoId);
      this.renderPreview(container, entries.slice(0, 50));
    } catch (e) {
      showToast("error", "Fehler", e.message);
    } finally {
      this.setLoading(container, false);
    }
  },

  async updateStats(container, trafoId) {
    try {
      const api  = getApi();
      const data = await api.getLastgang(trafoId);
      const statsEl = container.querySelector("#lastgang-stats");
      const noDataEl = container.querySelector("#no-data-banner");

      if (!data.length) {
        if (statsEl) statsEl.style.display = "none";
        if (noDataEl) noDataEl.style.display = "";
        return;
      }
      if (noDataEl) noDataEl.style.display = "none";
      if (statsEl) statsEl.style.display = "";

      const count  = data.length;
      const from   = data[0].ts;
      const to     = data[data.length - 1].ts;
      const pVals  = data.map(d => d.p).filter(isFinite);
      const maxP   = Math.max(...pVals).toFixed(1);
      const avgP   = (pVals.reduce((a, b) => a + b, 0) / pVals.length).toFixed(1);
      const dur    = daysBetween(from, to);

      container.querySelector("#stat-count")?.textContent   && (container.querySelector("#stat-count").textContent   = count.toLocaleString("de-DE"));
      container.querySelector("#stat-from")?.textContent    && (container.querySelector("#stat-from").textContent    = formatDate(from));
      container.querySelector("#stat-to")?.textContent      && (container.querySelector("#stat-to").textContent      = formatDate(to));
      container.querySelector("#stat-duration")?.textContent && (container.querySelector("#stat-duration").textContent = `${dur} Tage`);
      container.querySelector("#stat-maxp")?.textContent    && (container.querySelector("#stat-maxp").textContent    = maxP + " kW");
      container.querySelector("#stat-avgp")?.textContent    && (container.querySelector("#stat-avgp").textContent    = avgP + " kW");

      // Setze stat-Werte sicher
      setTextById(container, "stat-count",    count.toLocaleString("de-DE"));
      setTextById(container, "stat-from",     formatDate(from));
      setTextById(container, "stat-to",       formatDate(to));
      setTextById(container, "stat-duration", `${dur} Tage`);
      setTextById(container, "stat-maxp",     maxP + " kW");
      setTextById(container, "stat-avgp",     avgP + " kW");

      this.renderPreview(container, data.slice(0, 50));
    } catch (e) {
      console.error("[lastgang] Statistik-Fehler:", e);
    }
  },

  renderPreview(container, entries) {
    const wrap = container.querySelector("#data-preview-wrap");
    if (!wrap || !entries.length) return;
    const rows = entries.map(e => `
      <tr>
        <td class="mono">${formatTs(e.ts)}</td>
        <td class="mono right">${e.p?.toFixed(1) ?? "–"}</td>
        <td class="mono right">${e.q?.toFixed(1) ?? "–"}</td>
        <td class="mono right">${e.s?.toFixed(1) ?? "–"}</td>
      </tr>`).join("");

    wrap.innerHTML = `
      <div class="section-header">
        <div class="section-title">Vorschau (erste 50 Einträge)</div>
      </div>
      <div class="data-preview">
        <table>
          <thead><tr>
            <th>Zeitstempel</th>
            <th class="right">P (kW)</th>
            <th class="right">Q (kVAR)</th>
            <th class="right">S (kVA)</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  setLoading(container, loading) {
    const btn = container.querySelector("#btn-demo-data");
    if (btn) btn.disabled = loading;
    const drop = container.querySelector("#drop-zone");
    if (drop) drop.style.pointerEvents = loading ? "none" : "";
  },
};

function setTextById(container, id, text) {
  const el = container.querySelector(`#${id}`);
  if (el) el.textContent = text;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatTs(ts) {
  return new Date(ts).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function daysBetween(a, b) {
  return Math.round(Math.abs(new Date(b) - new Date(a)) / 864e5);
}

function buildHTML() {
  return `
<div class="view-header">
  <div class="view-title">Lastgangdaten</div>
  <div class="view-subtitle">CSV-Import oder synthetische Demo-Daten für Analyse und Prognose laden</div>
</div>

<div id="no-data-banner" class="alert alert-info" style="display:none">
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
  Noch keine Lastgangdaten vorhanden. Importieren Sie eine CSV-Datei oder laden Sie Demo-Daten.
</div>

<div class="card" style="margin-bottom: var(--space-4)">
  <div class="card-header">
    <div class="card-title">CSV-Import</div>
    <div class="header-right" style="display:flex;gap:var(--space-2)">
      <button class="btn btn-ghost btn-sm" id="btn-clear-data">Daten löschen</button>
      <button class="btn btn-secondary btn-sm" id="btn-demo-data">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 12 14 14"/></svg>
        Demo-Daten laden (30 Tage)
      </button>
    </div>
  </div>
  <div class="card-body">
    <div class="drop-zone" id="drop-zone">
      <input type="file" accept=".csv,text/csv" id="csv-file-input">
      <div class="drop-zone-icon">
        <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </div>
      <div class="drop-zone-title">CSV-Datei hier ablegen oder klicken</div>
      <div class="drop-zone-sub">Unterstützte Spalten: Timestamp/Zeit, P_kW/Wirkleistung, Q_kVAR, S_kVA · Trennzeichen: Semikolon oder Komma</div>
    </div>

    <div class="alert alert-info" style="margin-top:var(--space-4)">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div>
        <strong>CSV-Format:</strong> Die Datei muss eine Kopfzeile enthalten.
        Spaltenname <code>Timestamp</code> (oder <code>Zeit</code>, <code>Datum</code>) ist Pflicht.
        Mindestens eine Leistungsspalte <code>P_kW</code> oder <code>S_kVA</code>.
        Datum-Formate: ISO 8601 oder <code>DD.MM.YYYY HH:MM</code>.
      </div>
    </div>
  </div>
</div>

<div class="card" id="lastgang-stats" style="display:none">
  <div class="card-header">
    <div class="card-title">Datensatz-Übersicht</div>
  </div>
  <div class="card-body">
    <div class="kpi-grid">
      <div class="kpi-tile zone-blue">
        <div class="kpi-label">Messpunkte</div>
        <div class="kpi-value text-mono" id="stat-count">–</div>
      </div>
      <div class="kpi-tile zone-blue">
        <div class="kpi-label">Zeitraum</div>
        <div class="kpi-value" style="font-size:var(--text-lg)" id="stat-duration">–</div>
      </div>
      <div class="kpi-tile zone-green">
        <div class="kpi-label">Spitzenlast</div>
        <div class="kpi-value text-mono" id="stat-maxp">–</div>
      </div>
      <div class="kpi-tile zone-green">
        <div class="kpi-label">Ø Leistung</div>
        <div class="kpi-value text-mono" id="stat-avgp">–</div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-4);font-size:var(--text-sm);color:var(--color-text-secondary);margin-top:var(--space-3)">
      <span>Von: <strong id="stat-from">–</strong></span>
      <span>Bis: <strong id="stat-to">–</strong></span>
    </div>
  </div>
</div>

<div id="data-preview-wrap" style="margin-top:var(--space-4)"></div>`;
}
