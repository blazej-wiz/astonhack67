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

// export async function fetchNetwork(
//   bufferMeters = 1500): Promise<ApiNetwork> {
//   const res = await fetch(`http://127.0.0.1:8000/api/network?bufferMeters=${bufferMeters}`);
//   if (!res.ok) throw new Error(`Network fetch failed: ${res.status}`);
//   return res.json();
// }

export async function fetchNetwork(
  bufferMeters = 3500,
  minStopsInArea = 3
): Promise<ApiNetwork> {
  const url =
    `http://127.0.0.1:8000/api/network` +
    `?bufferMeters=${bufferMeters}` +
    `&minStopsInArea=${minStopsInArea}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Network fetch failed: ${res.status} ${body}`);
  }
  return res.json();
}