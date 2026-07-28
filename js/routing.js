// Calcul d'itinéraires via des services publics et gratuits (aucune clé requise).
//
// Fournisseur principal : BRouter, dont les profils décrivent finement le
// terrain (goudron, mixte, chemins) et pondèrent les itinéraires balisés
// d'OpenStreetMap. Repli : les instances OSRM de la FOSSGIS.
//
// BRouter n'accepte pas de paramètre de profil dans l'URL : pour régler un
// profil, il faut récupérer son texte, y modifier les lignes `assign`, le
// téléverser et réutiliser l'identifiant renvoyé. Tout est best-effort — au
// moindre accroc on retombe sur le profil standard, puis sur OSRM.

const BROUTER = 'https://brouter.de/brouter';
const OSRM_PROFILE = { bike: 'routed-bike', run: 'routed-foot' };

class RoutingError extends Error {}

/** Profils personnalisés déjà téléversés, par clé profil+paramètres. */
const uploaded = new Map();

/**
 * Fournisseurs à essayer, dans l'ordre, pour une activité et un terrain donnés.
 *
 * Côté vélo, BRouter a un profil par usage. Côté course à pied, seul
 * `hiking-mountain` existe : réglé sur SAC T1 il convient à la course sur
 * chemins, mais pour le bitume l'instance piétonne d'OSRM reste plus adaptée.
 *
 * @param {'bike'|'run'} sport
 * @param {'road'|'mixed'|'trail'} terrain
 * @param {boolean} signposted  privilégier les itinéraires balisés
 */
export function resolveProviders(sport, terrain = 'mixed', signposted = false) {
  const osrm = { provider: 'osrm' };

  if (sport === 'run') {
    const hiking = {
      provider: 'brouter',
      profile: 'hiking-mountain',
      params: {
        // T1 = sentier de randonnée balisé ; T2 tolère un peu plus rustique.
        SAC_scale_limit: terrain === 'trail' ? 2 : 1,
        SAC_scale_preferred: 1,
        ...(signposted ? { hiking_routes_preference: 1.0 } : {}),
      },
    };
    return terrain === 'road' ? [osrm, hiking] : [hiking, osrm];
  }

  const bike = {
    road: { profile: 'fastbike', params: {} },
    mixed: {
      profile: 'trekking',
      params: signposted ? { stick_to_cycleroutes: true } : {},
    },
    trail: {
      profile: 'gravel',
      params: {
        prefer_unpaved_paths: true,
        ...(signposted ? { prefer_cycle_routes: true } : {}),
      },
    },
  }[terrain] ?? { profile: 'trekking', params: {} };

  return [{ provider: 'brouter', ...bike }, osrm];
}

/** L'option « itinéraires balisés » a-t-elle un effet sur ce profil ? */
export function signpostingApplies(sport, terrain) {
  return !(sport === 'bike' && terrain === 'road'); // fastbike n'expose aucun réglage
}

/**
 * Calcule un itinéraire passant par `points` ([{lat, lng}, ...]).
 * @returns {Promise<{coords: {lat,lng}[], distance: number, duration: number,
 *                    provider: string, profile?: string, tuned?: boolean}>}
 */
export async function route(points, sport, options = {}) {
  if (points.length < 2) throw new RoutingError('Il faut au moins deux points.');

  const { signal, terrain = 'mixed', preferSignposted = false } = options;
  const steps = resolveProviders(sport, terrain, preferSignposted);
  let firstError = null;

  for (const step of steps) {
    try {
      return step.provider === 'osrm'
        ? await routeOsrm(points, sport, signal)
        : await routeBrouter(points, step, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      firstError ??= err;
    }
  }

  throw firstError ?? new RoutingError("Aucun itinéraire n'a pu être calculé.");
}

async function routeBrouter(points, step, signal) {
  const tuned = await tunedProfileId(step, signal);
  const profile = tuned ?? step.profile;

  const lonlats = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}` +
    '&alternativeidx=0&format=geojson';

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`BRouter: HTTP ${res.status}`);

  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates?.length) {
    throw new RoutingError("Aucun itinéraire n'a pu être calculé depuis ce point.");
  }

  const props = feature.properties || {};
  const coords = feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

  return {
    coords,
    surfaces: surfacesFromMessages(props.messages, coords),
    distance: Number(props['track-length']) || 0,
    duration: Number(props['total-time']) || 0,
    provider: 'BRouter',
    profile: step.profile,
    tuned: Boolean(tuned),
  };
}

/* ------------------------------------------------------------ revêtement --- */

// Revêtements explicitement durs / meubles, d'après le tag `surface` d'OSM.
const PAVED_SURFACE = /^(asphalt|concrete|concrete:.*|paved|paving_stones|sett|cobblestone|metal|wood|chipseal)$/;
const UNPAVED_SURFACE = /^(unpaved|gravel|fine_gravel|compacted|ground|dirt|earth|grass|grass_paver|sand|mud|pebblestone|woodchips|rock|stones?)$/;
// Voies présumées non revêtues en l'absence de tag `surface`.
const UNPAVED_HIGHWAY = /^(track|path|bridleway)$/;

/**
 * Classe chaque point du tracé en « route » ou « chemin ».
 *
 * BRouter joint à sa réponse un tableau `messages` : une ligne par tronçon,
 * avec les tags OSM de la voie empruntée et la position de sa fin. On parcourt
 * la trace en même temps que ces messages pour étiqueter chaque point.
 *
 * @returns {('paved'|'unpaved')[] | null} null si l'information manque
 */
export function surfacesFromMessages(messages, coords) {
  if (!Array.isArray(messages) || messages.length < 2 || !coords.length) return null;

  const header = messages[0].map((h) => String(h).trim());
  const lngAt = header.indexOf('Longitude');
  const latAt = header.indexOf('Latitude');
  const tagsAt = header.indexOf('WayTags');
  if (lngAt < 0 || latAt < 0 || tagsAt < 0) return null;

  const surfaces = new Array(coords.length).fill('paved');
  let cursor = 0;

  for (let row = 1; row < messages.length; row++) {
    const message = messages[row];
    const end = { lat: toDegrees(message[latAt]), lng: toDegrees(message[lngAt]) };
    if (!Number.isFinite(end.lat) || !Number.isFinite(end.lng)) continue;

    const kind = classifySurface(message[tagsAt]);
    const endIndex = indexOfPoint(coords, end, cursor);

    // Convention : un point porte le revêtement du segment qui y arrive, donc
    // le point de jonction reste rattaché à la voie précédente.
    for (let i = cursor === 0 ? 0 : cursor + 1; i <= endIndex; i++) surfaces[i] = kind;
    cursor = endIndex;
  }

  for (let i = cursor + 1; i < coords.length; i++) surfaces[i] = surfaces[cursor];
  return surfaces;
}

/** BRouter exprime ses coordonnées en microdegrés dans les messages. */
function toDegrees(value) {
  const n = Number(value);
  return Math.abs(n) > 180 ? n / 1e6 : n;
}

/** Premier point de la trace correspondant à `target`, à partir de `from`. */
function indexOfPoint(coords, target, from) {
  let best = from;
  let bestGap = Infinity;

  for (let i = from; i < coords.length; i++) {
    const gap = Math.abs(coords[i].lat - target.lat) + Math.abs(coords[i].lng - target.lng);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
      if (gap < 1e-6) break; // le point du message est un point de la trace
    }
  }
  return best;
}

/** @param {string} wayTags  ex. « highway=track surface=gravel tracktype=grade3 » */
export function classifySurface(wayTags) {
  const tags = {};
  for (const pair of String(wayTags || '').trim().split(/\s+/)) {
    const at = pair.indexOf('=');
    if (at > 0) tags[pair.slice(0, at)] = pair.slice(at + 1);
  }

  if (tags.surface) {
    if (UNPAVED_SURFACE.test(tags.surface)) return 'unpaved';
    if (PAVED_SURFACE.test(tags.surface)) return 'paved';
  }
  if (tags.tracktype && tags.tracktype !== 'grade1') return 'unpaved';
  if (UNPAVED_HIGHWAY.test(tags.highway || '')) return 'unpaved';

  return 'paved'; // en Europe, une voie nommée sans tag de surface est goudronnée
}

async function routeOsrm(points, sport, signal) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url =
    `https://routing.openstreetmap.de/${OSRM_PROFILE[sport]}/route/v1/driving/${coords}` +
    '?overview=full&geometries=geojson&continue_straight=false';

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OSRM: HTTP ${res.status}`);
  const data = await res.json();

  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new RoutingError(messageForOsrmCode(data.code));
  }

  const r = data.routes[0];
  return {
    coords: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    distance: r.distance,
    duration: r.duration,
    provider: 'OSRM',
    profile: OSRM_PROFILE[sport],
  };
}

/* ----------------------------------------------------- profils personnalisés --- */

/** Identifiant du profil réglé, ou null pour utiliser le profil standard. */
async function tunedProfileId({ profile, params }, signal) {
  if (!params || !Object.keys(params).length) return null;

  const key = `${profile}|${JSON.stringify(params)}`;
  if (!uploaded.has(key)) uploaded.set(key, uploadTunedProfile(profile, params, signal));

  try {
    return await uploaded.get(key);
  } catch {
    uploaded.set(key, Promise.resolve(null));
    return null;
  }
}

async function uploadTunedProfile(profile, params, signal) {
  try {
    const res = await fetch(`${BROUTER}/profiles2/${profile}.brf`, { signal });
    if (!res.ok) return null;

    const patched = applyProfileParams(await res.text(), params);
    if (!patched) return null;

    const upload = await fetch(`${BROUTER}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: patched,
      signal,
    });
    if (!upload.ok) return null;

    const data = await upload.json();
    return data.error || !data.profileid ? null : data.profileid;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}

/**
 * Remplace la valeur des paramètres `assign` d'un profil BRouter. Les lignes
 * s'écrivent indifféremment `assign nom valeur` ou `assign nom = valeur`.
 *
 * @returns {string | null} le profil modifié, ou null si aucun paramètre
 *          demandé n'existe dans ce profil (rien à téléverser)
 */
export function applyProfileParams(profileText, params) {
  let text = profileText;
  let applied = 0;

  for (const [name, value] of Object.entries(params)) {
    const pattern = new RegExp(`^(\\s*assign\\s+${escapeName(name)}\\s*=?\\s*)(\\S+)`, 'm');
    if (!pattern.test(text)) continue;
    text = text.replace(pattern, `$1${value}`);
    applied++;
  }

  return applied ? text : null;
}

const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function messageForOsrmCode(code) {
  switch (code) {
    case 'NoSegment':
      return 'Aucune route praticable à proximité du départ. Déplace le point de départ.';
    case 'NoRoute':
      return "Impossible de relier les points : essaie une autre direction ou une distance plus courte.";
    default:
      return "Le service de routage n'a pas pu calculer d'itinéraire.";
  }
}

export { RoutingError };
