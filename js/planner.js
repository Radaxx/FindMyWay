// Génération d'itinéraires calibrés sur une distance cible.
//
// Principe : on propose des points de passage, on demande l'itinéraire réel au
// service de routage, puis on ajuste l'échelle de la figure jusqu'à tomber sur
// la distance demandée (le réseau routier rallonge toujours le tracé théorique).

import { destination, seededRandom, clamp } from './geo.js';
import { route } from './routing.js';

const TOLERANCE = 0.04; // écart relatif accepté par rapport à la cible
const MAX_ITERATIONS = 7;

/**
 * @param {object} opts
 * @param {{lat:number,lng:number}} opts.start
 * @param {number} opts.targetDistance  distance visée en mètres
 * @param {'bike'|'run'} opts.sport
 * @param {'loop'|'oneway'} opts.shape
 * @param {number} opts.bearing         cap général en degrés
 * @param {number} opts.seed            graine pour varier les tracés
 * @param {(msg: string) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function planRoute(opts) {
  return opts.shape === 'loop' ? planLoop(opts) : planOneWay(opts);
}

async function planLoop({ start, targetDistance, sport, bearing, seed, onProgress, signal }) {
  const rng = seededRandom(seed);
  const nodes = 5 + Math.floor(rng() * 2); // 5 ou 6 points de passage
  const sense = rng() < 0.5 ? 1 : -1; // sens horaire / antihoraire
  const jitter = Array.from({ length: nodes }, () => 0.85 + rng() * 0.3);

  // Rayon d'un cercle dont la circonférence vaut la distance visée.
  let radius = targetDistance / (2 * Math.PI);

  const build = (r) => loopWaypoints(start, r, bearing, nodes, sense, jitter);
  return refine({ start, build, targetDistance, sport, initialScale: radius, onProgress, signal });
}

async function planOneWay({ start, targetDistance, sport, bearing, seed, onProgress, signal }) {
  const rng = seededRandom(seed);
  // Le tracé routier est plus long que la ligne droite : on part d'un facteur 0,78.
  let crow = targetDistance * 0.78;
  const detour = (rng() - 0.5) * 0.35; // décalage latéral du point intermédiaire

  const build = (d) => {
    const end = destination(start, bearing, d);
    const mid = destination(
      destination(start, bearing, d / 2),
      bearing + 90,
      d * detour
    );
    return [mid, end];
  };

  return refine({ start, build, targetDistance, sport, initialScale: crow, onProgress, signal });
}

/** Points de passage répartis sur un cercle décalé dans la direction voulue. */
function loopWaypoints(start, radius, bearing, nodes, sense, jitter) {
  const center = destination(start, bearing, radius);
  // Le départ se trouve sur le cercle, au cap opposé vu depuis le centre.
  const startAngle = bearing + 180;
  const step = (360 / nodes) * sense;

  const points = [];
  for (let i = 1; i < nodes; i++) {
    points.push(destination(center, startAngle + step * i, radius * jitter[i]));
  }
  points.push(start); // retour au point de départ
  return points;
}

/** Boucle d'ajustement commune aux deux formes de parcours. */
async function refine({ start, build, targetDistance, sport, initialScale, onProgress, signal }) {
  let scale = initialScale;
  let best = null;
  let lastError = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    onProgress?.(`Calcul de l'itinéraire… (essai ${i + 1})`);

    let result;
    try {
      result = await route([start, ...build(scale)], sport, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      if (best) break; // on garde le meilleur tracé déjà obtenu
      throw err;
    }

    if (!result.distance) throw lastError ?? new Error('Itinéraire vide.');

    const error = Math.abs(result.distance - targetDistance) / targetDistance;
    if (!best || error < best.error) best = { ...result, error, scale };
    if (error <= TOLERANCE) break;

    // Correction amortie pour éviter les oscillations d'un essai à l'autre.
    const ratio = clamp(targetDistance / result.distance, 0.55, 1.8);
    const next = scale * (1 + (ratio - 1) * 0.85);
    if (Math.abs(next - scale) / scale < 0.005) break; // convergence bloquée
    scale = next;
  }

  if (!best) throw lastError ?? new Error("Aucun itinéraire n'a pu être calculé.");
  return best;
}
