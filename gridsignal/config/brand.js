/**
 * WHITE-LABEL KONFIGURATION
 * Diese Datei ist die einzige Datei, die ein White-Label-Kunde anpassen muss.
 * Alle Farben, Texte, API-Endpunkte und Feature-Flags werden hier konfiguriert.
 */

export const BRAND = {
  // Identität
  productName: "GridSignal",
  productTagline: "Netzauslastung & Preissignale",
  productVersion: "1.0.0",
  logoUrl: null,              // null = Text-Logo, sonst Pfad zu PNG/SVG
  faviconUrl: null,
  poweredBy: true,            // false = "Powered by"-Zeile ausblenden

  // Farben (werden als CSS Custom Properties gesetzt)
  colors: {
    primary:        "#2563eb",
    primaryHover:   "#1d4ed8",
    primaryLight:   "#eff6ff",
    sidebar:        "#0f172a",
    sidebarText:    "#94a3b8",
    sidebarActive:  "#ffffff",
    surface:        "#ffffff",
    background:     "#f1f5f9",
    border:         "#e2e8f0",
    textPrimary:    "#0f172a",
    textSecondary:  "#64748b",
    // Auslastungs-Zonen
    zoneGreen:      "#16a34a",
    zoneYellow:     "#ca8a04",
    zoneOrange:     "#ea580c",
    zoneRed:        "#dc2626",
  },

  // Dark-Mode-Farben
  colorsDark: {
    primary:        "#3b82f6",
    primaryHover:   "#2563eb",
    primaryLight:   "#1e3a5f",
    sidebar:        "#020617",
    sidebarText:    "#64748b",
    sidebarActive:  "#f1f5f9",
    surface:        "#1e293b",
    background:     "#0f172a",
    border:         "#334155",
    textPrimary:    "#f1f5f9",
    textSecondary:  "#94a3b8",
    zoneGreen:      "#16a34a",
    zoneYellow:     "#ca8a04",
    zoneOrange:     "#ea580c",
    zoneRed:        "#dc2626",
  },

  // Typografie
  fonts: {
    displayUrl: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
    displayFamily: "'DM Sans', sans-serif",
    monoUrl: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap",
    monoFamily: "'JetBrains Mono', monospace",
  },

  // Backend
  api: {
    baseUrl: null,
    authType: "bearer",         // "bearer" | "apikey" | "none"
    authHeader: "Authorization",
    defaultHeaders: {},
    timeout: 10000,
  },

  // Funktionsschalter
  features: {
    csvUpload: true,
    demoData: true,
    exportCsv: true,
    backendSync: false,
    multiTrafo: false,
    darkMode: true,
  },

  // Texte / i18n
  i18n: {
    locale: "de-DE",
    currency: "EUR",
    unitPower: "kW",
    unitApparent: "kVA",
    unitReactive: "kVAR",
    unitPrice: "ct/kWh",
    unitPercent: "%",
    nav: {
      stammdaten:  "Stammdaten",
      lastgang:    "Lastgangdaten",
      auslastung:  "Auslastung",
      prognose:    "Prognose",
      preissignal: "Preissignal",
    },
    status: {
      online:  "Backend verbunden",
      offline: "Offline-Modus",
    },
  },
};

/**
 * Wendet die Brand-Konfiguration auf das DOM an.
 * Setzt CSS Custom Properties und lädt Webfonts.
 */
export function applyBrand(brand, darkMode = false) {
  const root = document.documentElement;
  const colors = darkMode ? brand.colorsDark : brand.colors;

  const colorMap = {
    primary:        "--color-primary",
    primaryHover:   "--color-primary-hover",
    primaryLight:   "--color-primary-light",
    sidebar:        "--color-sidebar",
    sidebarText:    "--color-sidebar-text",
    sidebarActive:  "--color-sidebar-active",
    surface:        "--color-surface",
    background:     "--color-background",
    border:         "--color-border",
    textPrimary:    "--color-text-primary",
    textSecondary:  "--color-text-secondary",
    zoneGreen:      "--color-zone-green",
    zoneYellow:     "--color-zone-yellow",
    zoneOrange:     "--color-zone-orange",
    zoneRed:        "--color-zone-red",
  };

  Object.entries(colorMap).forEach(([key, prop]) => {
    if (colors[key]) root.style.setProperty(prop, colors[key]);
  });

  root.style.setProperty("--font-display", brand.fonts.displayFamily);
  root.style.setProperty("--font-mono",    brand.fonts.monoFamily);

  if (darkMode) {
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-theme");
  }
}

/**
 * Lädt Google Fonts dynamisch.
 */
export function loadFonts(brand) {
  [brand.fonts.displayUrl, brand.fonts.monoUrl].forEach(url => {
    if (!url) return;
    if (document.querySelector(`link[href="${url}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  });
}
