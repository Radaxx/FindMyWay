// Tests de la logique de tracé, sans réseau ni navigateur : `node tests/run.mjs`
// Le routeur est simulé — le réseau routier rallonge le tracé théorique d'un
// facteur constant, et peut se caler sur une voie sans issue.

import { destination, distance, pathLength } from '../js/geo.js';
import { removeOutAndBack } from '../js/simplify.js';
import { planRoute, replanThrough } from '../js/planner.js';
import { waypointMarks, insertionIndex, nearestIndex } from '../js/edit.js';
import {
  applyProfileParams, resolveProviders, signpostingApplies,
  classifySurface, surfacesFromMessages,
} from '../js/routing.js';
import { buildShareUrl, parseShareParams } from '../js/share.js';

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

    // Première moitié goudronnée, seconde moitié en chemin.
    const middle = coords[Math.floor(coords.length / 2)];
    const last = coords.at(-1);
    const messages = [
      ['Longitude', 'Latitude', 'Elevation', 'Distance', 'WayTags'],
      [String(Math.round(middle.lng * 1e6)), String(Math.round(middle.lat * 1e6)), '0', '0',
       'highway=residential surface=asphalt'],
      [String(Math.round(last.lng * 1e6)), String(Math.round(last.lat * 1e6)), '0', '0',
       'highway=track surface=gravel'],
    ];

    return {
      ok: true,
      json: async () =>
        brouter
          ? {
              features: [{
                geometry,
                properties: { 'track-length': String(length), 'total-time': '3600', messages },
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

/* --------------------------------------------------------- aller-retour --- */

console.log('\nAller-retour (js/planner.js)');

fakeRouter();
{
  for (const km of [10, 42]) {
    const target = km * 1000;
    const res = await planRoute({
      start: home, targetDistance: target, sport: 'bike', shape: 'outback',
      bearing: 30, seed: 5,
    });

    const errPct = ((res.distance - target) / target) * 100;
    const closed = distance(res.coords[0], res.coords.at(-1)) < 5;
    const symmetric = distance(res.coords[res.coords.length >> 1], res.turnaround) < 300;

    check(`aller-retour ${km} km : revient au départ, à ±4 %`,
      Math.abs(errPct) <= 4 && closed && symmetric && Boolean(res.turnaround),
      `${(res.distance / 1000).toFixed(2)} km (${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)} %)`);
  }

  // Le repli sur soi est voulu. Il atteint les deux extrémités du tracé, donc
  // le nettoyage des impasses le laisse intact — vérifions-le explicitement.
  const res = await planRoute({
    start: home, targetDistance: 12000, sport: 'bike', shape: 'outback', bearing: 200, seed: 8,
  });
  const n = res.coords.length;
  const mirrored = [1, 4, 10].every((k) => distance(res.coords[k], res.coords[n - 1 - k]) < 5);
  check('le demi-tour volontaire est conservé',
    removeOutAndBack(res.coords).removed === 0 && mirrored,
    'le retour reprend exactement l’aller');

  const target = destination(home, 90, 2500);
  const withVia = await planRoute({
    start: home, targetDistance: 16000, sport: 'bike', shape: 'outback', bearing: 90, seed: 9,
    vias: [target],
  });
  check('aller-retour passant par un point imposé',
    withVia.coords.some((p) => distance(p, target) < 300) &&
    Math.abs((withVia.distance - 16000) / 16000) <= 0.05,
    `${(withVia.distance / 1000).toFixed(2)} km`);
}

/* ----------------------------------------------------- terrain et profils --- */

console.log('\nTerrain et profils BRouter (js/routing.js)');

{
  const profileOf = (sport, terrain, signposted = false) => {
    const [first] = resolveProviders(sport, terrain, signposted);
    return first.provider === 'osrm' ? 'osrm' : first.profile;
  };

  check('vélo : un profil par terrain',
    profileOf('bike', 'road') === 'fastbike' &&
    profileOf('bike', 'mixed') === 'trekking' &&
    profileOf('bike', 'trail') === 'gravel');

  check('course sur route : OSRM piéton en premier', profileOf('run', 'road') === 'osrm');
  check('course sur chemins : BRouter hiking-mountain',
    profileOf('run', 'trail') === 'hiking-mountain');

  const trail = resolveProviders('run', 'trail', true)[0];
  const easy = resolveProviders('run', 'mixed', false)[0];
  check('difficulté SAC adaptée au terrain',
    trail.params.SAC_scale_limit === 2 && easy.params.SAC_scale_limit === 1 &&
    trail.params.hiking_routes_preference === 1 &&
    easy.params.hiking_routes_preference === undefined);

  check('un repli est toujours prévu',
    resolveProviders('bike', 'trail').at(-1).provider === 'osrm' &&
    resolveProviders('run', 'road').at(-1).provider === 'brouter');

  check('option balisés annoncée sans effet sur fastbike',
    signpostingApplies('bike', 'road') === false &&
    signpostingApplies('bike', 'trail') === true &&
    signpostingApplies('run', 'road') === true);
}

{
  const profile = [
    '# trekking profile',
    'assign   consider_elevation   true',
    'assign   stick_to_cycleroutes   false  # %stick_to_cycleroutes% | boolean',
    'assign   SAC_scale_limit          3    # %SAC_scale_limit%',
    'assign   SAC_scale_preferred      1    # %SAC_scale_preferred%',
  ].join('\n');

  const patched = applyProfileParams(profile, { stick_to_cycleroutes: true, SAC_scale_limit: 2 });
  check('paramètres remplacés sans toucher au reste',
    /assign\s+stick_to_cycleroutes\s+true/.test(patched) &&
    /assign\s+SAC_scale_limit\s+2/.test(patched) &&
    /assign\s+SAC_scale_preferred\s+1/.test(patched) &&
    patched.includes('consider_elevation   true') &&
    patched.split('\n').length === profile.split('\n').length);

  check('aucun paramètre connu : rien à téléverser',
    applyProfileParams('assign consider_elevation true', { prefer_unpaved_paths: true }) === null);

  check('paramètres partiellement connus : on applique ce qui existe',
    /assign\s+consider_elevation\s+false/.test(
      applyProfileParams('assign consider_elevation true', { consider_elevation: false, absent: 1 })));
}

/* -------------------------------------------------------- arrivée imposée --- */

console.log('\nArrivée imposée (js/planner.js)');

fakeRouter();
{
  const end = destination(home, 90, 8000);

  for (const [shape, km] of [['oneway', 15], ['oneway', 30], ['outback', 30]]) {
    const res = await planRoute({
      start: home, end, targetDistance: km * 1000, sport: 'bike', shape, bearing: 90, seed: 3,
    });
    const arrival = shape === 'outback' ? res.turnaround : res.coords.at(-1);
    const errPct = ((res.distance - km * 1000) / (km * 1000)) * 100;
    const closed = shape !== 'outback' || distance(res.coords[0], res.coords.at(-1)) < 50;

    check(`${shape} ${km} km : arrive au point choisi, à ±4 %`,
      distance(arrival, end) < 50 && Math.abs(errPct) <= 4 && closed,
      `${(res.distance / 1000).toFixed(2)} km, arrivée à ${Math.round(distance(arrival, end))} m`);
  }

  // Objectif plus court que le trajet direct : on annonce le plancher.
  const short = await planRoute({
    start: home, end, targetDistance: 5000, sport: 'bike', shape: 'oneway', bearing: 90, seed: 3,
  });
  check('objectif intenable signalé, arrivée respectée',
    short.minimal === true && distance(short.coords.at(-1), end) < 50,
    `plancher ${(short.distance / 1000).toFixed(1)} km`);

  // Avec des points de passage : l'ordre départ → passages → arrivée est tenu.
  const vias = [destination(home, 45, 3000)];
  const both = await planRoute({
    start: home, vias, end, targetDistance: 25000, sport: 'bike', shape: 'oneway', bearing: 90, seed: 4,
  });
  const nearest = (p) => both.coords.reduce(
    (best, q, i) => (distance(q, p) < distance(both.coords[best], p) ? i : best), 0);
  check('points de passage puis arrivée, dans l’ordre',
    nearest(vias[0]) < nearest(end) && distance(both.coords.at(-1), end) < 50 &&
    Math.abs((both.distance - 25000) / 25000) <= 0.05,
    `${(both.distance / 1000).toFixed(2)} km`);

  // Une boucle revient au départ : l'arrivée est ignorée.
  const loop = await planRoute({
    start: home, end, targetDistance: 20000, sport: 'bike', shape: 'loop', bearing: 90, seed: 5,
  });
  check('boucle : arrivée ignorée, retour au départ',
    distance(loop.coords.at(-1), home) < 50);
}

/* -------------------------------------------------------- retouche du tracé --- */

console.log('\nRetouche du tracé (js/edit.js, js/planner.js)');

fakeRouter();
{
  for (const shape of ['loop', 'oneway', 'outback']) {
    const res = await planRoute({
      start: home, targetDistance: 20000, sport: 'bike', shape, bearing: 60, seed: 7,
    });
    const geometry = res.legCoords ?? res.coords;
    const marks = waypointMarks(geometry, res.waypoints);

    check(`${shape} : chaîne de points retrouvée sur la trace`,
      Boolean(res.waypoints?.length) &&
      marks.length === res.waypoints.length &&
      marks.every((m, i) => i === 0 || m >= marks[i - 1]) &&
      marks[0] === 0 && marks.at(-1) === geometry.length - 1,
      `${res.waypoints.length} points, repères ${JSON.stringify(marks)}`);
  }

  // Tirer la trace insère un point entre les bons voisins, et le tracé y passe.
  const res = await planRoute({
    start: home, targetDistance: 20000, sport: 'bike', shape: 'loop', bearing: 60, seed: 7,
  });
  const at = Math.floor(res.coords.length / 2);
  const rank = insertionIndex(res.coords, res.waypoints, at);
  const pulled = destination(res.coords[at], 90, 700);
  const chain = [...res.waypoints];
  chain.splice(rank, 0, pulled);

  const edited = await replanThrough(chain, { sport: 'bike', shape: 'loop' });
  check('point inséré au bon rang, tracé recalculé',
    rank > 0 && rank < res.waypoints.length &&
    edited.coords.some((p) => distance(p, pulled) < 100) &&
    distance(edited.coords[0], home) < 5 && distance(edited.coords.at(-1), home) < 5,
    `rang ${rank}/${res.waypoints.length}, ${(edited.distance / 1000).toFixed(1)} km`);

  // Un aller-retour se retouche par son aller, et reste symétrique.
  const out = await planRoute({
    start: home, targetDistance: 20000, sport: 'bike', shape: 'outback', bearing: 60, seed: 7,
  });
  const leg = out.legCoords;
  const legRank = insertionIndex(leg, out.waypoints, Math.floor(leg.length / 2));
  const detour = destination(leg[Math.floor(leg.length / 2)], 90, 600);
  const legChain = [...out.waypoints];
  legChain.splice(legRank, 0, detour);

  const reMirrored = await replanThrough(legChain, { sport: 'bike', shape: 'outback' });
  const n = reMirrored.coords.length;
  check('aller-retour retouché reste replié',
    reMirrored.mirrored === true &&
    reMirrored.coords.some((p) => distance(p, detour) < 100) &&
    [1, 8, 20].every((k) => distance(reMirrored.coords[k], reMirrored.coords[n - 1 - k]) < 1),
    `${(reMirrored.distance / 1000).toFixed(1)} km`);

  // Les extrémités ne sont jamais déplacées par une retouche.
  const straight = [home, destination(home, 90, 1000), destination(home, 90, 2000)];
  check('extrémités hors de portée de l’insertion',
    insertionIndex(straight, [home, straight.at(-1)], 0) === 1 &&
    insertionIndex(straight, [home, straight.at(-1)], 2) === 1 &&
    nearestIndex(straight, destination(home, 90, 1010)) === 1);
}

/* ------------------------------------------------------------ revêtement --- */

console.log('\nRevêtement (js/routing.js)');

{
  const cases = [
    ['highway=residential', 'paved'],
    ['highway=tertiary surface=asphalt', 'paved'],
    ['highway=cycleway surface=paving_stones', 'paved'],
    ['highway=track', 'unpaved'],
    ['highway=path surface=ground', 'unpaved'],
    ['highway=track surface=asphalt', 'paved'],
    ['highway=service tracktype=grade3', 'unpaved'],
    ['highway=service tracktype=grade1', 'paved'],
    ['', 'paved'],
  ];
  check('tags OSM correctement classés',
    cases.every(([tags, expected]) => classifySurface(tags) === expected),
    cases.map(([t, e]) => `${t || '(vide)'}→${e}`).slice(0, 3).join(', ') + '…');
}

{
  const coords = Array.from({ length: 8 }, (_, i) => destination(home, 90, i * 100));
  const at = (p) => [String(Math.round(p.lng * 1e6)), String(Math.round(p.lat * 1e6))];
  const messages = [
    ['Longitude', 'Latitude', 'WayTags'],
    [...at(coords[3]), 'highway=residential'],
    [...at(coords[6]), 'highway=track'],
  ];

  const surfaces = surfacesFromMessages(messages, coords);
  check('revêtement aligné sur les points du tracé',
    surfaces.length === coords.length &&
    surfaces.slice(0, 4).every((s) => s === 'paved') &&
    surfaces.slice(4, 8).every((s) => s === 'unpaved'),
    surfaces.join(','));

  check('messages absents ou illisibles tolérés',
    surfacesFromMessages(null, coords) === null &&
    surfacesFromMessages([['Foo', 'Bar']], coords) === null);
}

{
  // Le revêtement doit rester aligné après nettoyage des impasses et repli.
  fakeRouter({ deadEnds: true });
  const trimmed = await planRoute({
    start: home, targetDistance: 20000, sport: 'bike', shape: 'loop', bearing: 60, seed: 99,
  });
  check('revêtement toujours aligné après nettoyage',
    trimmed.surfaces?.length === trimmed.coords.length &&
    trimmed.surfaces.includes('unpaved'),
    `${trimmed.coords.length} points`);

  fakeRouter();
  const out = await planRoute({
    start: home, targetDistance: 12000, sport: 'bike', shape: 'outback', bearing: 30, seed: 5,
  });
  const n = out.surfaces.length;
  check('revêtement replié comme la trace',
    n === out.coords.length && [1, 7, 25].every((k) => out.surfaces[k] === out.surfaces[n - 1 - k]),
    `${n} points`);
}

/* ------------------------------------------------------- lien de partage --- */

console.log('\nLien de partage (js/share.js)');

{
  const shared = {
    start: home, vias: [destination(home, 90, 1500)], finish: destination(home, 180, 4000),
    sport: 'run', shape: 'outback',
    terrain: 'trail', goal: 'time', distance: 30, time: 45, speed: 11,
    direction: 'auto', signposted: true, bearing: 137.5, seed: 4242,
  };
  const url = buildShareUrl('https://exemple.app/index.html#ancien', shared);
  const back = parseShareParams(url.split('#')[1]);

  const withChain = buildShareUrl('https://exemple.app/', {
    ...shared, chain: [home, destination(home, 90, 1000), destination(home, 180, 2000)],
  });
  const chainBack = parseShareParams(withChain.split('#')[1]);
  check('tracé retouché transmis tel quel',
    chainBack.chain?.length === 3 && Math.abs(chainBack.chain[2].lat - destination(home, 180, 2000).lat) < 1e-4);
  check('chaîne d’un seul point ignorée',
    parseShareParams('#c=44.9,-0.27')?.chain === undefined);

  check('aller-retour du lien complet',
    Math.abs(back.start.lat - home.lat) < 1e-5 && back.vias.length === 1 &&
    Math.abs(back.finish.lat - shared.finish.lat) < 1e-5 &&
    back.sport === 'run' && back.shape === 'outback' && back.terrain === 'trail' &&
    back.goal === 'time' && back.time === 45 && back.speed === 11 &&
    back.direction === 'auto' && back.signposted === true &&
    back.bearing === 137.5 && back.seed === 4242);

  check('un seul fragment dans l’URL', url.split('#').length === 2);
  check('lien vide ou farfelu ignoré',
    parseShareParams('') === null && parseShareParams('#') === null &&
    parseShareParams('#s=abc,def') === null);
  check('valeurs hors bornes écartées',
    parseShareParams('#s=91,0') === null &&
    parseShareParams('#d=99999')?.distance === undefined &&
    parseShareParams('#sp=vol')?.sport === undefined);
}

console.log(failures ? `\n${failures} test(s) en échec.` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
