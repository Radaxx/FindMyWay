// Retouche d'un tracé existant.
//
// Un itinéraire est produit par une chaîne de points envoyée au routeur : le
// départ, d'éventuels points de passage, l'arrivée. Attraper la trace et la
// tirer ailleurs revient à insérer un point dans cette chaîne, au bon endroit.
//
// Reste à savoir « au bon endroit » : il faut retrouver, dans la trace, la
// position de chaque point de la chaîne, puis repérer entre lesquels se trouve
// l'endroit saisi.

import { distance } from './geo.js';

/**
 * Position de chaque point de la chaîne dans la trace.
 *
 * La recherche avance avec la chaîne : sur une boucle, départ et arrivée sont
 * au même endroit, et seul l'ordre permet de les distinguer.
 *
 * @returns {number[]} un indice de `coords` par point de `chain`
 */
export function waypointMarks(coords, chain) {
  const marks = [];
  let cursor = 0;

  for (const [i, point] of chain.entries()) {
    // Le dernier point de la chaîne est forcément la fin de la trace.
    cursor = i === chain.length - 1 ? coords.length - 1 : nearestIndex(coords, point, cursor);
    marks.push(cursor);
  }

  return marks;
}

/** Indice du point de `coords` le plus proche de `target`, à partir de `from`. */
export function nearestIndex(coords, target, from = 0) {
  let best = from;
  let bestGap = Infinity;

  for (let i = from; i < coords.length; i++) {
    const gap = distance(coords[i], target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
      if (gap < 1) break;
    }
  }

  return best;
}

/**
 * Rang auquel insérer un point saisi à l'indice `at` de la trace.
 *
 * @returns {number} indice d'insertion dans la chaîne, toujours entre le départ
 *          et le dernier point (on ne déplace jamais les extrémités)
 */
export function insertionIndex(coords, chain, at) {
  const marks = waypointMarks(coords, chain);

  let rank = 1;
  while (rank < chain.length - 1 && marks[rank] <= at) rank++;

  return rank;
}
