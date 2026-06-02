import { getApi } from "../api.js";
import { store, getDemoStammdaten } from "../store.js";
import { showToast } from "../toast.js";

export default {
  id: "stammdaten",
  label: "Stammdaten",
  icon: "server",

  render(container) {
    const trafoId = store.get("activeTrafoId", "trafo-1");
    container.innerHTML = buildHTML();
    this.#bindEvents(container, trafoId);
    this.#loadData(container, trafoId);
  },

  destroy() {},

  #bindEvents(container, trafoId) {
    const form  = container.querySelector("#stammdaten-form");
    const saveBtn = container.querySelector("#btn-save-stammdaten");
    const demoBtn = container.querySelector("#btn-demo-stammdaten");

    saveBtn?.addEventListener("click", async () => {
      if (!form.checkValidity()) { form.reportValidity(); return; }
      await this.#save(container);
    });

    demoBtn?.addEventListener("click", () => {
      this.#fillDemo(container);
    });

    // Echtzeit-Berechnung kVA→kW
    const nenn = container.querySelector("#f-nennleistung");
    const cosfi = container.querySelector("#f-cosfi");
    const kw = container.querySelector("#f-nennleistung-kw");

    const updateKw = () => {
      const s = parseFloat(nenn?.value) || 0;
      const pf = parseFloat(cosfi?.value) || 0.92;
      if (kw) kw.textContent = (s * pf).toFixed(0) + " kW";
    };

    nenn?.addEventListener("input", updateKw);
    cosfi?.addEventListener("input", updateKw);
  },

  async #loadData(container, trafoId) {
    try {
      const api = getApi();
      const trafos = await api.getStammdaten();
      const trafo = trafos.find(t => t.id === trafoId) || trafos[0];
      if (trafo) this.#fillForm(container, trafo);
    } catch (e) {
      showToast("error", "Ladefehler", e.message);
    }
  },

  #fillForm(container, data) {
    const fields = ["name","nennleistung","spannungOS","spannungUS",
                    "baujahr","standort","schaltgruppe","kurzschlussspannung","kosFi"];
    fields.forEach(f => {
      const el = container.querySelector(`#f-${f.toLowerCase()}`);
      if (el) el.value = data[f] ?? "";
    });
    // KW-Anzeige aktualisieren
    const kw = container.querySelector("#f-nennleistung-kw");
    if (kw) {
      const s = parseFloat(data.nennleistung) || 0;
      const pf = parseFloat(data.kosFi) || 0.92;
      kw.textContent = (s * pf).toFixed(0) + " kW";
    }
  },

  #fillDemo(container) {
    const demo = getDemoStammdaten()[0];
    this.#fillForm(container, demo);
    showToast("info", "Demo-Daten geladen", "Formulare mit Beispieldaten befüllt.");
  },

  async #save(container) {
    const btn = container.querySelector("#btn-save-stammdaten");
    btn.classList.add("btn-loading");
    btn.disabled = true;

    try {
      const trafoId = store.get("activeTrafoId", "trafo-1");
      const data = {
        id:                  trafoId,
        name:                container.querySelector("#f-name")?.value?.trim(),
        nennleistung:        parseFloat(container.querySelector("#f-nennleistung")?.value) || 0,
        spannungOS:          parseFloat(container.querySelector("#f-spannungos")?.value) || 0,
        spannungUS:          parseFloat(container.querySelector("#f-spannungus")?.value) || 0,
        baujahr:             parseInt(container.querySelector("#f-baujahr")?.value) || null,
        standort:            container.querySelector("#f-standort")?.value?.trim(),
        schaltgruppe:        container.querySelector("#f-schaltgruppe")?.value?.trim(),
        kurzschlussspannung: parseFloat(container.querySelector("#f-kurzschlussspannung")?.value) || 0,
        kosFi:               parseFloat(container.querySelector("#f-kosfi")?.value) || 0.92,
      };

      const api = getApi();
      await api.saveStammdaten(data);
      store.set("stammdaten_" + trafoId, data);

      showToast("success", "Gespeichert", `Stammdaten für "${data.name}" erfolgreich gespeichert.`);

      // Trafo-Selector im Header aktualisieren
      updateTrafoSelector(data.name, trafoId);
    } catch (e) {
      showToast("error", "Speicherfehler", e.message);
    } finally {
      btn.classList.remove("btn-loading");
      btn.disabled = false;
    }
  },
};

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
          <input id="f-spannungos" class="form-input mono" type="number" placeholder="20">
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

    </form>
  </div>
  <div class="card-footer">
    <button class="btn btn-secondary" onclick="window.location.reload()">Zurücksetzen</button>
    <button class="btn btn-primary" id="btn-save-stammdaten">
      <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
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
</div>`;
}
