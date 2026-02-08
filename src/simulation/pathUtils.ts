// src/simulation/pathUtils.ts

import { haversineDistance } from '@/data/astonData';

export type LatLng = [number, number];

export type Path = {
  geometry: LatLng[];
  distances: number[]; // cumulative km
  cursor: number;
};

export function buildPath(geometry: LatLng[]): Path {
  const distances: number[] = [0];
  let acc = 0;

  for (let i = 0; i < geometry.length - 1; i++) {
    const d = haversineDistance(geometry[i], geometry[i + 1]);
    acc += Number.isFinite(d) ? d : 0;
    distances.push(acc);
  }

  return {
    geometry,
    distances,
    cursor: 0,
  };
}

/**
 * Move along path by stepKm.
 * Mutates path.cursor.
 */
export function advanceAlongPath(
  path: Path,
  stepKm: number
): { location: LatLng; movedKm: number; arrived: boolean } {
  if (path.cursor >= path.geometry.length - 1) {
    return {
      location: path.geometry[path.geometry.length - 1],
      movedKm: 0,
      arrived: true,
    };
  }

  let moved = 0;

  while (path.cursor < path.geometry.length - 1) {
    const from = path.geometry[path.cursor];
    const to = path.geometry[path.cursor + 1];
    const segKm = haversineDistance(from, to);

    if (moved + segKm > stepKm) {
      const t = (stepKm - moved) / segKm;
      return {
        location: [
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
        ],
        movedKm: stepKm,
        arrived: false,
      };
    }

    moved += segKm;
    path.cursor++;
  }

  return {
    location: path.geometry[path.geometry.length - 1],
    movedKm: moved,
    arrived: true,
  };
}
