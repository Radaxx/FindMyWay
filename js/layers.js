// Fonds de carte et calques « itinéraires populaires ».
//
// Les calques Waymarked Trails affichent les itinéraires balisés d'OSM
// (véloroutes, voies vertes, GR et sentiers de pays) ; le calque des traces GPS
// publiques montre, plus grossièrement, où les contributeurs sont réellement
// passés. Les deux aident à juger si un tracé colle aux parcours fréquentés.

const STORAGE_KEY = 'findmyway.layers.v1';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const OVERLAY_FOR_SPORT = { bike: 'cycling', run: 'hiking' };

/**
 * Installe fonds de carte, calques et contrôle Leaflet.
 * @returns {{ followSport: (sport: string) => void }}
 */
export function setupLayers(map, initialSport) {
  const bases = {
    'Carte OSM': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
    }),
    'CyclOSM (vélo)': L.tileLayer(
      'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        subdomains: 'abc',
        attribution: `${OSM_ATTRIBUTION} · <a href="https://www.cyclosm.org/">CyclOSM</a>`,
      }
    ),
  };

  const overlays = {
    cycling: {
      label: 'Itinéraires cyclables balisés',
      layer: L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', {
        maxZoom: 18,
        opacity: 0.7,
        attribution:
          '<a href="https://cycling.waymarkedtrails.org/">Waymarked Trails</a> © Sarah Hoffmann (CC-BY-SA)',
      }),
    },
    hiking: {
      label: 'Sentiers balisés (rando / trail)',
      layer: L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
        maxZoom: 18,
        opacity: 0.7,
        attribution:
          '<a href="https://hiking.waymarkedtrails.org/">Waymarked Trails</a> © Sarah Hoffmann (CC-BY-SA)',
      }),
    },
    traces: {
      label: 'Traces GPS publiques',
      layer: L.tileLayer('https://gps-{s}.tile.openstreetmap.org/lines/{z}/{x}/{y}.png', {
        maxZoom: 20,
        subdomains: 'abc',
        opacity: 0.6,
        attribution: `traces GPS ${OSM_ATTRIBUTION}`,
      }),
    },
  };

  const saved = readSettings();
  let userChoice = saved?.touched === true;
  let applying = false; // évite de prendre nos propres bascules pour un choix

  (bases[saved?.base] ?? bases['Carte OSM']).addTo(map);

  const active = new Set(
    userChoice && Array.isArray(saved.overlays)
      ? saved.overlays.filter((id) => id in overlays)
      : [OVERLAY_FOR_SPORT[initialSport]]
  );
  for (const id of active) overlays[id].layer.addTo(map);

  const control = {};
  for (const [id, { label, layer }] of Object.entries(overlays)) control[label] = layer;
  L.control.layers(bases, control, { position: 'topright' }).addTo(map);

  const idOf = (layer) => Object.keys(overlays).find((id) => overlays[id].layer === layer);

  const persist = () => {
    const base = Object.keys(bases).find((name) => map.hasLayer(bases[name]));
    write({ base, overlays: [...active], touched: userChoice });
  };

  map.on('overlayadd overlayremove', (e) => {
    const id = idOf(e.layer);
    if (!id) return;
    if (e.type === 'overlayadd') active.add(id);
    else active.delete(id);
    if (!applying) userChoice = true; // l'utilisateur a pris la main
    persist();
  });

  map.on('baselayerchange', persist);

  return {
    /** Suit l'activité choisie, tant que l'utilisateur n'a pas fait son propre choix. */
    followSport(sport) {
      if (userChoice) return;
      applying = true;
      for (const [id, { layer }] of Object.entries(overlays)) {
        const wanted = id === OVERLAY_FOR_SPORT[sport];
        if (wanted && !map.hasLayer(layer)) layer.addTo(map);
        else if (!wanted && map.hasLayer(layer)) map.removeLayer(layer);
      }
      applying = false;
      persist();
    },
  };
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function write(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}
