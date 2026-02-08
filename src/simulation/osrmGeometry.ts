// src/simulation/osrmGeometry.ts
// OSRM corridor routing (ONE request per route)

import type { BusRoute, BusStop } from '@/types/simulation';

type LatLng = [number, number];

const OSRM_BASE_URL = '/osrm';

function stopMap(stops: BusStop[]) {
  return new Map(stops.map(s => [s.id, s.location]));
}

export async function enrichRoutesWithOsrmGeometry(
  routes: BusRoute[],
  stops: BusStop[],
  mode: 'driving' = 'driving'
): Promise<BusRoute[]> {
  const byId = stopMap(stops);
  const out: BusRoute[] = [];

  for (const r of routes) {
    if (!r.stopIds || r.stopIds.length < 2) {
      out.push(r);
      continue;
    }

    const coords: LatLng[] = r.stopIds
      .map(id => byId.get(id))
      .filter(Boolean) as LatLng[];

    if (coords.length < 2) {
      out.push(r);
      continue;
    }

    const coordStr = coords
      .map(([lat, lon]) => `${lon},${lat}`)
      .join(';');

    const url =
      `${OSRM_BASE_URL}/route/v1/${mode}/${coordStr}` +
      `?overview=full&geometries=geojson&steps=false`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('OSRM failed');
      const json = await res.json();

      const geometry = json?.routes?.[0]?.geometry?.coordinates;
      if (Array.isArray(geometry)) {
        out.push({
          ...r,
          geometry: geometry.map(([lon, lat]: number[]) => [lat, lon]),
        });
        continue;
      }
    } catch {
      // fall back below
    }

    // fallback: straight polyline
    out.push({
      ...r,
      geometry: coords,
      name: `${r.name} (fallback)`,
    });
  }

  return out;
}
