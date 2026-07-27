// Tests de la logique de tracé, sans réseau ni navigateur : `node tests/run.mjs`
// Le routeur est simulé — le réseau routier rallonge le tracé théorique d'un
// facteur constant, et peut se caler sur une voie sans issue.

import { destination, distance, pathLength } from '../js/geo.js';
import { removeOutAndBack } from '../js/simplify.js';
import { planRoute } from '../js/planner.js';

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

/** Routeur simulé : détour de 30 %, et une impasse à chaque point de passage. */
function fakeRouter({ deadEnds = false } = {}) {
  globalThis.fetch = async (url) => {
    const part = decodeURIComponent(String(url)).split('/driving/')[1].split('?')[0];
    const via = part.split(';').map((s) => {
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

    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{
          distance: pathLength(coords) * 1.3,
          duration: 3600,
          geometry: { coordinates: coords.map((p) => [p.lng, p.lat]) },
        }],
      }),
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

console.log(failures ? `\n${failures} test(s) en échec.` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
