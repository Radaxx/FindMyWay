// Profil altimétrique via l'API Elevation d'Open-Meteo (gratuite, sans clé).
// Best-effort : en cas d'échec, l'application continue sans dénivelé.

import { samplePath } from './geo.js';

const MAX_POINTS = 100; // limite par requête
const SAMPLES = 120;

/**
 * @returns {Promise<{distances: number[], elevations: number[], gain: number, loss: number} | null>}
 */
export async function fetchElevationProfile(coords, { signal } = {}) {
  try {
    const { points, distances } = samplePath(coords, SAMPLES);
    const elevations = [];

    for (let i = 0; i < points.length; i += MAX_POINTS) {
      const chunk = points.slice(i, i + MAX_POINTS);
      const lat = chunk.map((p) => p.lat.toFixed(5)).join(',');
      const lng = chunk.map((p) => p.lng.toFixed(5)).join(',');
      const res = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`,
        { signal }
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data.elevation)) return null;
      elevations.push(...data.elevation);
    }

    if (elevations.length !== points.length) return null;

    const smoothed = smooth(elevations);
    const { gain, loss } = accumulate(smoothed);
    return { distances, elevations: smoothed, gain, loss };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}

/** Moyenne glissante : atténue le bruit du modèle d'élévation. */
function smooth(values, window = 2) {
  return values.map((_, i) => {
    const from = Math.max(0, i - window);
    const to = Math.min(values.length - 1, i + window);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += values[j];
    return sum / (to - from + 1);
  });
}

/** Cumul des montées/descentes avec un seuil, pour ne pas compter le bruit. */
function accumulate(values, threshold = 2) {
  let gain = 0;
  let loss = 0;
  let ref = values[0];
  for (const v of values) {
    const delta = v - ref;
    if (delta >= threshold) {
      gain += delta;
      ref = v;
    } else if (delta <= -threshold) {
      loss -= delta;
      ref = v;
    }
  }
  return { gain, loss };
}

/**
 * Interpole les altitudes du profil sur chaque point de l'itinéraire
 * (pour l'export GPX).
 */
export function interpolateElevations(cumulative, profile) {
  const { distances, elevations } = profile;
  let idx = 0;
  return cumulative.map((d) => {
    while (idx < distances.length - 2 && distances[idx + 1] < d) idx++;
    const span = distances[idx + 1] - distances[idx];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - distances[idx]) / span)) : 0;
    return elevations[idx] + (elevations[idx + 1] - elevations[idx]) * t;
  });
}
