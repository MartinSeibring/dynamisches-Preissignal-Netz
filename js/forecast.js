/**
 * Prognosealgorithmen: MA, ETS (Holt), Holt-Winters (saisonal)
 * Input: Array von Zahlen (Zeitreihe)
 * Output: { fitted, forecast, lower, upper }
 */

// ---- Simple Moving Average ---- //
export function simpleMovingAverage(series, window = 7) {
  if (series.length < window) {
    return { fitted: [...series], forecast: [], lower: [], upper: [], method: "SMA" };
  }
  const fitted = [];
  for (let i = 0; i < series.length; i++) {
    if (i < window - 1) {
      fitted.push(null);
      continue;
    }
    const slice = series.slice(i - window + 1, i + 1);
    fitted.push(mean(slice));
  }
  // Letzter Wert als Prognose
  const lastMean = fitted[fitted.length - 1] ?? mean(series.slice(-window));
  return { fitted, forecast: [], lastMean, method: "SMA" };
}

/**
 * Einfaches exponentielles Glätten (SES)
 * @param {number[]} series
 * @param {number} alpha - Glättungsparameter (0..1)
 * @param {number} horizont - Anzahl Schritte in die Zukunft
 */
export function exponentialSmoothing(series, alpha = 0.3, horizont = 96) {
  if (!series.length) return empty("SES");

  let level = series[0];
  const fitted = [level];

  for (let i = 1; i < series.length; i++) {
    level = alpha * series[i] + (1 - alpha) * level;
    fitted.push(level);
  }

  // Prognose: konstant auf letztem Level
  const forecast = Array(horizont).fill(level);
  const residuals = series.map((v, i) => v - (fitted[i] ?? v));
  const rmse = Math.sqrt(mean(residuals.map(r => r * r)));
  const ci = 1.96 * rmse;

  return {
    fitted,
    forecast,
    lower: forecast.map(v => Math.max(0, v - ci)),
    upper: forecast.map(v => v + ci),
    rmse,
    method: "SES",
    params: { alpha },
  };
}

/**
 * Holt'sches Verfahren (Double Exponential Smoothing)
 * Berücksichtigt Trend.
 */
export function doubleExponentialSmoothing(series, alpha = 0.3, beta = 0.1, horizont = 96) {
  if (series.length < 2) return empty("HOLT");

  let level = series[0];
  let trend = series[1] - series[0];
  const fitted = [level];

  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta  * (level - prevLevel) + (1 - beta) * trend;
    fitted.push(level + trend);
  }

  const forecast = [];
  for (let h = 1; h <= horizont; h++) {
    forecast.push(level + h * trend);
  }

  const residuals = series.slice(1).map((v, i) => v - (fitted[i + 1] ?? v));
  const rmse = Math.sqrt(mean(residuals.map(r => r * r)));
  const ciBase = 1.96 * rmse;

  return {
    fitted,
    forecast: forecast.map(v => Math.max(0, v)),
    lower: forecast.map((v, h) => Math.max(0, v - ciBase * Math.sqrt(h + 1))),
    upper: forecast.map((v, h) => v + ciBase * Math.sqrt(h + 1)),
    rmse,
    method: "HOLT",
    params: { alpha, beta },
  };
}

/**
 * Holt-Winters (Triple Exponential Smoothing)
 * Berücksichtigt Trend + Saisonalität (additiv).
 * @param {number[]} series
 * @param {number} alpha - Level
 * @param {number} beta  - Trend
 * @param {number} gamma - Saison
 * @param {number} seasonLen - Saisonlänge (z.B. 96 für Tages-Periodizität)
 * @param {number} horizont - Schritte voraus
 */
export function holtWinters(
  series,
  alpha = 0.3,
  beta  = 0.1,
  gamma = 0.2,
  seasonLen = 96,
  horizont  = 96,
) {
  if (series.length < 2 * seasonLen) {
    // Zu wenig Daten → Fallback auf Holt
    return doubleExponentialSmoothing(series, alpha, beta, horizont);
  }

  // Initialisierung
  let level = mean(series.slice(0, seasonLen));
  let trend = (mean(series.slice(seasonLen, 2 * seasonLen)) - level) / seasonLen;
  const seasonals = initSeasonals(series, seasonLen);

  const fitted = [];

  for (let i = 0; i < series.length; i++) {
    const s = seasonals[i % seasonLen];
    const prevLevel = level;
    level = alpha * (series[i] - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonals[i % seasonLen] = gamma * (series[i] - level) + (1 - gamma) * s;
    fitted.push(level + trend + seasonals[i % seasonLen]);
  }

  const forecast = [];
  const n = series.length;
  for (let h = 1; h <= horizont; h++) {
    const sIdx = (n + h - 1) % seasonLen;
    forecast.push(Math.max(0, level + h * trend + seasonals[sIdx]));
  }

  const residuals = series.map((v, i) => v - (fitted[i] ?? v));
  const rmse = Math.sqrt(mean(residuals.filter(isFinite).map(r => r * r)));
  const ciBase = 1.96 * rmse;

  return {
    fitted: fitted.map(v => Math.max(0, v)),
    forecast,
    lower: forecast.map((v, h) => Math.max(0, v - ciBase * Math.sqrt(h + 1))),
    upper: forecast.map((v, h) => v + ciBase * Math.sqrt(h + 1)),
    rmse,
    method: "HOLTWINTERS",
    params: { alpha, beta, gamma, seasonLen },
  };
}

function initSeasonals(series, seasonLen) {
  const s = [];
  const nSeasons = Math.floor(series.length / seasonLen);
  for (let j = 0; j < seasonLen; j++) {
    let sum = 0;
    for (let i = 0; i < nSeasons; i++) sum += series[i * seasonLen + j] ?? 0;
    s.push(sum / nSeasons);
  }
  const avg = mean(s);
  return s.map(v => v - avg);
}

/**
 * Vereinheitlichte Forecast-Funktion mit Methodenwahl.
 * @param {number[]} series - Zeitreihenwerte
 * @param {string} method - "ma" | "ses" | "holt" | "holtwinters"
 * @param {object} params
 */
export function forecast(series, method = "holtwinters", params = {}) {
  const clean = series.map(v => (isFinite(v) && v >= 0 ? v : 0));

  switch (method) {
    case "ma":
      return movingAverageForecast(clean, params.window || 96, params.horizont || 96);
    case "ses":
      return exponentialSmoothing(clean, params.alpha ?? 0.3, params.horizont || 96);
    case "holt":
      return doubleExponentialSmoothing(clean, params.alpha ?? 0.3, params.beta ?? 0.1, params.horizont || 96);
    case "holtwinters":
    default:
      return holtWinters(
        clean,
        params.alpha     ?? 0.3,
        params.beta      ?? 0.1,
        params.gamma     ?? 0.2,
        params.seasonLen ?? 96,
        params.horizont  ?? 96,
      );
  }
}

/**
 * Moving-Average-Prognose: Letztes vollständiges Saisonmuster wiederholen.
 */
function movingAverageForecast(series, window = 96, horizont = 96) {
  const base = simpleMovingAverage(series, window);
  // Letztes Fenster als Prognosevorlage
  const template = series.slice(-Math.min(window, series.length));
  const n = template.length;
  const fc = Array.from({ length: horizont }, (_, i) => template[i % n]);

  const residuals = series.slice(window).map((v, i) => v - (base.fitted[i + window] ?? v));
  const rmse = residuals.length ? Math.sqrt(mean(residuals.map(r => r * r))) : 0;
  const ci = 1.96 * rmse;

  return {
    fitted: base.fitted,
    forecast: fc,
    lower: fc.map(v => Math.max(0, v - ci)),
    upper: fc.map(v => v + ci),
    rmse,
    method: "MA",
    params: { window },
  };
}

// ---- Utilities ---- //
function mean(arr) {
  const vals = arr.filter(isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function empty(method) {
  return { fitted: [], forecast: [], lower: [], upper: [], rmse: 0, method };
}
