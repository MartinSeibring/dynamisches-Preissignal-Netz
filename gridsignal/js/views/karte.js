import { store } from "../store.js";
import { router } from "../router.js";
import { showToast } from "../toast.js";

const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
const MUNICH_BBOX   = "48.06,11.36,48.25,11.72";
const MUNICH_CENTER = [48.1351, 11.582];

export default {
  id: "karte",
  label: "Karte",
  icon: "map",

  _map: null,
  _markersLayer: null,
  _stations: [],

  render(container) {
    container.innerHTML = buildHTML();
    this.bindEvents(container);
    requestAnimationFrame(() => this.initMap(container));
  },

  destroy() {
    if (this._map) {
      this._map.remove();
      this._map = null;
    }
    this._markersLayer = null;
    this._stations = [];
  },

  initMap(container) {
    const mapEl = container.querySelector("#map-canvas");
    if (!mapEl) return;

    if (!window.L) {
      container.querySelector("#map-error")?.style.setProperty("display", "");
      return;
    }

    this._map = L.map(mapEl, { center: MUNICH_CENTER, zoom: 13 });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(this._map);

    this._markersLayer = L.featureGroup().addTo(this._map);
    this._map.invalidateSize();
  },

  bindEvents(container) {
    container.querySelector("#btn-map-load")
      ?.addEventListener("click", () => this.loadStations(container));
  },

  async loadStations(container) {
    const btn      = container.querySelector("#btn-map-load");
    const statusEl = container.querySelector("#map-status");

    btn.disabled = true;
    btn.classList.add("btn-loading");
    if (statusEl) statusEl.textContent = "Lade Daten von OpenStreetMap…";

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

      this._stations = (json.elements || [])
        .map(el => ({
          osmId:      el.id,
          lat:        el.lat ?? el.center?.lat,
          lon:        el.lon ?? el.center?.lon,
          name:       el.tags?.name || el.tags?.ref || "",
          operator:   el.tags?.operator || "",
          voltage:    el.tags?.voltage  || "",
          substation: el.tags?.substation || "",
        }))
        .filter(s => s.lat && s.lon);

      if (statusEl) statusEl.textContent = `${this._stations.length} Stationen geladen`;
      this.renderMarkers();
      showToast("success", "OSM geladen", `${this._stations.length} Stationen im Stadtgebiet.`);
    } catch (e) {
      if (statusEl) statusEl.textContent = "Fehler beim Laden";
      showToast("error", "Overpass-Fehler", e.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("btn-loading");
    }
  },

  renderMarkers() {
    if (!this._markersLayer || !window.L) return;
    this._markersLayer.clearLayers();

    const activeId = store.get("activeTrafoId", "trafo-1");
    const saved    = store.get("stammdaten_" + activeId);

    for (const s of this._stations) {
      const isAdopted = !!(saved?.lat && saved?.lon &&
        Math.abs(s.lat - saved.lat) < 0.0002 &&
        Math.abs(s.lon - saved.lon) < 0.0002);

      const marker = L.circleMarker([s.lat, s.lon], markerStyle(isAdopted));
      marker.bindPopup(buildPopup(s, isAdopted), { maxWidth: 240 });

      marker.on("popupopen", () => {
        const popupEl = marker.getPopup().getElement();
        popupEl?.querySelector(".osm-adopt-btn")
          ?.addEventListener("click", () => {
            this.adoptStation(s);
            marker.closePopup();
          }, { once: true });
      });

      this._markersLayer.addLayer(marker);
    }
  },

  adoptStation(station) {
    store.set("osm_pending_import", station);
    router.navigate("stammdaten");
    showToast("info", "Stammdaten", "Stationsdaten werden in Formular übertragen…");
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function markerStyle(adopted) {
  return {
    radius:      adopted ? 10 : 7,
    fillColor:   adopted ? "#16a34a" : "#2563eb",
    color:       adopted ? "#14532d" : "#1d4ed8",
    weight:      1.5,
    opacity:     1,
    fillOpacity: adopted ? 0.9 : 0.65,
  };
}

function buildPopup(s, isAdopted) {
  const voltStr = formatVoltage(s.voltage);
  return `
    <div style="font-size:13px;line-height:1.6;min-width:170px">
      <div style="font-weight:600;margin-bottom:2px">
        ${s.name || '<em style="color:#888">Kein Name in OSM</em>'}
      </div>
      ${s.operator ? `<div style="color:#555">Betreiber: ${s.operator}</div>` : ""}
      ${voltStr !== "–" ? `<div style="color:#555">Spannung: ${voltStr}</div>` : ""}
      <div style="color:#888;font-size:11px">${s.substation || "substation"}</div>
      <div style="color:#aaa;font-size:10px">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</div>
      ${isAdopted
        ? `<div style="color:#16a34a;font-weight:600;margin-top:5px">✓ Aktive Station</div>`
        : `<button class="osm-adopt-btn"
             style="margin-top:7px;padding:5px 0;width:100%;background:#2563eb;
                    color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500">
             Übernehmen → Stammdaten
           </button>`
      }
    </div>`;
}

function formatVoltage(v) {
  if (!v) return "–";
  return v.split(";")
    .map(x => { const n = parseInt(x); return n >= 1000 ? (n / 1000) + " kV" : n + " V"; })
    .join(" / ");
}

function buildHTML() {
  return `
<div class="view-header">
  <div class="view-title">Netzstationskarte</div>
  <div class="view-subtitle">Trafostationen im Münchner Stadtgebiet aus OpenStreetMap visualisieren</div>
</div>

<div class="card">
  <div class="card-header">
    <div>
      <div class="card-title">Karte München</div>
      <div class="card-subtitle" id="map-status">Klick auf „OSM-Daten laden" zum Starten</div>
    </div>
    <button class="btn btn-secondary btn-sm" id="btn-map-load">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      OSM-Daten laden
    </button>
  </div>
  <div class="card-body" style="padding:0;position:relative">
    <div id="map-error" class="alert alert-warning"
         style="display:none;margin:var(--space-4)">
      Leaflet.js nicht geladen – bitte Seite neu laden.
    </div>
    <div id="map-canvas"
         style="height:520px;width:100%;border-radius:0 0 var(--radius-lg) var(--radius-lg)">
    </div>
  </div>
</div>

<div class="card" style="margin-top:var(--space-4)">
  <div class="card-body">
    <div class="alert alert-info">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div>
        <strong style="color:#2563eb">●</strong> Blau = Station verfügbar ·
        <strong style="color:#16a34a">●</strong> Grün = Aktive Station (in Stammdaten).<br>
        Klick auf Marker öffnet Popup · „Übernehmen" füllt Stammdaten-Formular automatisch.
        Quelle: OpenStreetMap (Abdeckung ca. 5–15 % der ~5.000 SWM-Stationen).
      </div>
    </div>
  </div>
</div>`;
}
