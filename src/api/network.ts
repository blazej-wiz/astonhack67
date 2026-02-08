// src/api/network.ts
export type ApiStop = { id: string; name: string; lat: number; lng: number };
export type ApiRoute = {
  id: string;
  shortName?: string;
  longName?: string;
  color?: string;
  stopIds: string[];
  shape: [number, number][]; // [lat,lng]
  headwayMins?: number | null;
};

export type ApiNetwork = {
  stops: ApiStop[];
  routes: ApiRoute[];
  meta: Record<string, any>;
};

type FetchNetworkOpts = {
  bufferMeters?: number;
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  minStopsInArea?: number;
};

export async function fetchNetwork(opts: FetchNetworkOpts = {}): Promise<ApiNetwork> {
  const bufferMeters = opts.bufferMeters ?? 1500;
  const minStopsInArea = opts.minStopsInArea ?? 3;

  const url = new URL('http://127.0.0.1:8000/api/network');
  url.searchParams.set('bufferMeters', String(bufferMeters));
  url.searchParams.set('minStopsInArea', String(minStopsInArea));

  if (opts.bbox) {
    url.searchParams.set('minLat', String(opts.bbox.minLat));
    url.searchParams.set('minLng', String(opts.bbox.minLng));
    url.searchParams.set('maxLat', String(opts.bbox.maxLat));
    url.searchParams.set('maxLng', String(opts.bbox.maxLng));
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Network fetch failed: ${res.status}`);
  return res.json();
}
