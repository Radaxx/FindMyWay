// Orchestration : carte, formulaire, génération du parcours et export GPX.

import { cumulativeDistances } from './geo.js';
import { planRoute } from './planner.js';
import { fetchElevationProfile, interpolateElevations } from './elevation.js';
import { buildGpx, downloadGpx, gpxFilename } from './gpx.js';

const STORAGE_KEY = 'findmyway.settings.v1';
const DEFAULT_SPEED = { bike: 25, run: 10 };
const SPORT_LABEL = { bike: 'Vélo', run: 'Course à pied' };

const state = {
  start: null,
  sport: 'bike',
  shape: 'loop',
  goal: 'distance',
  bearing: null, // cap retenu pour le tracé courant
  variant: 0,
  route: null,
  profile: null,
};

const el = {};
let map;
let startMarker;
let endMarker;
let routeLine;
let controller = null;

function init() {
  cacheDom();
  restoreSettings();
  initMap();
  bindEvents();
  updateGoalHint();
}

function cacheDom() {
  const ids = [
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

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on('click', (e) => setStart({ lat: e.latlng.lat, lng: e.latlng.lng }));
  if (state.start) setStart(state.start, { fly: false });
}

function pinIcon(label, variant = '') {
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${variant}">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function setStart(latlng, { fly = true } = {}) {
  state.start = latlng;

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

  el.startCoords.textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  el.startCoords.classList.add('is-set');
  el.btnPlan.disabled = false;
  saveSettings();
}

function drawRoute(coords, shape) {
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
  if (shape === 'oneway') {
    const last = coords[coords.length - 1];
    endMarker = L.marker([last.lat, last.lng], {
      icon: pinIcon('A', 'marker-pin--end'),
      title: "Point d'arrivée",
    }).addTo(map);
  }

  startMarker.setZIndexOffset(1000);
  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

/* ------------------------------------------------------------ formulaire --- */

function bindEvents() {
  bindSegmented(el.segSport, (value) => {
    state.sport = value;
    el.inputSpeed.value = DEFAULT_SPEED[value];
    updateGoalHint();
    saveSettings();
  });

  bindSegmented(el.segShape, (value) => {
    state.shape = value;
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

  // Direction imposée, ou rotation par l'angle d'or pour varier les propositions.
  if (chosen === 'auto') {
    state.bearing =
      newVariant && state.bearing != null
        ? (state.bearing + 137.5) % 360
        : Math.random() * 360;
  } else {
    const base = Number(chosen);
    state.bearing = newVariant ? base + ((state.variant % 5) - 2) * 12 : base;
  }

  const targetDistance = targetDistanceMeters();

  try {
    const result = await planRoute({
      start: state.start,
      targetDistance,
      sport: state.sport,
      shape: state.shape,
      bearing: state.bearing,
      seed: state.variant * 7919 + 13,
      onProgress: (msg) => setStatus(msg),
      signal,
    });

    state.route = result;
    drawRoute(result.coords, state.shape);
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

  if (saved.start?.lat != null) state.start = saved.start;
  if (saved.distance) el.inputDistance.value = saved.distance;
  if (saved.time) el.inputTime.value = saved.time;
  if (saved.speed) el.inputSpeed.value = saved.speed;
  if (saved.direction) el.selectDirection.value = saved.direction;

  applySegment(el.segSport, saved.sport, (v) => (state.sport = v));
  applySegment(el.segShape, saved.shape, (v) => (state.shape = v));
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
