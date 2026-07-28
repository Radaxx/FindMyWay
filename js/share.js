// Lien de partage : tout l'état utile tient dans le fragment de l'URL, donc
// rien n'est envoyé au serveur. Le cap et la graine sont inclus pour que le
// destinataire retrouve exactement le même tracé, et pas seulement les mêmes
// réglages.
//
// Le nom du lieu de départ n'est volontairement pas partagé : « Domicile » et
// ses coordonnées n'ont pas à voyager ensemble.

const SPORTS = ['bike', 'run'];
const SHAPES = ['loop', 'outback', 'oneway'];
const TERRAINS = ['road', 'mixed', 'trail'];
const GOALS = ['distance', 'time'];

const coord = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * @param {string} baseUrl  URL de la page, sans fragment
 * @param {object} state
 * @returns {string}
 */
export function buildShareUrl(baseUrl, state) {
  const params = new URLSearchParams();

  if (state.start) params.set('s', coord(state.start));
  if (state.vias?.length) params.set('w', state.vias.map(coord).join(';'));
  if (state.finish) params.set('e', coord(state.finish));

  params.set('sp', state.sport);
  params.set('sh', state.shape);
  params.set('tr', state.terrain);
  params.set('g', state.goal);
  params.set('d', String(state.distance));
  params.set('t', String(state.time));
  params.set('v', String(state.speed));
  params.set('dir', String(state.direction));
  params.set('sg', state.signposted ? '1' : '0');

  // Reproduire le tracé exact, pas seulement les réglages.
  if (Number.isFinite(state.bearing)) params.set('b', state.bearing.toFixed(1));
  if (Number.isFinite(state.seed)) params.set('sd', String(state.seed));

  return `${baseUrl.split('#')[0]}#${params.toString()}`;
}

/**
 * Lit un fragment d'URL partagé. Tout ce qui est absent ou invalide est
 * simplement ignoré : un lien tronqué ne doit pas casser l'application.
 *
 * @param {string} hash
 * @returns {object | null} état partiel, ou null si le lien ne contient rien
 */
export function parseShareParams(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const state = {};

  const start = parsePoint(params.get('s'));
  if (start) state.start = start;

  const vias = (params.get('w') || '')
    .split(';')
    .map(parsePoint)
    .filter(Boolean);
  if (vias.length) state.vias = vias;

  const finish = parsePoint(params.get('e'));
  if (finish) state.finish = finish;

  pickEnum(state, 'sport', params.get('sp'), SPORTS);
  pickEnum(state, 'shape', params.get('sh'), SHAPES);
  pickEnum(state, 'terrain', params.get('tr'), TERRAINS);
  pickEnum(state, 'goal', params.get('g'), GOALS);

  pickNumber(state, 'distance', params.get('d'), 0.5, 500);
  pickNumber(state, 'time', params.get('t'), 5, 1440);
  pickNumber(state, 'speed', params.get('v'), 1, 60);
  pickNumber(state, 'bearing', params.get('b'), 0, 360);
  pickNumber(state, 'seed', params.get('sd'), 0, Number.MAX_SAFE_INTEGER);

  const direction = params.get('dir');
  if (direction === 'auto') state.direction = 'auto';
  else pickNumber(state, 'direction', direction, 0, 360);

  const signposted = params.get('sg');
  if (signposted === '0' || signposted === '1') state.signposted = signposted === '1';

  return Object.keys(state).length ? state : null;
}

function parsePoint(value) {
  if (!value) return null;
  const [lat, lng] = String(value).split(',').map(Number);
  const valid =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return valid ? { lat, lng } : null;
}

function pickEnum(state, key, value, allowed) {
  if (allowed.includes(value)) state[key] = value;
}

function pickNumber(state, key, value, min, max) {
  const parsed = Number(value);
  if (value !== null && value !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
    state[key] = parsed;
  }
}
