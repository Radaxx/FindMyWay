// Utilitaires géographiques (coordonnées en degrés, distances en mètres).

const R = 6371008.8; // rayon moyen de la Terre (m)

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Distance orthodromique entre deux points {lat, lng}. */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point atteint depuis `origin` en suivant un cap (degrés) sur `dist` mètres. */
export function destination(origin, bearingDeg, dist) {
  const d = dist / R;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDeg(lat2),
    lng: ((toDeg(lng2) + 540) % 360) - 180,
  };
}

/** Longueur cumulée d'une polyligne [{lat, lng}, ...]. */
export function pathLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distance(coords[i - 1], coords[i]);
  return total;
}

/** Distances cumulées le long d'une polyligne (même longueur que `coords`). */
export function cumulativeDistances(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + distance(coords[i - 1], coords[i]));
  }
  return out;
}

/**
 * Échantillonne `count` points régulièrement espacés le long d'une polyligne.
 * Renvoie { points, distances } où `distances` est la distance cumulée de chaque point.
 */
export function samplePath(coords, count) {
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  if (coords.length <= count || total === 0) {
    return { points: coords.slice(), distances: cum };
  }

  const points = [];
  const distances = [];
  let idx = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (idx < cum.length - 2 && cum[idx + 1] < target) idx++;
    const span = cum[idx + 1] - cum[idx];
    const t = span > 0 ? (target - cum[idx]) / span : 0;
    points.push({
      lat: coords[idx].lat + (coords[idx + 1].lat - coords[idx].lat) * t,
      lng: coords[idx].lng + (coords[idx + 1].lng - coords[idx].lng) * t,
    });
    distances.push(target);
  }
  return { points, distances };
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
