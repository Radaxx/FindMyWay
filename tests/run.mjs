// Tests de la logique de tracé, sans réseau ni navigateur : `node tests/run.mjs`
// Le routeur est simulé — le réseau routier rallonge le tracé théorique d'un
// facteur constant, et peut se caler sur une voie sans issue.

import { destination, distance, pathLength } from '../js/geo.js';
import { removeOutAndBack } from '../js/simplify.js';
import { planRoute } from '../js/planner.js';
import { stickToCycleRoutes } from '../js/routing.js';

let failures = 0;

function check(name, ok, info = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
}

/** Segment droit de `points` points, depuis `from` sur `meters` au cap `bearing`. */
const leg = (from, bearing, meters, points) =>
  Array.from({ length: points }, (_, i) => destination(from, bearing, (meters * (i + 1)) / points));

const home = { lat: 44.9165, lng: -0.2701 };

/* ---------------------------------------- nettoyage des allers-retours ---- */

console.log('\nAllers-retours (js/simplify.js)');

{
  const approach = [home, ...leg(home, 90, 800, 16)];
  const junction = approach.at(-1);
  const out = leg(junction, 0, 250, 5);
  const back = [...out].reverse().slice(1).concat([junction]);
  const coords = [...approach, ...out, ...back, ...leg(junction, 90, 900, 18)];

  const { coords: cleaned, removed } = removeOutAndBack(coords);
  const tip = out.at(-1);
  const gap = Math.max(...cleaned.slice(1).map((p, i) => distance(cleaned[i], p)));

  check('impasse supprimée', removed > 400 && !cleaned.some((p) => distance(p, tip) < 30),
    `${Math.round(removed)} m retirés`);
  check('trace continue après nettoyage', gap < 120, `plus grand saut ${Math.round(gap)} m`);
  check('extrémités préservées',
    distance(cleaned[0], coords[0]) < 1 && distance(cleaned.at(-1), coords.at(-1)) < 1);
}

{
  // L'aller et le retour n'ont pas le même nombre de points.
  const approach = [home, ...leg(home, 45, 600, 12)];
  const junction = approach.at(-1);
  const out = leg(junction, 135, 300, 9);
  const back = leg(out.at(-1), 315, 300, 4);
  const coords = [...approach, ...out, ...back, ...leg(junction, 45, 700, 14)];

  check('découpage asymétrique géré', removeOutAndBack(coords).removed > 400);
}

{
  // Boucle carrée sans demi-tour : rien à retirer.
  const coords = [home];
  for (const [bearing, d] of [[0, 1200], [90, 1500], [180, 1200], [270, 1500]]) {
    coords.push(...leg(coords.at(-1), bearing, d, 24));
  }
  check('parcours propre inchangé', removeOutAndBack(coords).removed === 0);
}

{
  // Départ au fond d'une impasse : la sortie doit être conservée.
  const exit = leg(home, 0, 200, 4);
  const junction = exit.at(-1);
  const loop = [];
  for (const [bearing, d] of [[90, 900], [180, 900], [270, 900], [0, 900]]) {
    loop.push(...leg(loop.at(-1) ?? junction, bearing, d, 18));
  }
  const coords = [home, ...exit, ...loop, ...[...exit].reverse().slice(1), home];

  const { coords: cleaned } = removeOutAndBack(coords);
  check('impasse du domicile conservée',
    distance(cleaned[0], home) < 1 && distance(cleaned.at(-1), home) < 1 &&
    cleaned.length >= coords.length - 2);
}

{
  // Épingle de 25 m : c'est un virage, pas une impasse.
  const approach = [home, ...leg(home, 90, 500, 10)];
  const corner = approach.at(-1);
  const coords = [
    ...approach,
    ...leg(corner, 20, 25, 2),
    ...leg(destination(corner, 20, 25), 200, 25, 2),
    ...leg(corner, 90, 500, 10),
  ];
  check('épingle courte conservée', removeOutAndBack(coords).removed === 0);
}

/* --------------------------------------------- calibration des parcours --- */

console.log('\nCalibration (js/planner.js)');

/**
 * Routeur simulé : détour de 30 %, et si demandé une impasse à chaque point de
 * passage. Répond au format BRouter (fournisseur principal) comme au format
 * OSRM (repli), selon l'URL appelée.
 */
function fakeRouter({ deadEnds = false } = {}) {
  globalThis.fetch = async (url) => {
    const target = decodeURIComponent(String(url));
    const brouter = target.includes('lonlats=');

    const part = brouter
      ? target.split('lonlats=')[1].split('&')[0]
      : target.split('/driving/')[1].split('?')[0];

    const via = part.split(brouter ? '|' : ';').map((s) => {
      const [lng, lat] = s.split(',').map(Number);
      return { lat, lng };
    });

    const coords = [];
    for (let i = 1; i < via.length; i++) {
      for (let t = 0; t < 20; t++) {
        coords.push({
          lat: via[i - 1].lat + (via[i].lat - via[i - 1].lat) * (t / 20),
          lng: via[i - 1].lng + (via[i].lng - via[i - 1].lng) * (t / 20),
        });
      }
      if (deadEnds && i < via.length - 1) {
        const j = coords.at(-1);
        const spur = [1, 2, 3].map((k) => destination(j, 25, 60 * k));
        coords.push(...spur, ...spur.slice(0, -1).reverse(), j);
      }
    }
    coords.push(via.at(-1));

    const geometry = { coordinates: coords.map((p) => [p.lng, p.lat]) };
    const length = pathLength(coords) * 1.3;

    return {
      ok: true,
      json: async () =>
        brouter
          ? {
              features: [{
                geometry,
                properties: { 'track-length': String(length), 'total-time': '3600' },
              }],
            }
          : { code: 'Ok', routes: [{ distance: length, duration: 3600, geometry }] },
    };
  };
}

fakeRouter();
for (const shape of ['loop', 'oneway']) {
  for (const km of [5, 30, 80]) {
    const target = km * 1000;
    const res = await planRoute({
      start: home, targetDistance: target, sport: 'bike', shape, bearing: 42, seed: 1234,
    });
    const errPct = ((res.distance - target) / target) * 100;
    const closed = shape !== 'loop' || distance(res.coords[0], res.coords.at(-1)) < 50;
    check(`${shape} ${km} km à ±4 %`, Math.abs(errPct) <= 4 && closed,
      `${(res.distance / 1000).toFixed(2)} km (${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)} %)`);
  }
}

fakeRouter({ deadEnds: true });
for (const shape of ['loop', 'oneway']) {
  const target = 20000;
  const res = await planRoute({
    start: home, targetDistance: target, sport: 'bike', shape, bearing: 60, seed: 99,
  });
  const errPct = ((res.distance - target) / target) * 100;
  check(`${shape} : impasses retirées et distance tenue`,
    removeOutAndBack(res.coords).removed === 0 && Math.abs(errPct) <= 5,
    `${(res.distance / 1000).toFixed(2)} km (${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)} %)`);
}

/* ------------------------------------------------ points de passage imposés --- */

console.log('\nPoints de passage (js/planner.js)');

fakeRouter();
{
  // Deux points à l'est du départ : le tracé doit y passer, dans l'ordre.
  const vias = [destination(home, 90, 3000), destination(home, 135, 4000)];

  for (const [shape, target] of [['loop', 20000], ['oneway', 20000]]) {
    const res = await planRoute({
      start: home, targetDistance: target, sport: 'bike', shape, bearing: 90, seed: 7, vias,
    });

    const passesBy = vias.every((v) => res.coords.some((p) => distance(p, v) < 150));
    const order = vias.map((v) =>
      res.coords.reduce((best, p, i) => (distance(p, v) < distance(res.coords[best], v) ? i : best), 0)
    );
    const errPct = ((res.distance - target) / target) * 100;

    check(`${shape} : passe par les points, dans l'ordre, à ±5 %`,
      passesBy && order[0] < order[1] && Math.abs(errPct) <= 5,
      `${(res.distance / 1000).toFixed(2)} km (${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)} %)`);
  }
}

{
  // Point de passage très éloigné : la cible est intenable, on le signale.
  const vias = [destination(home, 0, 25000)];
  const res = await planRoute({
    start: home, targetDistance: 10000, sport: 'bike', shape: 'loop', bearing: 0, seed: 3, vias,
  });
  check('cible intenable signalée', res.minimal === true && res.distance > 10000,
    `plancher ${(res.distance / 1000).toFixed(1)} km`);
}

{
  // Boucle avec un seul point : le renflement doit éviter le simple aller-retour.
  const vias = [destination(home, 45, 2000)];
  const res = await planRoute({
    start: home, targetDistance: 15000, sport: 'bike', shape: 'loop', bearing: 45, seed: 11, vias,
  });
  const errPct = Math.abs((res.distance - 15000) / 15000) * 100;
  check('boucle gonflée jusqu’à la cible', errPct <= 5 && distance(res.coords[0], res.coords.at(-1)) < 50,
    `${(res.distance / 1000).toFixed(2)} km`);
}

/* ------------------------------------------------- profil itinéraires balisés --- */

console.log('\nProfil BRouter (js/routing.js)');

{
  const profile = [
    '# trekking profile',
    'assign   consider_elevation   true',
    'assign   stick_to_cycleroutes   false  # %stick_to_cycleroutes% | Follow cycleroutes | boolean',
    'assign   allow_ferries   true',
  ].join('\n');

  const patched = stickToCycleRoutes(profile);
  check('paramètre stick_to_cycleroutes activé',
    /assign\s+stick_to_cycleroutes\s+true/.test(patched) &&
    patched.includes('consider_elevation   true') &&
    patched.split('\n').length === profile.split('\n').length);
  check('profil inconnu refusé (repli sur le profil standard)',
    stickToCycleRoutes('assign consider_elevation true') === null);
}

console.log(failures ? `\n${failures} test(s) en échec.` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
