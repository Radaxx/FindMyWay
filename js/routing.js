// Calcul d'itinéraires via des services publics et gratuits (aucune clé requise).
//
// Fournisseur principal : BRouter, dont les profils vélo pondèrent les
// itinéraires cyclables balisés d'OpenStreetMap (relations route=bicycle,
// réseaux icn/ncn/rcn/lcn) — c'est ce qui rapproche le tracé des parcours
// réellement empruntés.
// Repli : les instances OSRM de la FOSSGIS (profils vélo / piéton).
//
// Ces serveurs sont mis à disposition par la communauté OpenStreetMap : usage
// raisonnable uniquement (l'application enchaîne au maximum quelques requêtes
// par tracé).

const BROUTER = 'https://brouter.de/brouter';
const BROUTER_PROFILE = { bike: 'trekking', run: 'hiking-beta' };
const OSRM_PROFILE = { bike: 'routed-bike', run: 'routed-foot' };

class RoutingError extends Error {}

/** Profil « itinéraires balisés » téléversé une fois par session. */
let signpostedProfile = null;

/**
 * Calcule un itinéraire passant par `points` ([{lat, lng}, ...]).
 * @param {{lat:number,lng:number}[]} points
 * @param {'bike'|'run'} sport
 * @param {{signal?: AbortSignal, preferSignposted?: boolean}} [options]
 * @returns {Promise<{coords: {lat,lng}[], distance: number, duration: number, provider: string}>}
 */
export async function route(points, sport, { signal, preferSignposted = false } = {}) {
  if (points.length < 2) throw new RoutingError('Il faut au moins deux points.');

  const fallbackProfile = BROUTER_PROFILE[sport];
  const profile = preferSignposted
    ? await signpostedProfileId(sport, signal) ?? fallbackProfile
    : fallbackProfile;

  try {
    return await routeBrouter(points, profile, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;

    // Le profil personnalisé peut avoir expiré côté serveur : on retente avec
    // le profil standard avant de changer complètement de fournisseur.
    if (profile !== fallbackProfile) {
      signpostedProfile = null;
      try {
        return await routeBrouter(points, fallbackProfile, signal);
      } catch (retryErr) {
        if (retryErr.name === 'AbortError') throw retryErr;
      }
    }

    try {
      return await routeOsrm(points, sport, signal);
    } catch (fallbackErr) {
      if (fallbackErr.name === 'AbortError') throw fallbackErr;
      throw err instanceof RoutingError ? err : fallbackErr;
    }
  }
}

async function routeBrouter(points, profile, signal) {
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
  return {
    coords: feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    distance: Number(props['track-length']) || 0,
    duration: Number(props['total-time']) || 0,
    provider: 'BRouter',
  };
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
  };
}

/* -------------------------------------------- profil « itinéraires balisés » --- */

/**
 * Le profil `trekking` de BRouter n'a qu'une préférence modérée pour les
 * itinéraires cyclables. Son paramètre `stick_to_cycleroutes` la rend
 * franchement contraignante, mais BRouter ne sait pas recevoir de paramètre
 * dans l'URL : il faut lui téléverser une variante du profil et réutiliser
 * l'identifiant renvoyé.
 *
 * Tout est best-effort : au moindre accroc on renvoie null, et l'appelant
 * retombe sur le profil standard.
 *
 * @returns {Promise<string | null>}
 */
async function signpostedProfileId(sport, signal) {
  if (sport !== 'bike') return null; // seuls les profils vélo exposent ce réglage
  if (!signpostedProfile) signpostedProfile = uploadSignpostedProfile(signal);

  try {
    return await signpostedProfile;
  } catch {
    signpostedProfile = Promise.resolve(null);
    return null;
  }
}

async function uploadSignpostedProfile(signal) {
  try {
    const res = await fetch(`${BROUTER}/profiles2/${BROUTER_PROFILE.bike}.brf`, { signal });
    if (!res.ok) return null;

    const patched = stickToCycleRoutes(await res.text());
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
 * Bascule `stick_to_cycleroutes` à true dans un profil BRouter.
 * @returns {string | null} le profil modifié, ou null si le paramètre est absent
 */
export function stickToCycleRoutes(profileText) {
  const pattern = /^(\s*assign\s+stick_to_cycleroutes\s+)(\S+)/m;
  if (!pattern.test(profileText)) return null;
  return profileText.replace(pattern, '$1true');
}

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
