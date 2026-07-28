// Nettoyage des allers-retours parasites.
//
// Un point de passage se cale parfois sur une voie sans issue : le routeur y
// entre, va jusqu'au bout, puis repart en sens inverse. Sur la trace, ce détour
// se repère facilement — le tracé se replie sur lui-même de part et d'autre du
// demi-tour.
//
// On supprime alors la portion comprise entre les deux passages à la jonction.
// Le tracé reste continu (on entrait et on ressortait par le même carrefour) et
// raccourcit d'autant, ce dont la calibration tient compte à l'itération
// suivante.
//
// Le tout début et la toute fin du parcours ne sont jamais rognés : si le
// domicile est lui-même au fond d'une impasse, il faut bien en sortir.

import { distance, distanceToSegment, pathLength, bearing, angleBetween } from './geo.js';

const TOLERANCE = 15; // m : écart admis entre l'aller et le retour
const MIN_SPUR = 40; // m : en deçà, c'est un virage serré, pas une impasse
const MIN_ANGLE = 120; // ° : au-delà, les deux brins sont bien en sens inverse

/**
 * @param {{lat:number,lng:number}[]} coords
 * @returns {{coords: {lat:number,lng:number}[], removed: number, keep: boolean[] | null}}
 *          tracé nettoyé, longueur (m) des allers-retours supprimés, et masque
 *          des points conservés (pour filtrer les données parallèles)
 */
export function removeOutAndBack(coords, { tolerance = TOLERANCE, minSpur = MIN_SPUR } = {}) {
  const n = coords.length;
  if (n < 5) return { coords, removed: 0, keep: null };

  const keep = new Array(n).fill(true);
  let removed = 0;
  let i = 1;

  while (i < n - 1) {
    const fold = expandFold(coords, i, tolerance);

    // On protège les extrémités du parcours (départ et arrivée).
    if (fold && fold.a >= 1 && fold.b <= n - 2) {
      const out = pathLength(coords.slice(fold.a, i + 1));
      if (out >= minSpur) {
        for (let j = fold.a + 1; j <= fold.b; j++) keep[j] = false;
        removed += out + pathLength(coords.slice(i, fold.b + 1));
        i = fold.b + 1;
        continue;
      }
    }
    i++;
  }

  if (removed === 0) return { coords, removed: 0, keep: null };
  return { coords: coords.filter((_, idx) => keep[idx]), removed, keep };
}

/**
 * Cherche jusqu'où le tracé se replie sur lui-même autour du point `i`.
 * Les deux côtés progressent indépendamment : l'aller et le retour d'une même
 * rue ne comportent pas toujours le même nombre de points.
 *
 * @returns {{a: number, b: number} | null} indices du dernier couple superposé
 *          (`a` avant le demi-tour, `b` après)
 */
function expandFold(coords, i, tolerance) {
  const n = coords.length;
  let a = i - 1;
  let b = i + 1;

  if (folded(coords, a, b, tolerance) === null) return null;

  let lastA = a;
  let lastB = b;

  while (a > 0 || b < n - 1) {
    const candidates = [];
    if (a > 0 && b < n - 1) candidates.push([a - 1, b + 1]);
    if (a > 0) candidates.push([a - 1, b]);
    if (b < n - 1) candidates.push([a, b + 1]);

    let best = null;
    for (const [ca, cb] of candidates) {
      const d = folded(coords, ca, cb, tolerance);
      if (d !== null && (!best || d < best.d)) best = { a: ca, b: cb, d };
    }
    if (!best) break;

    a = best.a;
    b = best.b;
    lastA = a;
    lastB = b;
  }

  return { a: lastA, b: lastB };
}

/**
 * Les points `a` et `b` appartiennent-ils au même repli ? Il ne suffit pas
 * qu'ils soient proches : ils doivent aussi être parcourus en sens inverse,
 * sinon une simple ligne droite passerait pour un aller-retour.
 *
 * @returns {number | null} l'écart entre les deux brins, ou null si ce n'en est pas un
 */
function folded(coords, a, b, tolerance) {
  const gap = overlap(coords, a, b);
  if (gap > tolerance) return null;
  return angleBetween(localBearing(coords, a), localBearing(coords, b)) >= MIN_ANGLE
    ? gap
    : null;
}

/** Cap local du tracé au point `i`, en s'appuyant sur les points voisins distincts. */
function localBearing(coords, i) {
  let before = i;
  let after = i;
  while (before > 0 && distance(coords[before], coords[i]) < 1) before--;
  while (after < coords.length - 1 && distance(coords[after], coords[i]) < 1) after++;
  return before === after ? 0 : bearing(coords[before], coords[after]);
}

/**
 * Écart entre les deux brins au niveau des points `a` et `b` : on mesure chaque
 * point par rapport aux segments voisins de l'autre brin, pour ne pas dépendre
 * du découpage de la trace.
 */
function overlap(coords, a, b) {
  let best = distance(coords[a], coords[b]);
  if (a > 0) best = Math.min(best, distanceToSegment(coords[b], coords[a - 1], coords[a]));
  if (a < coords.length - 1) {
    best = Math.min(best, distanceToSegment(coords[b], coords[a], coords[a + 1]));
  }
  if (b > 0) best = Math.min(best, distanceToSegment(coords[a], coords[b - 1], coords[b]));
  if (b < coords.length - 1) {
    best = Math.min(best, distanceToSegment(coords[a], coords[b], coords[b + 1]));
  }
  return best;
}
