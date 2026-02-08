// src/api/osrm.ts
// OSRM client (public) with caching + safe fallbacks.
// Uses GeoJSON geometry (no polyline decode needed).

import { haversineDistance } from '@/data/astonData';

type LatLng = [number, number]; // [lat, lng]

export type OsrmMode = 'driving'; // public OSRM supports driving. We can add 'foot' later with another provider.

export type OsrmRouteResult = {
  geometry: LatLng[];      // [lat,lng] polyline points
  distanceKm: number;      // km
  durationMin: number;     // minutes
  degraded: boolean;       // true if fallback used
};

const OSRM_BASE_URL = '/osrm';

const memCache = new Map<string, OsrmRouteResult>();
const memCacheNearest = new Map<string, LatLng>();

function keyRoute(mode: OsrmMode, a: LatLng, b: LatLng) {
  // rounding reduces cache key explosion
  const ra = `${a[0].toFixed(6)},${a[1].toFixed(6)}`;
  const rb = `${b[0].toFixed(6)},${b[1].toFixed(6)}`;
  return `${mode}|${ra}|${rb}`;
}

function keyNearest(mode: OsrmMode, a: LatLng) {
  return `${mode}|${a[0].toFixed(6)},${a[1].toFixed(6)}`;
}

function straightLineFallback(a: LatLng, b: LatLng): OsrmRouteResult {
  const km = haversineDistance(a, b);
  // very rough default speed assumptions
  const speedKmh = 18; // "bus-ish"/driving-ish fallback
  const durationMin = (km / speedKmh) * 60;
  return {
    geometry: [a, b],
    distanceKm: Number.isFinite(km) ? km : 0,
    durationMin: Number.isFinite(durationMin) ? durationMin : 0,
    degraded: true,
  };
}

/**
 * Snap a point to nearest road node (driving profile).
 * Returns the snapped lat/lng, or original point if OSRM fails.
 */
export async function osrmNearest(point: LatLng, mode: OsrmMode = 'driving'): Promise<LatLng> {
  const k = keyNearest(mode, point);
  const cached = memCacheNearest.get(k);
  if (cached) return cached;

  const lon = point[1];
  const lat = point[0];

  const url = `${OSRM_BASE_URL}/nearest/v1/${mode}/${lon},${lat}?number=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM nearest failed: ${res.status}`);
    const json = await res.json();

    const loc = json?.waypoints?.[0]?.location; // [lon,lat]
    if (Array.isArray(loc) && loc.length === 2) {
      const snapped: LatLng = [loc[1], loc[0]];
      memCacheNearest.set(k, snapped);
      return snapped;
    }
  } catch {
    // ignore and fall back
  }

  memCacheNearest.set(k, point);
  return point;
}

/**
 * Road route between two points (driving profile).
 * Returns road-following geometry, distance, duration.
 * Falls back to straight line if OSRM fails.
 */
export async function osrmRoute(a: LatLng, b: LatLng, mode: OsrmMode = 'driving'): Promise<OsrmRouteResult> {
  const k = keyRoute(mode, a, b);
  const cached = memCache.get(k);
  if (cached) return cached;

  const lon1 = a[1], lat1 = a[0];
  const lon2 = b[1], lat2 = b[0];

  // geometries=geojson gives coordinates as [lon,lat]
  const url =
    `${OSRM_BASE_URL}/route/v1/${mode}/${lon1},${lat1};${lon2},${lat2}` +
    `?overview=full&geometries=geojson&steps=false&annotations=false`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM route failed: ${res.status}`);
    const json = await res.json();

    const route = json?.routes?.[0];
    const coords = route?.geometry?.coordinates; // [[lon,lat], ...]
    if (Array.isArray(coords) && coords.length >= 2) {
      const geometry: LatLng[] = coords
        .map((c: any) => (Array.isArray(c) && c.length === 2 ? ([c[1], c[0]] as LatLng) : null))
        .filter(Boolean) as LatLng[];

      const distanceKm = (route.distance ?? 0) / 1000;
      const durationMin = (route.duration ?? 0) / 60;

      const out: OsrmRouteResult = {
        geometry,
        distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
        durationMin: Number.isFinite(durationMin) ? durationMin : 0,
        degraded: false,
      };

      memCache.set(k, out);
      return out;
    }
  } catch {
    // ignore and fall back
  }

  const fb = straightLineFallback(a, b);
  memCache.set(k, fb);
  return fb;
}

/**
 * Utility: concatenate two geometries without duplicating the join point.
 */
export function concatGeometries(a: LatLng[], b: LatLng[]) {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const out = a.slice();
  const last = out[out.length - 1];
  const first = b[0];
  if (last && first && last[0] === first[0] && last[1] === first[1]) {
    out.push(...b.slice(1));
  } else {
    out.push(...b);
  }
  return out;
}
