// Orchestration : carte, formulaire, génération du parcours et export GPX.

import { cumulativeDistances } from './geo.js';
import { planRoute } from './planner.js';
import { fetchElevationProfile, interpolateElevations } from './elevation.js';
import { buildGpx, downloadGpx, gpxFilename } from './gpx.js';
import { searchAddress, reverseGeocode } from './geocoding.js';
import { listPlaces, savePlace, deletePlace, getPlace, findPlaceNear } from './places.js';
import { setupLayers } from './layers.js';
import { signpostingApplies } from './routing.js';
import { buildShareUrl, parseShareParams } from './share.js';

const STORAGE_KEY = 'findmyway.settings.v1';
const DEFAULT_SPEED = { bike: 25, run: 10 };
const SPORT_LABEL = { bike: 'Vélo', run: 'Course à pied' };
const SEARCH_DELAY = 450; // ms : Nominatim demande de ne pas dépasser 1 requête/s

const state = {
  start: null,
  startLabel: null, // adresse ou nom du lieu correspondant au départ
  sport: 'bike',
  shape: 'loop',
  terrain: 'mixed',
  goal: 'distance',
  bearing: null, // cap retenu pour le tracé courant
  vias: [], // points de passage imposés par l'utilisateur
  addingVia: false,
  signposted: true, // privilégier les itinéraires balisés
  variant: 0,
  seed: null, // graine du tracé courant (partagée dans le lien)
  forced: null, // cap et graine imposés par un lien partagé
  route: null,
  profile: null,
};

const el = {};
let map;
let layers;
let viaMarkers = [];
let startMarker;
let endMarker;
let routeLine;
let controller = null;
let searchController = null;
let searchTimer = null;

function init() {
  cacheDom();
  restoreSettings();
  const shared = applyShared(parseShareParams(location.hash));
  initMap();
  bindEvents();
  refreshPlaces();
  refreshVias();
  updateSignposted();
  updateGoalHint();

  // Un lien partagé contient tout pour retracer le parcours : on le fait.
  if (shared) generate({ newVariant: false });
}

/**
 * Applique l'état reçu par lien de partage, qui l'emporte sur les réglages
 * mémorisés dans le navigateur.
 * @returns {boolean} vrai si le lien décrit un parcours complet à retracer
 */
function applyShared(shared) {
  if (!shared) return false;

  if (shared.start) {
    state.start = shared.start;
    state.startLabel = null;
  }
  if (shared.vias) state.vias = shared.vias;
  if (typeof shared.signposted === 'boolean') state.signposted = shared.signposted;

  if (shared.distance) el.inputDistance.value = shared.distance;
  if (shared.time) el.inputTime.value = shared.time;
  if (shared.speed) el.inputSpeed.value = shared.speed;
  if (shared.direction !== undefined) el.selectDirection.value = String(shared.direction);

  applySegment(el.segSport, shared.sport, (v) => (state.sport = v));
  applySegment(el.segTerrain, shared.terrain, (v) => (state.terrain = v));
  applySegment(el.segShape, shared.shape, (v) => (state.shape = v));
  applySegment(el.segGoal, shared.goal, (v) => {
    state.goal = v;
    el.groupDistance.classList.toggle('is-hidden', v !== 'distance');
    el.groupTime.classList.toggle('is-hidden', v !== 'time');
  });

  if (Number.isFinite(shared.bearing) && Number.isFinite(shared.seed)) {
    state.forced = { bearing: shared.bearing, seed: shared.seed };
  }

  return Boolean(shared.start);
}

function cacheDom() {
  const ids = [
    'map-wrap', 'btn-add-via', 'btn-clear-vias', 'via-list', 'via-count', 'via-hint',
    'seg-terrain', 'terrain-hint', 'btn-share', 'provider',
    'input-signposted', 'signposted-row', 'signposted-hint',
    'input-address', 'address-results', 'btn-save-place', 'save-row', 'input-place-name',
    'btn-save-confirm', 'btn-save-cancel', 'places-row', 'select-place', 'btn-delete-place',
    'panel', 'panel-toggle', 'start-coords', 'btn-locate', 'seg-sport', 'seg-shape',
    'seg-goal', 'group-distance', 'group-time', 'input-distance', 'input-time',
    'input-speed', 'goal-hint', 'select-direction', 'btn-plan', 'btn-variant',
    'status', 'result', 'stat-distance', 'stat-time', 'stat-elevation', 'profile',
    'profile-svg', 'profile-min', 'profile-max', 'btn-gpx',
  ];
  for (const id of ids) el[camel(id)] = document.getElementById(id);
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* ---------------------------------------------------------------- carte --- */

function initMap() {
  const center = state.start ?? { lat: 48.8566, lng: 2.3522 }; // Paris par défaut
  map = L.map('map', { zoomControl: true }).setView([center.lat, center.lng], state.start ? 13 : 11);
  layers = setupLayers(map, state.sport);

  map.on('click', (e) => {
    const point = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (state.addingVia) addVia(point);
    else setStart(point);
  });

  if (state.start) setStart(state.start, { fly: false, label: state.startLabel });
}

function pinIcon(label, variant = '') {
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${variant}">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function setStart(latlng, { fly = true, label = null } = {}) {
  state.start = latlng;
  // Un lieu enregistré au même endroit l'emporte sur l'adresse trouvée.
  state.startLabel = findPlaceNear(latlng)?.name ?? label;

  if (!startMarker) {
    startMarker = L.marker([latlng.lat, latlng.lng], {
      icon: pinIcon('D'),
      draggable: true,
      title: 'Point de départ (déplaçable)',
    }).addTo(map);
    startMarker.on('dragend', () => {
      const p = startMarker.getLatLng();
      setStart({ lat: p.lat, lng: p.lng }, { fly: false });
    });
  } else {
    startMarker.setLatLng([latlng.lat, latlng.lng]);
  }

  if (fly) map.panTo([latlng.lat, latlng.lng]);

  updateStartDisplay();
  hideSaveRow();
  saveSettings();
}

function updateStartDisplay() {
  const { start, startLabel } = state;
  if (!start) return;

  const coords = `${start.lat.toFixed(5)}, ${start.lng.toFixed(5)}`;
  el.startCoords.textContent = startLabel ? `${startLabel} · ${coords}` : coords;
  el.startCoords.classList.add('is-set');
  el.btnPlan.disabled = false;
  el.btnSavePlace.disabled = false;
  syncPlaceSelection();
}

function drawRoute(coords, shape, turnaround) {
  if (routeLine) routeLine.remove();
  const latlngs = coords.map((p) => [p.lat, p.lng]);

  routeLine = L.polyline(latlngs, {
    color: getComputedStyle(document.body).getPropertyValue('--track').trim() || '#f4511e',
    weight: 5,
    opacity: 0.9,
    lineJoin: 'round',
  }).addTo(map);

  if (endMarker) {
    endMarker.remove();
    endMarker = null;
  }
  const endPoint = shape === 'outback' ? turnaround : coords[coords.length - 1];
  if (endPoint && shape !== 'loop') {
    endMarker = L.marker([endPoint.lat, endPoint.lng], {
      icon: pinIcon(shape === 'outback' ? '½' : 'A', 'marker-pin--end'),
      title: shape === 'outback' ? 'Demi-tour' : "Point d'arrivée",
    }).addTo(map);
  }

  startMarker.setZIndexOffset(1000);
  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

/* ------------------------------------------------------ points de passage --- */

function bindVias() {
  el.btnAddVia.addEventListener('click', () => setAddingVia(!state.addingVia));

  el.btnClearVias.addEventListener('click', () => {
    state.vias = [];
    setAddingVia(false);
    refreshVias();
    saveSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.addingVia) setAddingVia(false);
  });
}

function setAddingVia(active) {
  state.addingVia = active;
  el.btnAddVia.classList.toggle('is-active', active);
  el.btnAddVia.textContent = active ? '✓ Terminer' : '📌 Ajouter un point';
  el.mapWrap.classList.toggle('is-adding', active);
  setStatus(active ? 'Clique sur la carte pour ajouter un point de passage.' : '');
}

function addVia(point) {
  state.vias.push(point);
  refreshVias();
  saveSettings();
}

function removeVia(index) {
  state.vias.splice(index, 1);
  refreshVias();
  saveSettings();
}

/** Redessine marqueurs et liste après toute modification des points de passage. */
function refreshVias() {
  for (const marker of viaMarkers) marker.remove();
  viaMarkers = state.vias.map((point, index) => {
    const marker = L.marker([point.lat, point.lng], {
      icon: pinIcon(String(index + 1), 'marker-pin--via'),
      draggable: true,
      title: 'Point de passage (glisser pour déplacer, cliquer pour retirer)',
    }).addTo(map);

    marker.on('dragend', () => {
      const p = marker.getLatLng();
      state.vias[index] = { lat: p.lat, lng: p.lng };
      refreshVias();
      saveSettings();
    });
    marker.on('click', (e) => {
      L.DomEvent.stop(e); // sinon la carte reçoit le clic et déplace le départ
      removeVia(index);
    });
    return marker;
  });

  el.viaList.innerHTML = '';
  for (const [index, point] of state.vias.entries()) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Retirer ce point';
    remove.textContent = '✕';
    remove.addEventListener('click', () => removeVia(index));

    item.append(label, remove);
    el.viaList.append(item);
  }

  const count = state.vias.length;
  el.viaList.classList.toggle('is-hidden', count === 0);
  el.viaCount.textContent = count || '';
  el.btnClearVias.disabled = count === 0;
  el.viaHint.textContent = count
    ? "L'itinéraire passera par ces points, dans l'ordre."
    : "Facultatif : l'itinéraire passera par ces points.";
}

const TERRAIN_HINT = {
  bike: {
    road: 'Goudron et voies roulantes (profil BRouter « fastbike »).',
    mixed: 'Petites routes et bons chemins (profil « trekking »).',
    trail: 'Chemins et pistes non revêtues (profil « gravel »).',
  },
  run: {
    road: 'Bitume, trottoirs et voies piétonnes (OSRM piéton).',
    mixed: 'Chemins de randonnée faciles (BRouter, SAC T1).',
    trail: 'Sentiers, y compris un peu plus rustiques (SAC T2).',
  },
};

/** Aides du terrain et disponibilité de l'option « itinéraires balisés ». */
function updateSignposted() {
  el.terrainHint.textContent = TERRAIN_HINT[state.sport][state.terrain];

  const available = signpostingApplies(state.sport, state.terrain);
  el.inputSignposted.checked = state.signposted;
  el.inputSignposted.disabled = !available;
  el.signpostedRow.classList.toggle('is-disabled', !available);
  el.signpostedHint.textContent = available
    ? state.sport === 'bike'
      ? 'Véloroutes, voies vertes et boucles cyclo signalisées (OSM).'
      : 'Sentiers de randonnée balisés (GR, sentiers de pays).'
    : 'Sans effet sur le profil route.';
}

/* ------------------------------------------------------- adresses & lieux --- */

function bindPlaces() {
  el.inputAddress.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = el.inputAddress.value.trim();
    if (query.length < 3) {
      hideSuggestions();
      return;
    }
    searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY);
  });

  el.inputAddress.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch(el.inputAddress.value.trim());
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) hideSuggestions();
  });

  el.btnSavePlace.addEventListener('click', openSaveRow);
  el.btnSaveCancel.addEventListener('click', hideSaveRow);
  el.btnSaveConfirm.addEventListener('click', confirmSave);
  el.inputPlaceName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSave();
    else if (e.key === 'Escape') hideSaveRow();
  });

  el.selectPlace.addEventListener('change', () => {
    const place = getPlace(el.selectPlace.value);
    if (!place) {
      el.btnDeletePlace.disabled = true;
      return;
    }
    setStart({ lat: place.lat, lng: place.lng }, { fly: false, label: place.name });
    map.setView([place.lat, place.lng], Math.max(map.getZoom(), 13));
    setStatus(`Départ : ${place.name}.`);
  });

  el.btnDeletePlace.addEventListener('click', () => {
    const place = getPlace(el.selectPlace.value);
    if (!place) return;
    if (!window.confirm(`Supprimer le lieu « ${place.name} » ?`)) return;

    deletePlace(place.id);
    if (state.startLabel === place.name) state.startLabel = null;
    refreshPlaces();
    updateStartDisplay();
    setStatus(`Lieu « ${place.name} » supprimé.`);
  });
}

async function runSearch(query) {
  if (query.length < 3) return;

  searchController?.abort();
  searchController = new AbortController();
  renderSuggestions([], 'Recherche…');

  try {
    const results = await searchAddress(query, { signal: searchController.signal });
    renderSuggestions(results, 'Aucun résultat pour cette recherche.');
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderSuggestions([], "Recherche d'adresse indisponible pour le moment.");
  }
}

function renderSuggestions(results, emptyMessage) {
  el.addressResults.innerHTML = '';

  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'sug__empty';
    li.textContent = emptyMessage;
    el.addressResults.append(li);
  } else {
    for (const place of results) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.append(place.label);
      if (place.detail) {
        const detail = document.createElement('span');
        detail.className = 'sug__detail';
        detail.textContent = place.detail;
        button.append(detail);
      }
      button.addEventListener('click', () => {
        setStart({ lat: place.lat, lng: place.lng }, { fly: false, label: place.full });
        map.setView([place.lat, place.lng], 14);
        el.inputAddress.value = place.full;
        hideSuggestions();
      });
      li.append(button);
      el.addressResults.append(li);
    }
  }

  el.addressResults.classList.remove('is-hidden');
}

function hideSuggestions() {
  clearTimeout(searchTimer);
  el.addressResults.classList.add('is-hidden');
  el.addressResults.innerHTML = '';
}

/** Ouvre la ligne d'enregistrement, avec un nom pré-rempli si possible. */
async function openSaveRow() {
  if (!state.start) return;

  const existing = findPlaceNear(state.start);
  el.saveRow.classList.remove('is-hidden');
  el.inputPlaceName.value = existing?.name || state.startLabel || '';
  el.inputPlaceName.focus();
  el.inputPlaceName.select();

  if (el.inputPlaceName.value) return;

  // Sans nom connu, on demande l'adresse la plus proche pour pré-remplir.
  el.inputPlaceName.placeholder = "Recherche de l'adresse…";
  const point = state.start;
  const found = await reverseGeocode(point);
  const stillRelevant = state.start === point && !el.saveRow.classList.contains('is-hidden');
  if (found && stillRelevant && !el.inputPlaceName.value) {
    el.inputPlaceName.value = found.full;
    el.inputPlaceName.select();
  }
  el.inputPlaceName.placeholder = 'Nom du lieu (ex. Domicile)';
}

function hideSaveRow() {
  el.saveRow.classList.add('is-hidden');
  el.inputPlaceName.value = '';
}

function confirmSave() {
  if (!state.start) return;

  const name = el.inputPlaceName.value.trim();
  if (!name) {
    el.inputPlaceName.focus();
    return;
  }

  const place = savePlace({ name, lat: state.start.lat, lng: state.start.lng });
  state.startLabel = place.name;
  hideSaveRow();
  refreshPlaces();
  updateStartDisplay();
  setStatus(`Lieu « ${place.name} » enregistré.`);
}

/** Reconstruit la liste déroulante des lieux enregistrés. */
function refreshPlaces() {
  const places = listPlaces();
  const previous = el.selectPlace.value;

  el.selectPlace.innerHTML = '<option value="">Lieux enregistrés…</option>';
  for (const place of places) {
    const option = document.createElement('option');
    option.value = place.id;
    option.textContent = place.name;
    el.selectPlace.append(option);
  }

  el.placesRow.classList.toggle('is-hidden', places.length === 0);
  el.selectPlace.value = places.some((p) => p.id === previous) ? previous : '';
  syncPlaceSelection();
}

/** Aligne la sélection et l'étoile sur le point de départ courant. */
function syncPlaceSelection() {
  const place = findPlaceNear(state.start);
  el.selectPlace.value = place?.id ?? '';
  el.btnDeletePlace.disabled = !place;
  el.btnSavePlace.textContent = place ? '★' : '☆';
  el.btnSavePlace.classList.toggle('btn--saved', Boolean(place));
  el.btnSavePlace.title = place ? 'Renommer ce lieu' : 'Enregistrer ce lieu';
}

/* ------------------------------------------------------------ formulaire --- */

function bindEvents() {
  bindPlaces();
  bindVias();

  bindSegmented(el.segSport, (value) => {
    state.sport = value;
    el.inputSpeed.value = DEFAULT_SPEED[value];
    updateSignposted();
    layers.followSport(value);
    updateGoalHint();
    saveSettings();
  });

  el.inputSignposted.addEventListener('change', () => {
    state.signposted = el.inputSignposted.checked;
    saveSettings();
  });

  bindSegmented(el.segShape, (value) => {
    state.shape = value;
    saveSettings();
  });

  bindSegmented(el.segTerrain, (value) => {
    state.terrain = value;
    updateSignposted();
    saveSettings();
  });

  bindSegmented(el.segGoal, (value) => {
    state.goal = value;
    el.groupDistance.classList.toggle('is-hidden', value !== 'distance');
    el.groupTime.classList.toggle('is-hidden', value !== 'time');
    updateGoalHint();
    saveSettings();
  });

  for (const input of [el.inputDistance, el.inputTime, el.inputSpeed]) {
    input.addEventListener('input', () => {
      updateGoalHint();
      saveSettings();
    });
  }

  el.selectDirection.addEventListener('change', saveSettings);

  el.btnLocate.addEventListener('click', locate);
  el.btnPlan.addEventListener('click', () => generate({ newVariant: false }));
  el.btnVariant.addEventListener('click', () => generate({ newVariant: true }));
  el.btnGpx.addEventListener('click', exportGpx);
  el.btnShare.addEventListener('click', shareLink);

  el.panelToggle.addEventListener('click', () => {
    el.panel.classList.toggle('is-collapsed');
    setTimeout(() => map.invalidateSize(), 50);
  });

  window.addEventListener('resize', () => map.invalidateSize());
}

function bindSegmented(container, onChange) {
  container.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    for (const b of container.querySelectorAll('button')) {
      const active = b === button;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-checked', String(active));
    }
    onChange(button.dataset.value);
  });
}

function targetDistanceMeters() {
  const speed = Math.max(1, Number(el.inputSpeed.value) || DEFAULT_SPEED[state.sport]);
  if (state.goal === 'distance') return Math.max(500, Number(el.inputDistance.value) * 1000);
  const minutes = Math.max(5, Number(el.inputTime.value) || 60);
  return (minutes / 60) * speed * 1000;
}

function updateGoalHint() {
  const meters = targetDistanceMeters();
  const speed = Math.max(1, Number(el.inputSpeed.value) || DEFAULT_SPEED[state.sport]);
  const minutes = (meters / 1000 / speed) * 60;
  el.goalHint.textContent =
    state.goal === 'distance'
      ? `≈ ${formatDuration(minutes * 60)} à ${speed} km/h`
      : `≈ ${(meters / 1000).toFixed(1)} km à ${speed} km/h`;
}

function locate() {
  if (!navigator.geolocation) {
    setStatus("La géolocalisation n'est pas disponible sur cet appareil.", true);
    return;
  }
  setStatus('Localisation en cours…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      map.setView([pos.coords.latitude, pos.coords.longitude], 14);
      setStatus('');
    },
    () => setStatus("Impossible de récupérer ta position (autorisation refusée ?).", true)
  );
}

/* -------------------------------------------------------------- tracé ----- */

async function generate({ newVariant }) {
  if (!state.start) {
    setStatus('Place d’abord un point de départ sur la carte.', true);
    return;
  }

  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  setBusy(true);
  el.result.classList.add('is-hidden');

  const chosen = el.selectDirection.value;
  if (newVariant) {
    state.variant += 1;
  } else {
    state.variant = Math.floor(Math.random() * 1000);
  }

  // Un lien partagé impose cap et graine, une seule fois : on doit retrouver
  // exactement le tracé de l'expéditeur.
  const forced = newVariant ? null : state.forced;
  state.forced = null;

  if (forced) {
    state.bearing = forced.bearing;
  } else if (chosen === 'auto') {
    // Direction aléatoire, puis rotation par l'angle d'or pour varier.
    state.bearing =
      newVariant && state.bearing != null
        ? (state.bearing + 137.5) % 360
        : Math.random() * 360;
  } else {
    const base = Number(chosen);
    state.bearing = newVariant ? base + ((state.variant % 5) - 2) * 12 : base;
  }

  state.seed = forced?.seed ?? state.variant * 7919 + 13;

  const targetDistance = targetDistanceMeters();

  try {
    const result = await planRoute({
      start: state.start,
      targetDistance,
      sport: state.sport,
      shape: state.shape,
      bearing: state.bearing,
      vias: state.vias,
      terrain: state.terrain,
      preferSignposted: state.signposted && signpostingApplies(state.sport, state.terrain),
      seed: state.seed,
      onProgress: (msg) => setStatus(msg),
      signal,
    });

    state.route = result;
    drawRoute(result.coords, state.shape, result.turnaround);
    const summary = showResult(result, targetDistance);

    setStatus('Récupération du profil altimétrique…');
    state.profile = await fetchElevationProfile(result.coords, { signal });
    renderElevation(state.profile);
    setStatus(summary);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus(err.message || "Le calcul de l'itinéraire a échoué.", true);
  } finally {
    if (!signal.aborted) setBusy(false);
  }
}

function showResult(result, targetDistance) {
  const speed = Math.max(1, Number(el.inputSpeed.value) || DEFAULT_SPEED[state.sport]);
  const seconds = (result.distance / 1000 / speed) * 3600;

  el.statDistance.textContent = `${(result.distance / 1000).toFixed(1)} km`;
  el.statTime.textContent = formatDuration(seconds);
  el.statElevation.textContent = '…';
  el.profile.classList.add('is-hidden');
  el.result.classList.remove('is-hidden');
  el.btnVariant.disabled = false;

  const tuned = result.tuned ? ' réglé' : '';
  el.provider.textContent = `tracé par ${result.provider} · profil ${result.profile}${tuned}`;

  // Les points de passage imposent un plancher : le dire plutôt que parler d'écart.
  if (result.minimal) {
    return `Tes points de passage imposent déjà ${(result.distance / 1000).toFixed(1)} km,` +
      " soit plus que l'objectif.";
  }

  // On ne signale l'écart que s'il dépasse nettement la tolérance de calibration.
  const gap = (result.distance - targetDistance) / 1000;
  return Math.abs(result.distance - targetDistance) / targetDistance > 0.05
    ? `Écart de ${gap > 0 ? '+' : ''}${gap.toFixed(1)} km avec l'objectif : essaie une autre variante.`
    : '';
}

function renderElevation(profile) {
  if (!profile) {
    el.statElevation.textContent = 'n/d';
    return;
  }

  el.statElevation.textContent = `${Math.round(profile.gain)} m`;

  const { distances, elevations } = profile;
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const span = Math.max(10, max - min);
  const total = distances[distances.length - 1] || 1;
  const W = 300;
  const H = 90;

  const points = elevations.map((e, i) => {
    const x = (distances[i] / total) * W;
    const y = H - 6 - ((e - min) / span) * (H - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#f4511e';
  el.profileSvg.innerHTML =
    `<polygon points="0,${H} ${points.join(' ')} ${W},${H}" fill="${accent}" opacity="0.18" />` +
    `<polyline points="${points.join(' ')}" fill="none" stroke="${accent}" stroke-width="1.6" ` +
    `vector-effect="non-scaling-stroke" stroke-linejoin="round" />`;

  el.profileMin.textContent = `${Math.round(min)} m`;
  el.profileMax.textContent = `${Math.round(max)} m`;
  el.profile.classList.remove('is-hidden');
}

/** Copie un lien reproduisant exactement le parcours affiché. */
async function shareLink() {
  const url = buildShareUrl(location.href, {
    start: state.start,
    vias: state.vias,
    sport: state.sport,
    shape: state.shape,
    terrain: state.terrain,
    goal: state.goal,
    distance: el.inputDistance.value,
    time: el.inputTime.value,
    speed: el.inputSpeed.value,
    direction: el.selectDirection.value,
    signposted: state.signposted,
    bearing: state.bearing,
    seed: state.seed,
  });

  history.replaceState(null, '', url);

  try {
    await navigator.clipboard.writeText(url);
    setStatus('Lien du parcours copié dans le presse-papiers.');
  } catch {
    // Presse-papiers refusé (contexte non sécurisé, permission) : on montre l'URL.
    window.prompt('Copie ce lien pour partager le parcours :', url);
  }
}

function exportGpx() {
  if (!state.route) return;
  const coords = state.route.coords;

  let elevations;
  if (state.profile) {
    elevations = interpolateElevations(cumulativeDistances(coords), state.profile);
  }

  const label = SPORT_LABEL[state.sport];
  const name = `${label} — ${(state.route.distance / 1000).toFixed(1)} km`;
  downloadGpx(buildGpx(coords, { name, elevations }), gpxFilename(label, state.route.distance));
}

/* ------------------------------------------------------------- helpers ---- */

function setBusy(busy) {
  el.btnPlan.disabled = busy || !state.start;
  el.btnVariant.disabled = busy || !state.route;
  el.btnPlan.textContent = busy ? 'Calcul…' : "Tracer l'itinéraire";
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('is-error', isError);
}

function formatDuration(seconds) {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

/* ------------------------------------------------------------ stockage ---- */

function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        start: state.start,
        startLabel: state.startLabel,
        vias: state.vias,
        signposted: state.signposted,
        terrain: state.terrain,
        sport: state.sport,
        shape: state.shape,
        goal: state.goal,
        distance: el.inputDistance.value,
        time: el.inputTime.value,
        speed: el.inputSpeed.value,
        direction: el.selectDirection.value,
      })
    );
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}

function restoreSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;

  if (saved.start?.lat != null) {
    state.start = saved.start;
    state.startLabel = saved.startLabel ?? null;
  }
  if (Array.isArray(saved.vias)) {
    state.vias = saved.vias.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  }
  if (typeof saved.signposted === 'boolean') state.signposted = saved.signposted;
  if (saved.distance) el.inputDistance.value = saved.distance;
  if (saved.time) el.inputTime.value = saved.time;
  if (saved.speed) el.inputSpeed.value = saved.speed;
  if (saved.direction) el.selectDirection.value = saved.direction;

  applySegment(el.segSport, saved.sport, (v) => (state.sport = v));
  applySegment(el.segShape, saved.shape, (v) => (state.shape = v));
  applySegment(el.segTerrain, saved.terrain, (v) => (state.terrain = v));
  applySegment(el.segGoal, saved.goal, (v) => {
    state.goal = v;
    el.groupDistance.classList.toggle('is-hidden', v !== 'distance');
    el.groupTime.classList.toggle('is-hidden', v !== 'time');
  });
}

function applySegment(container, value, apply) {
  if (!value) return;
  const button = container.querySelector(`button[data-value="${value}"]`);
  if (!button) return;
  for (const b of container.querySelectorAll('button')) {
    const active = b === button;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-checked', String(active));
  }
  apply(value);
}

init();
