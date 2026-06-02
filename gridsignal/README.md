# GridSignal

**Netztrafo-Auslastungs- und Preissignal-Tool für Verteilnetzbetreiber**

White-Label-fähig · Vanilla JS · Kein Build-Step · Offline-first

---

## Schnellstart (lokal)

```bash
# Option 1: Node.js (empfohlen)
npx serve gridsignal

# Option 2: Python 3
cd gridsignal && python -m http.server 8080

# Option 3: PHP
cd gridsignal && php -S localhost:8080
```

Dann im Browser: `http://localhost:8080`

> **Wichtig:** Die App muss über HTTP(S) ausgeliefert werden — direkt als `file://` funktionieren ES-Module-Imports nicht.

---

## White-Label-Anleitung

Die **einzige Datei**, die ein White-Label-Kunde anpassen muss:

```
gridsignal/config/brand.js
```

### Schritt 1: Produktname und Logo

```js
export const BRAND = {
  productName:    "MeinNetz Grid",
  productTagline: "Netzauslastung & Preissignale",
  logoUrl:        "./assets/logo.svg",  // null = Text-Logo
  faviconUrl:     "./assets/favicon.ico",
  poweredBy:      false,                // "Powered by"-Zeile ausblenden
```

### Schritt 2: Farben

```js
colors: {
  primary:     "#006B3C",  // Ihre Markenfarbe
  sidebar:     "#1a2e20",  // Dunklere Sidebar-Variante
  // ... alle anderen Farben wie gewünscht
},
```

### Schritt 3: Backend verbinden

```js
api: {
  baseUrl:  "https://api.ihr-netzbetreiber.de/v1",
  authType: "bearer",   // "bearer" | "apikey" | "none"
},
features: {
  backendSync: true,    // Backend-Sync-Button einblenden
},
```

Solange `baseUrl: null`, arbeitet die App komplett mit `localStorage` (Offline-Modus).

---

## Backend-API-Contract

Das vollständige API-Schema ist als Kommentar in `js/api.js` dokumentiert.  
Kurzübersicht der Endpunkte:

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| GET | `/health` | Backend-Status |
| GET | `/trafos` | Alle Trafostationen |
| POST | `/trafos` | Neue Trafostation |
| PUT | `/trafos/:id` | Trafostation aktualisieren |
| GET | `/lastgang?trafoId&from&to` | Lastgangdaten abrufen |
| POST | `/lastgang/upload` | CSV-Upload (multipart/form-data) |
| WS | `/lastgang/live/:trafoId` | Echtzeit-Livestream |
| GET | `/prognose?trafoId&methode&horizont&...` | Prognose (Backend-ML-Modell) |
| GET | `/preissignal?trafoId&...` | Preissignale |
| POST | `/export` | Daten-Export |

### Datenmodell

**Trafostation:**
```json
{
  "id": "trafo-1",
  "name": "Trafostation Mitte",
  "nennleistung": 630,
  "spannungOS": 20,
  "spannungUS": 0.4,
  "baujahr": 2008,
  "standort": "Hauptstraße 42, 12345 Musterstadt",
  "schaltgruppe": "Dyn5",
  "kurzschlussspannung": 4.0,
  "kosFi": 0.92
}
```

**Lastgang-Eintrag:**
```json
{
  "ts": "2026-01-15T08:30:00.000Z",
  "p": 423.5,
  "q": 156.2,
  "s": 449.1
}
```

**Preissignal-Eintrag:**
```json
{
  "ts": "2026-01-15T08:30:00.000Z",
  "util": 71.3,
  "zone": "yellow",
  "price": 37.5,
  "s": 449.1
}
```

---

## CSV-Import-Format

Unterstützte Spaltenbezeichnungen (Groß-/Kleinschreibung egal):

| Spalte | Akzeptierte Namen |
|--------|------------------|
| Zeitstempel | `timestamp`, `ts`, `zeit`, `time`, `datum`, `date`, `datetime` |
| Wirkleistung P | `p_kw`, `p`, `wirkleistung`, `kw`, `power`, `active_power` |
| Blindleistung Q | `q_kvar`, `q`, `blindleistung`, `kvar`, `reactive_power` |
| Scheinleistung S | `s_kva`, `s`, `scheinleistung`, `kva`, `apparent_power` |

**Mindestanforderung:** Zeitstempel-Spalte + mindestens P oder S  
**Trennzeichen:** Semikolon (`;`) oder Komma (`,`)  
**Datumsformat:** ISO 8601 (`2026-01-15T08:30:00Z`) oder `DD.MM.YYYY HH:MM`

**Beispiel:**
```csv
Timestamp;P_kW;Q_kVAR;S_kVA
2026-01-01T00:00:00Z;245.3;89.1;261.0
2026-01-01T00:15:00Z;238.7;85.4;253.5
```

---

## Deployment

### Statisches Hosting (empfohlen)

Die App benötigt **keinen** Application-Server — alle Dateien sind statisch.

**nginx-Konfiguration:**
```nginx
server {
    listen 443 ssl;
    server_name gridsignal.ihr-netzbetreiber.de;

    ssl_certificate     /etc/ssl/certs/ihr-cert.pem;
    ssl_certificate_key /etc/ssl/private/ihr-key.pem;

    root /var/www/gridsignal;
    index index.html;

    # ES Modules benötigen korrekten MIME-Type
    location ~* \.js$ {
        add_header Content-Type "application/javascript; charset=utf-8";
    }

    # SPA-Fallback (alle Routen → index.html)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Content-Security-Policy "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' https://cdn.jsdelivr.net";
}
```

### Docker

```dockerfile
FROM nginx:alpine
COPY gridsignal/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

## Dateistruktur

```
gridsignal/
├── index.html              App-Shell
├── config/
│   └── brand.js            WHITE-LABEL (einzige Datei für Kunden)
├── css/
│   ├── tokens.css          Design Tokens (CSS Custom Properties)
│   ├── layout.css          Shell, Sidebar, Grid
│   └── components.css      Buttons, Cards, Forms, Toasts
├── js/
│   ├── api.js              Backend-Abstraktionsschicht
│   ├── store.js            Zentraler State + Demo-Datengenerator
│   ├── router.js           Tab/View-Navigation
│   ├── charts.js           Chart.js Wrapper
│   ├── forecast.js         Prognosealgorithmen (MA, SES, Holt, Holt-Winters)
│   ├── priceSignal.js      Preissignal-Engine
│   ├── toast.js            Toast-Benachrichtigungen
│   └── views/
│       ├── stammdaten.js   Tab 1: Stammdaten
│       ├── lastgang.js     Tab 2: Lastgangdaten
│       ├── auslastung.js   Tab 3: Auslastungsanalyse
│       ├── prognose.js     Tab 4: Lastprognose
│       └── preissignal.js  Tab 5: Dynamische Preissignale
└── README.md
```

---

## Technologie-Stack

| Komponente | Technologie |
|-----------|-------------|
| Framework | Vanilla JS (ES Modules) — **kein Build-Step** |
| Charts | Chart.js 4.4.1 (CDN) |
| Icons | Inline SVG (Tabler Icons-style) |
| Fonts | DM Sans + JetBrains Mono (Google Fonts CDN) |
| Datenhaltung | localStorage (Offline) / REST-API (Online) |
| Browser-Support | Chrome 80+, Firefox 75+, Safari 14+, Edge 80+ |

---

## Algorithmen

### Lastprognose

| Methode | Beschreibung | Empfehlung |
|---------|-------------|------------|
| **Holt-Winters** | Saison + Trend (Triple ETS) | Standard: Tages- und Wochenmuster |
| **Holt** | Trend + Level (Double ETS) | Wenn keine Saisonalität erkennbar |
| **SES** | Einfache Exp. Glättung | Glatte, trendfreie Reihen |
| **MA** | Moving Average | Einfache Baseline, saisonales Muster |

### Preissignal-Zonen

| Zone | Auslastung | Std.-Faktor | Beschreibung |
|------|-----------|------------|--------------|
| Grün | < 60% | 1,0× | Normalbetrieb |
| Gelb | 60–80% | 1,5× | Erhöhte Auslastung |
| Orange | 80–90% | 2,5× | Kritische Auslastung |
| Rot | > 90% | 4,0× | Überlastrisiko |

Alle Schwellen und Multiplikatoren sind in Tab 5 (Preissignal) konfigurierbar.
