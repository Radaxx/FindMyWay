// Lieux de départ enregistrés (domicile, bureau, club…), stockés dans le
// navigateur via localStorage.

import { distance } from './geo.js';

const KEY = 'findmyway.places.v1';
const MATCH_RADIUS = 40; // m : tolérance pour reconnaître un lieu déjà enregistré

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && p.id && Number.isFinite(p.lat)) : [];
  } catch {
    return [];
  }
}

function write(places) {
  try {
    localStorage.setItem(KEY, JSON.stringify(places));
  } catch {
    /* stockage plein ou désactivé : sans conséquence sur le tracé */
  }
}

/** @returns {{id: string, name: string, lat: number, lng: number}[]} triés par nom */
export function listPlaces() {
  return read().sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Ajoute un lieu, ou renomme celui déjà enregistré au même endroit. */
export function savePlace({ name, lat, lng }) {
  const places = read();
  const label = (name || '').trim() || 'Lieu sans nom';

  const existing = places.find((p) => distance(p, { lat, lng }) <= MATCH_RADIUS);
  if (existing) {
    existing.name = label;
    write(places);
    return existing;
  }

  const place = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    lat,
    lng,
  };
  places.push(place);
  write(places);
  return place;
}

export function deletePlace(id) {
  write(read().filter((p) => p.id !== id));
}

export function getPlace(id) {
  return read().find((p) => p.id === id) || null;
}

/** Lieu enregistré correspondant à un point (à quelques dizaines de mètres près). */
export function findPlaceNear(latlng) {
  if (!latlng) return null;
  return read().find((p) => distance(p, latlng) <= MATCH_RADIUS) || null;
}
