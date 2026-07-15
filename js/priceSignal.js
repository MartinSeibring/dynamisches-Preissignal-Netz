/**
 * Preissignal-Engine
 * Berechnet dynamische Netzentgelte auf Basis der Trafo-Auslastung.
 */

export const DEFAULT_PARAMS = {
  basisCt:        25.0,   // Grundpreis ct/kWh
  schwelleGelb:   60,     // % Auslastung
  schwelleOrange: 80,
  schwelleRot:    90,
  multGelb:       1.5,
  multOrange:     2.5,
  multRot:        4.0,
  modell:         "step", // "step" | "linear"
  minCt:          5.0,
  maxCt:          150.0,
};

export class PriceSignalEngine {

  /**
   * Bestimmt die Auslastungszone eines Zeitpunkts.
   * @param {number} utilPercent - Auslastung in %
   * @param {object} thresholds - schwelleGelb, schwelleOrange, schwelleRot
   * @returns {"green"|"yellow"|"orange"|"red"}
   */
  calculateZone(utilPercent, thresholds) {
    const { schwelleGelb, schwelleOrange, schwelleRot } = thresholds;
    if (utilPercent >= schwelleRot)    return "red";
    if (utilPercent >= schwelleOrange) return "orange";
    if (utilPercent >= schwelleGelb)   return "yellow";
    return "green";
  }

  /**
   * Berechnet den Preis für eine gegebene Auslastung.
   * @param {number} utilPercent
   * @param {object} params - vollständige Parameterliste
   */
  calculatePrice(utilPercent, params) {
    const p = { ...DEFAULT_PARAMS, ...params };
    const zone = this.calculateZone(utilPercent, p);

    let price;
    if (p.modell === "linear") {
      price = this.#linearPrice(utilPercent, p);
    } else {
      price = this.#stepPrice(zone, p);
    }

    return Math.min(p.maxCt, Math.max(p.minCt, price));
  }

  #stepPrice(zone, p) {
    switch (zone) {
      case "red":    return p.basisCt * p.multRot;
      case "orange": return p.basisCt * p.multOrange;
      case "yellow": return p.basisCt * p.multGelb;
      default:       return p.basisCt;
    }
  }

  #linearPrice(util, p) {
    const { basisCt, schwelleGelb, schwelleOrange, schwelleRot,
            multGelb, multOrange, multRot } = p;

    if (util < schwelleGelb) {
      return basisCt;
    }
    if (util < schwelleOrange) {
      const t = (util - schwelleGelb) / (schwelleOrange - schwelleGelb);
      return basisCt + (basisCt * multGelb - basisCt) * t;
    }
    if (util < schwelleRot) {
      const t = (util - schwelleOrange) / (schwelleRot - schwelleOrange);
      return basisCt * multGelb + (basisCt * multOrange - basisCt * multGelb) * t;
    }
    // Oberhalb Rot-Schwelle: extrapolieren bis maxCt
    const t = Math.min(1, (util - schwelleRot) / 10);
    return basisCt * multOrange + (basisCt * multRot - basisCt * multOrange) * t;
  }

  /**
   * Generiert Preissignale für einen Lastgang.
   * @param {Array} lastgang - Array von {ts, p, q, s}
   * @param {number} nennleistung - Nennleistung in kVA
   * @param {object} params
   * @returns {Array} - Array von {ts, util, zone, price, p, s}
   */
  generate(lastgang, nennleistung, params = {}) {
    const p = { ...DEFAULT_PARAMS, ...params };
    return lastgang.map(entry => {
      const s = entry.s || Math.sqrt((entry.p || 0) ** 2 + (entry.q || 0) ** 2);
      const util = nennleistung > 0 ? (s / nennleistung) * 100 : 0;
      const zone = this.calculateZone(util, p);
      const price = this.calculatePrice(util, p);
      return {
        ts:    entry.ts,
        util:  round2(util),
        zone,
        price: round2(price),
        p:     entry.p,
        s:     round2(s),
      };
    });
  }

  /**
   * Tagesübersicht: pro Tag die Preissignal-Statistiken.
   */
  dailySummary(signals) {
    const byDay = {};
    for (const s of signals) {
      const day = s.ts.substring(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(s);
    }
    return Object.entries(byDay).map(([day, entries]) => ({
      day,
      avgUtil:   round2(mean(entries.map(e => e.util))),
      maxUtil:   round2(Math.max(...entries.map(e => e.util))),
      avgPrice:  round2(mean(entries.map(e => e.price))),
      maxPrice:  round2(Math.max(...entries.map(e => e.price))),
      zones: {
        green:  entries.filter(e => e.zone === "green").length,
        yellow: entries.filter(e => e.zone === "yellow").length,
        orange: entries.filter(e => e.zone === "orange").length,
        red:    entries.filter(e => e.zone === "red").length,
      },
    }));
  }

  /** Zonenzählung über den gesamten Zeitraum */
  zoneDistribution(signals) {
    const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
    for (const s of signals) {
      if (s.zone in counts) counts[s.zone]++;
    }
    return counts;
  }

  /** Exportiert Signale als CSV-String */
  toCsvString(signals) {
    const header = "Zeitstempel;Auslastung %;Zone;Preis ct/kWh;Leistung kW;Scheinleistung kVA";
    const rows = signals.map(s =>
      [
        formatTs(s.ts),
        s.util.toFixed(2),
        s.zone,
        s.price.toFixed(2),
        (s.p ?? "").toString(),
        (s.s ?? "").toString(),
      ].join(";")
    );
    return `﻿${header}\n${rows.join("\n")}`;
  }
}

export const priceEngine = new PriceSignalEngine();

// ---- Utilities ---- //
function mean(arr) {
  const v = arr.filter(isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function round2(v) { return Math.round(v * 100) / 100; }

function formatTs(ts) {
  const d = new Date(ts);
  return d.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
