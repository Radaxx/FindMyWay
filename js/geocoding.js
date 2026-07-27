// Recherche d'adresse (et recherche inverse) via Nominatim, le géocodeur
// d'OpenStreetMap : gratuit, sans clé, mais limité à ~1 requête/seconde.
// Les appels sont donc temporisés côté interface (saisie débouncée).

const BASE = 'https://nominatim.openstreetmap.org';
const COMMON = 'format=jsonv2&addressdetails=1&accept-language=fr';

/**
 * @returns {Promise<{label: string, detail: string, lat: number, lng: number}[]>}
 */
export async function searchAddress(query, { signal, limit = 5 } = {}) {
  const q = query.trim();
  if (q.length < 3) return [];

  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}&${COMMON}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('La recherche d’adresse a échoué.');

  const items = await res.json();
  return items.map(toPlace);
}

/** Adresse la plus proche d'un point (utilisée pour nommer un lieu enregistré). */
export async function reverseGeocode({ lat, lng }, { signal } = {}) {
  try {
    const res = await fetch(
      `${BASE}/reverse?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&zoom=18&${COMMON}`,
      { signal, headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const item = await res.json();
    return item?.lat ? toPlace(item) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null; // best-effort : l'utilisateur pourra nommer le lieu à la main
  }
}

function toPlace(item) {
  const a = item.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  const parts = item.display_name ? item.display_name.split(', ') : [];

  const label = street || a.hamlet || a.suburb || parts[0] || 'Lieu';
  const detail = [city, a.postcode, a.country].filter(Boolean).join(', ') ||
    parts.slice(1).join(', ');

  return {
    label,
    detail,
    full: [label, city].filter(Boolean).join(', ') || item.display_name || label,
    lat: Number(item.lat),
    lng: Number(item.lon),
  };
}
