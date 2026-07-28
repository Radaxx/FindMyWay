// Génération d'itinéraires calibrés sur une distance cible.
//
// Principe : on propose des points de passage, on demande l'itinéraire réel au
// service de routage, puis on ajuste l'échelle de la figure jusqu'à tomber sur
// la distance demandée (le réseau routier rallonge toujours le tracé théorique).
//
// Quand l'utilisateur impose ses propres points de passage, la figure change :
// le tracé qui les relie devient le minimum incompressible, et on gonfle chaque
// portion latéralement jusqu'à atteindre la distance voulue.

import { destination, bearing as bearingBetween, seededRandom, clamp, pathLength } from './geo.js';
import { route } from './routing.js';
import { removeOutAndBack } from './simplify.js';

const TOLERANCE = 0.04; // écart relatif accepté par rapport à la cible
const MAX_ITERATIONS = 7;

/**
 * @param {object} opts
 * @param {{lat:number,lng:number}} opts.start
 * @param {number} opts.targetDistance      distance visée en mètres
 * @param {'bike'|'run'} opts.sport
 * @param {'loop'|'outback'|'oneway'} opts.shape
 * @param {number} opts.bearing             cap général en degrés
 * @param {number} opts.seed                graine pour varier les tracés
 * @param {{lat:number,lng:number}[]} [opts.vias]  points de passage imposés
 * @param {boolean} [opts.preferSignposted] privilégier les itinéraires balisés
 * @param {(msg: string) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function planRoute(opts) {
  // L'aller-retour se calcule sur la moitié de la cible, puis se replie.
  if (opts.shape === 'outback') {
    const leg = await planLeg({ ...opts, shape: 'oneway', targetDistance: opts.targetDistance / 2 });
    return mirror(leg);
  }
  return planLeg(opts);
}

function planLeg(opts) {
  if (opts.vias?.length) return planWithVias(opts);
  return opts.shape === 'loop' ? planLoop(opts) : planOneWay(opts);
}

/**
 * Replie un aller sur lui-même : on repart par le même chemin. C'est le seul
 * cas où un aller-retour est voulu, donc le nettoyage des impasses ne doit
 * surtout pas s'appliquer après coup (il n'intervient que sur l'aller).
 */
function mirror(leg) {
  const back = leg.coords.slice(0, -1).reverse();
  const surfaces = leg.surfaces
    ? [...leg.surfaces, ...leg.surfaces.slice(0, -1).reverse()]
    : null;

  return {
    ...leg,
    coords: [...leg.coords, ...back],
    surfaces,
    distance: leg.distance * 2,
    duration: leg.duration * 2,
    turnaround: leg.coords.at(-1),
  };
}

async function planLoop(opts) {
  const { start, targetDistance, bearing, seed } = opts;
  const rng = seededRandom(seed);
  const nodes = 5 + Math.floor(rng() * 2); // 5 ou 6 points de passage
  const sense = rng() < 0.5 ? 1 : -1; // sens horaire / antihoraire
  const jitter = Array.from({ length: nodes }, () => 0.85 + rng() * 0.3);

  // Rayon d'un cercle dont la circonférence vaut la distance visée.
  const radius = targetDistance / (2 * Math.PI);

  return refine(opts, {
    build: (r) => loopWaypoints(start, r, bearing, nodes, sense, jitter),
    initialScale: radius,
  });
}

async function planOneWay(opts) {
  const { start, targetDistance, bearing, seed } = opts;
  const rng = seededRandom(seed);
  const detour = (rng() - 0.5) * 0.35; // décalage latéral du point intermédiaire

  return refine(opts, {
    build: (d) => {
      const end = destination(start, bearing, d);
      const mid = destination(destination(start, bearing, d / 2), bearing + 90, d * detour);
      return [mid, end];
    },
    // Le tracé routier est plus long que la ligne droite : on part d'un facteur 0,78.
    initialScale: targetDistance * 0.78,
  });
}

/**
 * Parcours contraint par des points de passage imposés.
 *
 * On mesure d'abord le tracé qui les relie : c'est le plancher, personne ne peut
 * faire plus court. S'il reste de la distance à couvrir, chaque portion est
 * gonflée latéralement (alternativement d'un côté puis de l'autre, pour dessiner
 * une vraie boucle plutôt qu'un aller-retour) jusqu'à la cible.
 */
async function planWithVias(opts) {
  const { start, vias, targetDistance, shape, bearing, seed, onProgress } = opts;
  const rng = seededRandom(seed);
  const sense = rng() < 0.5 ? 1 : -1;

  const mandatory = shape === 'loop' ? [...vias, start] : [...vias];
  const chain = [start, ...mandatory];

  onProgress?.('Tracé imposé par les points de passage…');
  const baseline = trimSpurs(await routeThrough(opts, mandatory));

  if (!baseline.distance) throw new Error("Aucun itinéraire n'a pu être calculé.");

  const relativeError = (d) => Math.abs(d - targetDistance) / targetDistance;

  // Les points de passage imposent déjà (ou presque) la distance demandée.
  if (baseline.distance >= targetDistance * (1 - TOLERANCE)) {
    return { ...baseline, error: relativeError(baseline.distance), minimal: true };
  }

  const build =
    shape === 'loop'
      ? (bulge) => bulgedWaypoints(chain, bulge, sense)
      : (crow) => [...vias, destination(vias.at(-1), bearing, Math.max(50, crow))];

  // Un renflement de facteur f rallonge une portion d'environ sqrt(1 + 4f²) :
  // on part de la valeur qui vise directement la cible.
  const initialScale =
    shape === 'loop'
      ? Math.sqrt(Math.max(0, (targetDistance / baseline.distance) ** 2 - 1)) / 2
      : (targetDistance - baseline.distance) * 0.78;

  return refine(opts, {
    build,
    initialScale,
    initialBest: { ...baseline, error: relativeError(baseline.distance) },
    maxIterations: 5,
    // La marge de manœuvre porte sur le supplément, pas sur la distance totale.
    adjust: (scale, distance) => {
      const wanted = targetDistance - baseline.distance;
      const current = Math.max(1, distance - baseline.distance);
      const ratio = clamp(wanted / current, 0.35, 2.5);
      return Math.max(0.02, scale * (1 + (ratio - 1) * 0.8));
    },
  });
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

/**
 * Ajoute à chaque portion un point de détour latéral, alterné d'un côté puis de
 * l'autre. `chain` commence par le départ ; la liste renvoyée contient tout ce
 * qui suit.
 */
function bulgedWaypoints(chain, bulge, sense) {
  const points = [];

  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1];
    const to = chain[i];
    const span = pathLength([from, to]);

    if (bulge > 0.02 && span > 100) {
      const heading = bearingBetween(from, to);
      const side = (i % 2 === 1 ? 1 : -1) * sense;
      const middle = destination(from, heading, span / 2);
      points.push(destination(middle, heading + 90 * side, span * bulge));
    }
    points.push(to);
  }

  return points;
}

const routeThrough = (opts, waypoints) =>
  route([opts.start, ...waypoints], opts.sport, {
    signal: opts.signal,
    terrain: opts.terrain,
    preferSignposted: opts.preferSignposted,
  });

/** Boucle d'ajustement commune à toutes les formes de parcours. */
async function refine(opts, { build, initialScale, initialBest, adjust, maxIterations }) {
  const { targetDistance, onProgress } = opts;
  const limit = maxIterations ?? MAX_ITERATIONS;

  let scale = initialScale;
  let best = initialBest ?? null;
  let lastError = null;

  for (let i = 0; i < limit; i++) {
    onProgress?.(`Calcul de l'itinéraire… (essai ${i + 1})`);

    let result;
    try {
      result = await routeThrough(opts, build(scale));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      if (best) break; // on garde le meilleur tracé déjà obtenu
      throw err;
    }

    if (!result.distance) throw lastError ?? new Error('Itinéraire vide.');

    result = trimSpurs(result);

    const error = Math.abs(result.distance - targetDistance) / targetDistance;
    if (!best || error < best.error) best = { ...result, error, scale };
    if (error <= TOLERANCE) break;

    // Correction amortie pour éviter les oscillations d'un essai à l'autre.
    const next = adjust
      ? adjust(scale, result.distance)
      : scale * (1 + (clamp(targetDistance / result.distance, 0.55, 1.8) - 1) * 0.85);

    if (Math.abs(next - scale) / Math.max(scale, 1e-6) < 0.005) break; // convergence bloquée
    scale = next;
  }

  if (!best) throw lastError ?? new Error("Aucun itinéraire n'a pu être calculé.");
  return best;
}

/**
 * Retire les impasses parcourues dans les deux sens et réajuste la distance
 * annoncée au prorata de la trace conservée.
 */
function trimSpurs(result) {
  const { coords, removed, keep } = removeOutAndBack(result.coords);
  if (!removed) return result;

  const before = pathLength(result.coords);
  const ratio = before > 0 ? pathLength(coords) / before : 1;

  return {
    ...result,
    coords,
    // Les revêtements sont indexés comme les points : même filtrage.
    surfaces: result.surfaces ? result.surfaces.filter((_, i) => keep[i]) : null,
    distance: result.distance * ratio,
    duration: result.duration * ratio,
    trimmed: removed,
  };
}
