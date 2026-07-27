// Calcul d'itinéraires via des services publics et gratuits (aucune clé requise).
//
// Fournisseur principal : instances OSRM de la FOSSGIS (profils vélo / piéton).
// Repli : BRouter, si OSRM est indisponible.
//
// Ces serveurs sont mis à disposition par la communauté OpenStreetMap : usage
// raisonnable uniquement (l'application enchaîne au maximum quelques requêtes
// par tracé).

const OSRM_PROFILE = { bike: 'routed-bike', run: 'routed-foot' };
const BROUTER_PROFILE = { bike: 'trekking', run: 'hiking-beta' };

class RoutingError extends Error {}

/**
 * Calcule un itinéraire passant par `points` ([{lat, lng}, ...]).
 * @returns {Promise<{coords: {lat,lng}[], distance: number, duration: number, provider: string}>}
 */
export async function route(points, sport, { signal } = {}) {
  if (points.length < 2) throw new RoutingError('Il faut au moins deux points.');

  try {
    return await routeOsrm(points, sport, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Repli : un second fournisseur évite d'être bloqué par une panne ponctuelle.
    try {
      return await routeBrouter(points, sport, signal);
    } catch (fallbackErr) {
      if (fallbackErr.name === 'AbortError') throw fallbackErr;
      throw err instanceof RoutingError ? err : fallbackErr;
    }
  }
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

async function routeBrouter(points, sport, signal) {
  const lonlats = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `https://brouter.de/brouter?lonlats=${lonlats}` +
    `&profile=${BROUTER_PROFILE[sport]}&alternativeidx=0&format=geojson`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`BRouter: HTTP ${res.status}`);
  const data = await res.json();

  const feature = data.features?.[0];
  if (!feature) throw new RoutingError("Aucun itinéraire n'a pu être calculé.");

  const props = feature.properties || {};
  return {
    coords: feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    distance: Number(props['track-length']) || 0,
    duration: Number(props['total-time']) || 0,
    provider: 'BRouter',
  };
}

function messageForOsrmCode(code) {
  switch (code) {
    case 'NoSegment':
      return "Aucune route praticable à proximité du départ. Déplace le point de départ.";
    case 'NoRoute':
      return "Impossible de relier les points : essaie une autre direction ou une distance plus courte.";
    default:
      return "Le service de routage n'a pas pu calculer d'itinéraire.";
  }
}

export { RoutingError };
