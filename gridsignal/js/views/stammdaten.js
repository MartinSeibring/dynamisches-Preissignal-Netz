import { getApi } from "../api.js";
import { store, getDemoStammdaten } from "../store.js";
import { showToast } from "../toast.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MUNICH_BBOX  = "48.06,11.36,48.25,11.72";

export default {
  id: "stammdaten",
  label: "Stammdaten",
  icon: "server",

  render(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    container.innerHTML = buildHTML();
    this.bindEvents(container, trafoId);
    this.loadData(container, trafoId);   // pending OSM import is applied inside loadData
  },

  destroy() {},

  bindEvents(container, trafoId) {
    const form    = container.querySelector("#stammdaten-form");
    const saveBtn = container.querySelector("#btn-save-stammdaten");
    const demoBtn = container.querySelector("#btn-demo-stammdaten");

    saveBtn?.addEventListener("click", async () => {
      if (!form.checkValidity()) { form.reportValidity(); return; }
      await this.save(container);
    });

    demoBtn?.addEventListener("click", () => this.fillDemo(container));

    // kVA → kW Echtzeit-Berechnung
    const nenn  = container.querySelector("#f-nennleistung");
    const cosfi = container.querySelector("#f-cosfi");
    const kw    = container.querySelector("#f-nennleistung-kw");
    const updateKw = () => {
      const s  = parseFloat(nenn?.value)  || 0;
      const pf = parseFloat(cosfi?.value) || 0.92;
      if (kw) kw.textContent = (s * pf).toFixed(0) + " kW";
    };
    nenn?.addEventListener("input",  updateKw);
    cosfi?.addEventListener("input", updateKw);

    // OSM-Suche
    container.querySelector("#btn-osm-search")
      ?.addEventListener("click", () => this.searchOsm(container));
  },

  async loadData(container, trafoId) {
    try {
      const api    = getApi();
      const trafos = await api.getStammdaten();
      const trafo  = trafos.find(t => t.id === trafoId) || trafos[0];
      if (trafo) this.fillForm(container, trafo);

      // OSM-Import aus Kartenansicht übernehmen (wird nach loadData angewendet)
      const pending = store.get("osm_pending_import");
      if (pending) {
        store.set("osm_pending_import", null);
        this.fillFromOsmStation(container, pending);
      }
    } catch (e) {
      showToast("error", "Ladefehler", e.message);
    }
  },

  fillForm(container, data) {
    const fields = ["name","nennleistung","spannungOS","spannungUS",
                    "baujahr","standort","schaltgruppe","kurzschlussspannung","kosFi"];
    fields.forEach(f => {
      const el = container.querySelector(`#f-${f.toLowerCase()}`);
      if (el) el.value = data[f] ?? "";
    });

    const kw = container.querySelector("#f-nennleistung-kw");
    if (kw) {
      const s  = parseFloat(data.nennleistung) || 0;
      const pf = parseFloat(data.kosFi)        || 0.92;
      kw.textContent = (s * pf).toFixed(0) + " kW";
    }

    if (data.lat && data.lon) {
      const latEl = container.querySelector("#f-lat");
      const lonEl = container.querySelector("#f-lon");
      if (latEl) latEl.value = data.lat;
      if (lonEl) lonEl.value = data.lon;
      container.querySelector("#fg-koordinaten")?.style.setProperty("display", "");
    }
  },

  fillDemo(container) {
    const demo = getDemoStammdaten()[0];
    this.fillForm(container, demo);
    showToast("info", "Demo-Daten geladen", "Formulare mit Beispieldaten befüllt.");
  },

  async save(container) {
    const btn = container.querySelector("#btn-save-stammdaten");
    btn.classList.add("btn-loading");
    btn.disabled = true;

    try {
      const trafoId = store.get("activeTrafoId", "trafo-1");
      const data = {
        id:                  trafoId,
        name:                container.querySelector("#f-name")?.value?.trim(),
        nennleistung:        parseFloat(container.querySelector("#f-nennleistung")?.value)      || 0,
        spannungOS:          parseFloat(container.querySelector("#f-spannungos")?.value)         || 0,
        spannungUS:          parseFloat(container.querySelector("#f-spannungus")?.value)         || 0,
        baujahr:             parseInt(container.querySelector("#f-baujahr")?.value)              || null,
        standort:            container.querySelector("#f-standort")?.value?.trim(),
        schaltgruppe:        container.querySelector("#f-schaltgruppe")?.value?.trim(),
        kurzschlussspannung: parseFloat(container.querySelector("#f-kurzschlussspannung")?.value) || 0,
        kosFi:               parseFloat(container.querySelector("#f-kosfi")?.value)              || 0.92,
        lat:                 parseFloat(container.querySelector("#f-lat")?.value)                || null,
        lon:                 parseFloat(container.querySelector("#f-lon")?.value)                || null,
      };

      const api = getApi();
      await api.saveStammdaten(data);
      store.set("stammdaten_" + trafoId, data);

      showToast("success", "Gespeichert", `Stammdaten für „${data.name}" erfolgreich gespeichert.`);
      updateTrafoSelector(data.name, trafoId);
    } catch (e) {
      showToast("error", "Speicherfehler", e.message);
    } finally {
      btn.classList.remove("btn-loading");
      btn.disabled = false;
    }
  },

  // ── Overpass / OSM ──────────────────────────────────────────────────────────

  async searchOsm(container) {
    const btn       = container.querySelector("#btn-osm-search");
    const resultsEl = container.querySelector("#osm-results");
    if (!resultsEl) return;

    btn.disabled = true;
    btn.classList.add("btn-loading");
    resultsEl.innerHTML = `<div class="osm-loading">
      <svg viewBox="0 0 24 24" class="spin" style="width:20px;height:20px;animation:spin 1s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      Lade Daten von OpenStreetMap…
    </div>`;

    try {
      const query = `[out:json][timeout:30];
(
  node["power"="substation"](${MUNICH_BBOX});
  way["power"="substation"](${MUNICH_BBOX});
  node["building"="transformer_tower"](${MUNICH_BBOX});
  way["building"="transformer_tower"](${MUNICH_BBOX});
);
out center tags;`;

      const resp = await fetch(OVERPASS_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    "data=" + encodeURIComponent(query),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      const stations = (json.elements || [])
        .map(el => ({
          osmId:    el.id,
          lat:      el.lat ?? el.center?.lat,
          lon:      el.lon ?? el.center?.lon,
          name:     el.tags?.name || el.tags?.ref || "",
          operator: el.tags?.operator || "",
          voltage:  el.tags?.voltage  || "",
          substation: el.tags?.substation || "",
        }))
        .filter(s => s.lat && s.lon);

      this.renderOsmResults(container, stations);
      showToast("success", "OSM geladen", `${stations.length} Stationen im Münchner Stadtgebiet gefunden.`);
    } catch (e) {
      resultsEl.innerHTML = `<div class="alert alert-warning" style="margin-top:var(--space-3)">
        <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Overpass API nicht erreichbar: ${e.message}
      </div>`;
      showToast("error", "OSM-Fehler", e.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("btn-loading");
    }
  },

  renderOsmResults(container, stations) {
    const resultsEl = container.querySelector("#osm-results");
    if (!resultsEl) return;

    if (!stations.length) {
      resultsEl.innerHTML = `<div class="alert alert-warning" style="margin-top:var(--space-3)">Keine Stationen gefunden.</div>`;
      return;
    }

    resultsEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-3);margin:var(--space-3) 0 var(--space-2)">
        <input class="form-input" id="osm-filter" placeholder="Nach Name oder Betreiber filtern…"
               style="max-width:300px;height:32px;font-size:var(--text-sm)">
        <span style="font-size:var(--text-sm);color:var(--color-text-secondary)" id="osm-count">
          ${stations.length} Stationen
        </span>
      </div>
      <div class="table-wrapper" style="max-height:300px;overflow-y:auto">
        <table>
          <thead><tr>
            <th>Name / Ref</th>
            <th>Betreiber</th>
            <th>Spannung</th>
            <th>Typ</th>
            <th class="mono" style="font-size:var(--text-xs)">GPS (lat, lon)</th>
            <th></th>
          </tr></thead>
          <tbody id="osm-tbody"></tbody>
        </table>
      </div>`;

    const renderRows = (filter = "") => {
      const tbody   = container.querySelector("#osm-tbody");
      const countEl = container.querySelector("#osm-count");
      const filtered = filter
        ? stations.filter(s =>
            s.name.toLowerCase().includes(filter) ||
            s.operator.toLowerCase().includes(filter))
        : stations;

      if (countEl) countEl.textContent = `${filtered.length} / ${stations.length} Stationen`;

      tbody.innerHTML = filtered.slice(0, 250).map(s => `
        <tr>
          <td class="mono" style="font-size:var(--text-sm)">${s.name || `<span style="color:var(--color-text-secondary)">–</span>`}</td>
          <td style="font-size:var(--text-sm)">${s.operator || "–"}</td>
          <td class="mono" style="font-size:var(--text-sm)">${formatVoltage(s.voltage)}</td>
          <td style="font-size:var(--text-xs);color:var(--color-text-secondary)">${s.substation || "substation"}</td>
          <td class="mono" style="font-size:var(--text-xs)">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</td>
          <td>
            <button class="btn btn-ghost btn-sm osm-pick" data-osm-id="${s.osmId}"
                    style="white-space:nowrap">Übernehmen</button>
          </td>
        </tr>`).join("");

      tbody.querySelectorAll(".osm-pick").forEach(btn => {
        btn.addEventListener("click", () => {
          const osmId   = parseInt(btn.dataset.osmId);
          const station = stations.find(s => s.osmId === osmId);
          if (station) this.fillFromOsmStation(container, station);
        });
      });
    };

    renderRows();
    container.querySelector("#osm-filter")?.addEventListener("input", e => {
      renderRows(e.target.value.toLowerCase().trim());
    });
  },

  fillFromOsmStation(container, station) {
    // Spannungen aus OSM parsen (Format "10000;400" oder "10000")
    const voltages = (station.voltage || "")
      .split(";")
      .map(v => parseInt(v))
      .filter(v => v > 0 && isFinite(v));
    const vOS = voltages[0] ? voltages[0] / 1000 : null;
    const vUS = voltages.length > 1 ? voltages[voltages.length - 1] / 1000 : null;

    // Name immer übernehmen wenn OSM einen hat (Bug-Fix: keine Leer-Bedingung)
    if (station.name) setVal(container, "#f-name", station.name);

    if (vOS) setVal(container, "#f-spannungos", vOS);
    if (vUS) setVal(container, "#f-spannungus", vUS);

    setVal(container, "#f-lat", station.lat.toFixed(6));
    setVal(container, "#f-lon", station.lon.toFixed(6));

    const fgKoord = container.querySelector("#fg-koordinaten");
    if (fgKoord) fgKoord.style.display = "";

    container.querySelector("#stammdaten-form")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

    showToast("success", "Station übernommen",
      station.name
        ? `„${station.name}" in Formular übertragen.`
        : `Koordinaten (${station.lat.toFixed(4)}, ${station.lon.toFixed(4)}) übernommen.`);
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function setVal(container, selector, value) {
  const el = container.querySelector(selector);
  if (el) el.value = value;
}

function formatVoltage(v) {
  if (!v) return "–";
  const parts = v.split(";").map(x => {
    const n = parseInt(x);
    return n >= 1000 ? (n / 1000) + " kV" : n + " V";
  });
  return parts.join(" / ");
}

function updateTrafoSelector(name, id) {
  const sel = document.getElementById("trafo-selector");
  if (!sel) return;
  const opt = sel.querySelector(`option[value="${id}"]`);
  if (opt) opt.textContent = name;
  else {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = name;
    sel.appendChild(o);
    sel.value = id;
  }
}

function buildHTML() {
  return `
<div class="view-header">
  <div class="view-title">Stammdaten</div>
  <div class="view-subtitle">Technische Kenndaten der Trafostation konfigurieren</div>
</div>

<div class="card">
  <div class="card-header">
    <div>
      <div class="card-title">Trafostation</div>
      <div class="card-subtitle">Alle Felder werden lokal gespeichert und beim Neustart wiederhergestellt</div>
    </div>
    <button class="btn btn-ghost btn-sm" id="btn-demo-stammdaten">
      <svg viewBox="0 0 24 24"><path d="M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10-4.48 10-10 10zm0-9l3-3-3-3v2H8v2h4v2z"/></svg>
      Demo-Daten
    </button>
  </div>
  <div class="card-body">
    <form id="stammdaten-form" novalidate>

      <div class="form-group">
        <label class="form-label" for="f-name">Bezeichnung der Trafostation <span style="color:var(--color-zone-red)">*</span></label>
        <input id="f-name" class="form-input" type="text" placeholder="z.B. Trafostation Mitte" required>
      </div>

      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="f-nennleistung">
            Nennleistung
            <span class="form-label-sub">kVA</span>
          </label>
          <input id="f-nennleistung" class="form-input mono" type="number" min="1" max="10000"
                 placeholder="630" required>
          <div class="form-hint">Entspricht <strong id="f-nennleistung-kw">– kW</strong> bei cos φ</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="f-kosfi">
            Leistungsfaktor cos φ
            <span class="form-label-sub">0.8–1.0</span>
          </label>
          <input id="f-kosfi" class="form-input mono" type="number" min="0.8" max="1.0"
                 step="0.01" value="0.92">
        </div>
      </div>

      <div class="form-grid-3">
        <div class="form-group">
          <label class="form-label" for="f-spannungos">
            Spannung OS
            <span class="form-label-sub">kV</span>
          </label>
          <input id="f-spannungos" class="form-input mono" type="number" placeholder="10">
        </div>
        <div class="form-group">
          <label class="form-label" for="f-spannungus">
            Spannung US
            <span class="form-label-sub">kV</span>
          </label>
          <input id="f-spannungus" class="form-input mono" type="number" step="0.001" placeholder="0.4">
        </div>
        <div class="form-group">
          <label class="form-label" for="f-kurzschlussspannung">
            Kurzschlusssp. u<sub>k</sub>
            <span class="form-label-sub">%</span>
          </label>
          <input id="f-kurzschlussspannung" class="form-input mono" type="number"
                 step="0.1" placeholder="4.0">
        </div>
      </div>

      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="f-schaltgruppe">Schaltgruppe</label>
          <select id="f-schaltgruppe" class="form-select">
            <option value="">– auswählen –</option>
            <option value="Dyn5">Dyn5</option>
            <option value="Dyn11">Dyn11</option>
            <option value="YNyn0">YNyn0</option>
            <option value="YNyn11">YNyn11</option>
            <option value="Yzn5">Yzn5</option>
            <option value="Yzn11">Yzn11</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="f-baujahr">Baujahr</label>
          <input id="f-baujahr" class="form-input mono" type="number"
                 min="1950" max="2030" placeholder="2008">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="f-standort">Standortadresse</label>
        <input id="f-standort" class="form-input" type="text"
               placeholder="Straße, PLZ Ort">
      </div>

      <div class="form-group" id="fg-koordinaten" style="display:none">
        <label class="form-label">GPS-Koordinaten
          <span class="form-label-sub">aus OpenStreetMap</span>
        </label>
        <div style="display:flex;gap:var(--space-3)">
          <input id="f-lat" class="form-input mono" type="text" readonly
                 placeholder="48.1351" style="background:var(--color-surface-alt)">
          <input id="f-lon" class="form-input mono" type="text" readonly
                 placeholder="11.5820" style="background:var(--color-surface-alt)">
        </div>
        <div class="form-hint">Automatisch aus OSM übernommen · wird mit Stammdaten gespeichert</div>
      </div>

    </form>
  </div>
  <div class="card-footer">
    <button class="btn btn-secondary" onclick="window.location.reload()">Zurücksetzen</button>
    <button class="btn btn-primary" id="btn-save-stammdaten">
      <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      Stammdaten speichern
    </button>
  </div>
</div>

<div class="card" style="margin-top: var(--space-4)">
  <div class="card-header">
    <div class="card-title">Berechnete Grenzwerte</div>
  </div>
  <div class="card-body">
    <div class="kpi-grid" id="stammdaten-kpi">
      <div class="kpi-tile zone-green">
        <div class="kpi-label">Nennleistung</div>
        <div class="kpi-value" id="kpi-nenn">–<span class="kpi-unit">kVA</span></div>
      </div>
      <div class="kpi-tile zone-yellow">
        <div class="kpi-label">Auslastung 60 % (Gelb)</div>
        <div class="kpi-value" id="kpi-60">–<span class="kpi-unit">kVA</span></div>
      </div>
      <div class="kpi-tile zone-orange">
        <div class="kpi-label">Auslastung 80 % (Orange)</div>
        <div class="kpi-value" id="kpi-80">–<span class="kpi-unit">kVA</span></div>
      </div>
      <div class="kpi-tile zone-red">
        <div class="kpi-label">Auslastung 90 % (Rot)</div>
        <div class="kpi-value" id="kpi-90">–<span class="kpi-unit">kVA</span></div>
      </div>
    </div>
  </div>
</div>

<div class="card" style="margin-top: var(--space-4)" id="osm-card">
  <div class="card-header">
    <div>
      <div class="card-title">Stationen aus OpenStreetMap laden</div>
      <div class="card-subtitle">Trafostationen im Münchner Stadtgebiet aus OSM-Daten importieren</div>
    </div>
    <button class="btn btn-secondary btn-sm" id="btn-osm-search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      OSM-Stationen laden
    </button>
  </div>
  <div class="card-body">
    <div class="alert alert-info">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div>
        Daten aus <strong>OpenStreetMap</strong> via Overpass API (Bounding Box München).
        Abdeckung ca. 5–15 % der ~5.000 SWM-Stationen — überwiegend sichtbare Trafohäuschen und Outdoor-Kioske.
        Klick auf <strong>Übernehmen</strong> füllt Spannung und GPS-Koordinaten ins Formular.
      </div>
    </div>
    <div id="osm-results"></div>
  </div>
</div>

<style>
.osm-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>`;
}
