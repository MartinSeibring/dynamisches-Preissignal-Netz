/**
 * Chart.js Wrapper — verwaltet alle Chart-Instanzen, Dark-Mode-Styling,
 * einheitliches Styling und Cleanup.
 */

export class ChartManager {
  #charts = new Map();  // id → Chart instance
  #darkMode = false;

  setDarkMode(dark) {
    this.#darkMode = dark;
    Chart.defaults.color = dark ? "#94a3b8" : "#64748b";
    Chart.defaults.borderColor = dark ? "#334155" : "#e2e8f0";
    // Re-render alle Charts
    this.#charts.forEach(c => c.update("none"));
  }

  /** Basisoptionen für alle Charts */
  #baseOptions(opts = {}) {
    const dm = this.#darkMode;
    return {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 400 },
      plugins: {
        legend: {
          display: opts.legend !== false,
          position: "top",
          align: "end",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            font: { family: "'DM Sans', sans-serif", size: 11 },
            color: dm ? "#94a3b8" : "#64748b",
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: dm ? "#1e293b" : "#0f172a",
          titleColor: dm ? "#f1f5f9" : "#ffffff",
          bodyColor: dm ? "#94a3b8" : "#cbd5e1",
          borderColor: dm ? "#334155" : "#1e293b",
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { family: "'DM Sans', sans-serif", size: 12, weight: "600" },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          ...opts.tooltip,
        },
      },
      scales: {
        x: {
          grid: {
            color: dm ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
            drawBorder: false,
          },
          ticks: {
            font: { family: "'DM Sans', sans-serif", size: 11 },
            color: dm ? "#64748b" : "#94a3b8",
            maxRotation: 0,
          },
          border: { display: false },
          ...opts.xScale,
        },
        y: {
          grid: {
            color: dm ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
            drawBorder: false,
          },
          ticks: {
            font: { family: "'JetBrains Mono', monospace", size: 11 },
            color: dm ? "#64748b" : "#94a3b8",
          },
          border: { display: false },
          ...opts.yScale,
        },
        ...opts.extraScales,
      },
    };
  }

  /**
   * Erstellt oder aktualisiert einen Chart.
   * @param {string} id - Eindeutige ID
   * @param {HTMLCanvasElement} canvas
   * @param {string} type - "line" | "bar" | "doughnut" | "scatter"
   * @param {object} data - Chart.js data object
   * @param {object} options - Erweiterungsoptionen
   */
  create(id, canvas, type, data, options = {}) {
    if (this.#charts.has(id)) {
      const existing = this.#charts.get(id);
      existing.data = data;
      existing.update("active");
      return existing;
    }

    const merged = deepMerge(this.#baseOptions(options), options.chartOptions || {});

    const chart = new Chart(canvas, {
      type,
      data,
      options: merged,
    });

    this.#charts.set(id, chart);
    return chart;
  }

  update(id, data, animate = true) {
    const chart = this.#charts.get(id);
    if (!chart) return;
    chart.data = data;
    chart.update(animate ? "active" : "none");
  }

  destroy(id) {
    const chart = this.#charts.get(id);
    if (chart) { chart.destroy(); this.#charts.delete(id); }
  }

  destroyAll() {
    this.#charts.forEach(c => c.destroy());
    this.#charts.clear();
  }

  // ---- Vorgefertigte Chart-Typen ---- //

  /** Liniendiagramm für Lastgang */
  createLoadChart(id, canvas, data, opts = {}) {
    return this.create(id, canvas, "line", data, {
      legend: opts.legend !== false,
      yScale: {
        title: {
          display: true,
          text: opts.yLabel || "kW / kVA",
          font: { family: "'DM Sans', sans-serif", size: 11 },
          color: "#94a3b8",
        },
        beginAtZero: true,
        ...opts.yScale,
      },
      xScale: opts.xScale,
      tooltip: opts.tooltip,
      chartOptions: {
        plugins: {
          legend: { display: opts.legend !== false },
        },
        elements: {
          line: { tension: 0.3, borderWidth: 1.5 },
          point: { radius: 0, hoverRadius: 4 },
        },
        ...opts.chartOptions,
      },
    });
  }

  /** Balkendiagramm */
  createBarChart(id, canvas, data, opts = {}) {
    return this.create(id, canvas, "bar", data, {
      yScale: { beginAtZero: true, ...opts.yScale },
      xScale: opts.xScale,
      chartOptions: {
        plugins: { legend: { display: opts.legend !== false } },
        datasets: { bar: { borderRadius: 3, borderSkipped: "bottom" } },
        ...opts.chartOptions,
      },
    });
  }

  /** Donut-/Gauge-Diagramm für Auslastung */
  createGauge(id, canvas, value, label, color) {
    const remaining = Math.max(0, 100 - value);
    return this.create(id, canvas, "doughnut",
      {
        labels: [label, ""],
        datasets: [{
          data: [value, remaining],
          backgroundColor: [color, this.#darkMode ? "#1e293b" : "#f1f5f9"],
          borderWidth: 0,
          circumference: 220,
          rotation: -110,
        }],
      },
      {
        legend: false,
        chartOptions: {
          cutout: "75%",
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
        },
      }
    );
  }

  /** Preissignal-Balkendiagramm (farbkodiert nach Zone) */
  createSignalChart(id, canvas, signals, opts = {}) {
    const labels = signals.map(s => formatSlotLabel(s.ts));
    const values = signals.map(s => s.price);
    const colors = signals.map(s => zoneColor(s.zone));

    return this.create(id, canvas, "bar",
      {
        labels,
        datasets: [{
          label: opts.label || "Preis (ct/kWh)",
          data: values,
          backgroundColor: colors,
          borderColor: colors.map(c => c + "CC"),
          borderWidth: 0,
          borderRadius: 2,
        }],
      },
      {
        legend: false,
        yScale: {
          beginAtZero: true,
          title: { display: true, text: "ct/kWh", color: "#94a3b8", font: { size: 11 } },
        },
        chartOptions: {
          plugins: {
            tooltip: {
              callbacks: {
                title: (items) => {
                  const s = signals[items[0].dataIndex];
                  return s ? formatDateTime(s.ts) : "";
                },
                label: (item) => {
                  const s = signals[item.dataIndex];
                  return [
                    ` Preis: ${item.raw.toFixed(2)} ct/kWh`,
                    ` Auslastung: ${s?.util?.toFixed(1)}%`,
                    ` Zone: ${zoneLabel(s?.zone)}`,
                  ];
                },
              },
            },
          },
        },
      }
    );
  }
}

export const chartManager = new ChartManager();

// ---- Helpers ---- //

function zoneColor(zone) {
  const map = {
    green:  "#16a34a",
    yellow: "#ca8a04",
    orange: "#ea580c",
    red:    "#dc2626",
  };
  return map[zone] || "#64748b";
}

function zoneLabel(zone) {
  return { green: "Grün", yellow: "Gelb", orange: "Orange", red: "Rot" }[zone] || zone;
}

function formatSlotLabel(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Einfaches tiefen Merge für Optionsobjekte */
function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
