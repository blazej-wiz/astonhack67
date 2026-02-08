// src/data/astonData.ts
// Offline-first city data for Aston simulation (hackathon-proof)

// Real-data foundation + legacy compatibility exports (so existing files don't break)
import type { BusStop, BusRoute, POI, POIType } from '@/types/simulation';

// Aston census (Census 2021)
// --------------------

export const ASTON_CENSUS = {
  wardName: 'Aston',
  wardCode: 'E05011121',
  totalPopulation: 24446,
  employmentRate: 0.459,
  ageBands: [
    { band: '0-4', count: 2418 },
    { band: '5-15', count: 4043 },
    { band: '16-24', count: 5156 },
    { band: '25-44', count: 6847 },
    { band: '45-64', count: 4076 },
    { band: '65+', count: 1906 },
  ],
};

// --------------------
// Geography
// --------------------

export const ASTON_BBOX: [number, number, number, number] = [
  52.488,  // south
  -1.915,  // west
  52.525,  // north
  -1.845,  // east
];

export const ASTON_ZOOM = 14;

export const ASTON_CENTER: [number, number] = [
  (ASTON_BBOX[0] + ASTON_BBOX[2]) / 2,
  (ASTON_BBOX[1] + ASTON_BBOX[3]) / 2,
];

export const ASTON_BOUNDARY: [number, number][] = [
  [ASTON_BBOX[0], ASTON_BBOX[1]],
  [ASTON_BBOX[0], ASTON_BBOX[3]],
  [ASTON_BBOX[2], ASTON_BBOX[3]],
  [ASTON_BBOX[2], ASTON_BBOX[1]],
  [ASTON_BBOX[0], ASTON_BBOX[1]],
];

export function clampToAstonBBox(p: [number, number]): [number, number] {
  const [south, west, north, east] = ASTON_BBOX;
  return [
    Math.min(north, Math.max(south, p[0])),
    Math.min(east, Math.max(west, p[1])),
  ];
}

export function randomPointInAston(): [number, number] {
  const [south, west, north, east] = ASTON_BBOX;
  return [
    south + Math.random() * (north - south),
    west + Math.random() * (east - west),
  ];
}

// --------------------
// Distance helpers
// --------------------

export function haversineDistance(a: [number, number], b: [number, number]): number {
  const R = 6371; // km
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// --------------------
// Carbon factors
// --------------------

export const CARBON_FACTORS = {
  car_per_km: 171,         // g CO2 / km
  bus_base_per_km: 822,    // g CO2 / km (planning proxy)
};

// --------------------
// Category weights (for synthetic generation)
// --------------------

export const POI_CATEGORY_WEIGHTS: Record<POIType, number> = {
  education: 1.0,
  employment: 1.1,
  retail: 0.9,
  healthcare: 0.7,
  social: 0.7,
  leisure: 0.6,
  religious: 0.35,
  transport: 0.9,
};

let POI_CACHE: POI[] | null = null;
const POI_CACHE_KEY = 'aston_pois_v1';
const POI_CACHE_META_KEY = 'aston_pois_meta_v1';
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let POI_INFLIGHT: Promise<POI[]> | null = null;

type PoiCacheMeta = {
  savedAt: number; // epoch ms
  source: 'overpass' | 'fallback';
};

function safeReadLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore (private mode / quota / disabled)
  }
}

function readCachedPOIsFromStorage(): POI[] | null {
  const metaRaw = safeReadLocalStorage(POI_CACHE_META_KEY);
  const dataRaw = safeReadLocalStorage(POI_CACHE_KEY);
  if (!metaRaw || !dataRaw) return null;

  try {
    const meta = JSON.parse(metaRaw) as PoiCacheMeta;
    if (!meta?.savedAt || Date.now() - meta.savedAt > POI_CACHE_TTL_MS) return null;

    const pois = JSON.parse(dataRaw) as POI[];
    if (!Array.isArray(pois) || pois.length === 0) return null;

    // Basic shape check
    if (!pois.every(p => Array.isArray(p.location) && p.location.length === 2)) return null;

    return pois;
  } catch {
    return null;
  }
}

function writeCachedPOIsToStorage(pois: POI[], source: PoiCacheMeta['source']) {
  safeWriteLocalStorage(POI_CACHE_KEY, JSON.stringify(pois));
  safeWriteLocalStorage(
    POI_CACHE_META_KEY,
    JSON.stringify({ savedAt: Date.now(), source } satisfies PoiCacheMeta)
  );
}

// Loads bus stops in Aston bbox from OSM Overpass
export async function loadAstonBusStops(): Promise<BusStop[]> {
  const [south, west, north, east] = ASTON_BBOX;

  const query = `
    [out:json][timeout:25];
    (
      node["highway"="bus_stop"](${south},${west},${north},${east});
      node["public_transport"="platform"]["bus"="yes"](${south},${west},${north},${east});
      node["public_transport"="stop_position"]["bus"="yes"](${south},${west},${north},${east});
    );
    out body;
  `;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
  });
  const data = await res.json();

  const stops: BusStop[] = (data.elements || [])
    .filter((el: any) => Number.isFinite(el.lat) && Number.isFinite(el.lon))
    .map((el: any) => ({
      id: `osm_stop_${el.id}`,
      name: el.tags?.name ?? "Bus Stop",
      location: [Number(el.lat), Number(el.lon)],
    }));

  return stops;
}


export async function loadAstonPOIs(): Promise<POI[]> {
  
  if (POI_CACHE) return POI_CACHE;
  if (POI_INFLIGHT) return POI_INFLIGHT;
  // 3) Persistent cache (localStorage)
  // Guard: localStorage only exists in browser
  if (typeof window !== 'undefined') {
    const stored = readCachedPOIsFromStorage();
    if (stored) {
      POI_CACHE = stored;
      console.log(`[POI] Loaded ${stored.length} POIs from local cache`);
      return stored;
    }
  }
  const [south, west, north, east] = ASTON_BBOX;

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"school|college|university|hospital|clinic|doctors|pharmacy|place_of_worship|community_centre"]( ${south}, ${west}, ${north}, ${east} );
      node["shop"]( ${south}, ${west}, ${north}, ${east} );
      node["office"]( ${south}, ${west}, ${north}, ${east} );
      node["leisure"]( ${south}, ${west}, ${north}, ${east} );
      node["tourism"]( ${south}, ${west}, ${north}, ${east} );
      node["public_transport"]( ${south}, ${west}, ${north}, ${east} );
    );
    out body;
  `;
  POI_INFLIGHT = (async () => {
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
    });

    const data = await res.json();

    const pois: POI[] = (data.elements || [])
      .filter((el: any) => el.lat && el.lon)
      .map((el: any) => {
        const tags = el.tags || {};
        const name = tags.name || 'Unnamed';

        let type: POIType = 'social';

        if (tags.amenity) {
          if (['school', 'college', 'university'].includes(tags.amenity))
            type = 'education';
          else if (['hospital', 'clinic', 'doctors', 'pharmacy'].includes(tags.amenity))
            type = 'healthcare';
          else if (tags.amenity === 'place_of_worship')
            type = 'religious';
          else if (tags.amenity === 'community_centre')
            type = 'social';
        }

        if (tags.shop) type = 'retail';
        if (tags.office) type = 'employment';
        if (tags.leisure || tags.tourism) type = 'leisure';
        if (tags.public_transport) type = 'transport';

        return {
          id: `poi_${el.id}`,
          name,
          type,
          // location: [el.lat, el.lon],
          location: [Number(el.lat), Number(el.lon)],
        };
      });
      // If Overpass returns nothing, keep the sim usable
      const finalPois = pois.length ? pois : FALLBACK_POIS;      
      POI_CACHE = finalPois;

      if (typeof window !== 'undefined') {
        writeCachedPOIsToStorage(finalPois, pois.length ? 'overpass' : 'fallback');
      }

      console.log(
        pois.length
          ? `[POI] Loaded ${pois.length} POIs from OpenStreetMap`
          : `[POI] Overpass returned 0 POIs, using fallback (${FALLBACK_POIS.length})`
      );

      return finalPois;
    } catch (err) {
      console.error('[POI] Overpass failed, using fallback POIs', err);
      POI_CACHE = FALLBACK_POIS;

      if (typeof window !== 'undefined') {
        writeCachedPOIsToStorage(FALLBACK_POIS, 'fallback');
      }

      return FALLBACK_POIS;
    } finally {
      POI_INFLIGHT = null;
    }
  })();

  return POI_INFLIGHT;
}


// --------------------
// Legacy compatibility exports
// --------------------

export const FALLBACK_POIS: POI[] = [
  { id: 'aston_university', name: 'Aston University', type: 'education', location: [52.4862, -1.8904] },
  { id: 'villa_park', name: 'Villa Park', type: 'leisure', location: [52.5091, -1.8848] },
  { id: 'star_city', name: 'Star City', type: 'leisure', location: [52.5016, -1.8523] },
  { id: 'aston_hall', name: 'Aston Hall', type: 'leisure', location: [52.5055, -1.8717] },
];

export const POIS: POI[] = FALLBACK_POIS;

export const BUS_STOPS: BusStop[] = [
  { id: 'fallback_stop_1', name: 'Whatdisdo', location: [52.507, -1.89] },
  { id: 'fallback_stop_2', name: 'Aston (Fallback Stop 2)', location: [52.5, -1.88] },
  { id: 'fallback_stop_3', name: 'Aston (Fallback Stop 3)', location: [52.515, -1.875] },
  { id: 'fallback_stop_4', name: 'Aston (Fallback Stop 4)', location: [52.495, -1.9] },
];

export const BUS_ROUTES: BusRoute[] = [
  {
    id: 'fallback_route_1',
    name: 'Fallback Route',
    stopIds: BUS_STOPS.map(s => s.id),
    frequency: 10,
    vehicleCapacity: 60,
    color: '#4CAF50',
    geometry: BUS_STOPS.map(s => s.location),
  },
];

// --------------------
// Offline-first synthetic city generation
// --------------------

type RNG = {
  next(): number; // [0,1)
  int(min: number, max: number): number;
  pick<T>(arr: T[]): T;
};

function makeRng(seed = 1337): RNG {
  // mulberry32
  let t = seed >>> 0;
  const next = () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
  };
}

function gaussian(rng: RNG, mean = 0, std = 1) {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function jitterAround(rng: RNG, center: [number, number], metersStd = 250): [number, number] {
  const latStdDeg = metersStd / 111_000;
  const lonStdDeg = metersStd / (111_000 * Math.cos(center[0] * Math.PI / 180));
  return clampToAstonBBox([
    center[0] + gaussian(rng, 0, latStdDeg),
    center[1] + gaussian(rng, 0, lonStdDeg),
  ]);
}

// Very rough river exclusion corridor (Aston rectangle includes water/industrial).
// This is intentionally coarse but stops “homes in river”.
function isInRiverCorridor(p: [number, number]) {
  const [lat, lng] = p;
  // Approx corridor around River Tame / canals in this bbox region (tunable)
  // Keep it conservative: exclude a strip on the eastern side where water tends to be.
  return (
    lat > 52.495 &&
    lat < 52.515 &&
    lng > -1.885 &&
    lng < -1.865
  );
}

let CITY_CACHE: { seed: number; pois: POI[]; stops: BusStop[]; residentialHubs: [number, number][] } | null = null;

// export function buildCity(seed = 1337, opts?: { poiCount?: number; stopCount?: number }) {
//   const poiCount = opts?.poiCount ?? 450;
//   const stopCount = opts?.stopCount ?? 70;

//   if (CITY_CACHE && CITY_CACHE.seed === seed) return CITY_CACHE;

//   const rng = makeRng(seed);

//   // “Activity hubs” (anchors) + “Residential hubs”
//   const activityHubs: [number, number][] = [
//     [52.4862, -1.8904], // Aston University
//     [52.5000, -1.8800],
//     [52.5070, -1.8900],
//     [52.5150, -1.8750],
//     [52.5016, -1.8523], // Star City
//     [52.5055, -1.8717], // Aston Hall
//   ].map(clampToAstonBBox);

//   // blazej vibe code
//   // residential hubs: spread around bbox but avoid river corridor
//   const residentialHubs: [number, number][] = [];
//   while (residentialHubs.length < 10) {
//     const p = clampToAstonBBox([
//       ASTON_BBOX[0] + rng.next() * (ASTON_BBOX[2] - ASTON_BBOX[0]),
//       ASTON_BBOX[1] + rng.next() * (ASTON_BBOX[3] - ASTON_BBOX[1]),
//     ]);
//     if (!isInRiverCorridor(p)) residentialHubs.push(p);
//   }

//   // // Weighted type picker
//   // const types: POIType[] = ['education','employment','retail','healthcare','social','leisure','religious','transport'];
//   // const weights = types.map(t => POI_CATEGORY_WEIGHTS[t] ?? 0.5);
//   // const sum = weights.reduce((a, b) => a + b, 0);
//   // const pickType = (): POIType => {
//   //   let r = rng.next() * sum;
//   //   for (let i = 0; i < types.length; i++) {
//   //     r -= weights[i];
//   //     if (r <= 0) return types[i];
//   //   }
//   //   return 'social';
//   // };

//   // // POIs
//   // const pois: POI[] = [];
//   // for (let i = 0; i < poiCount; i++) {
//   //   const hub = rng.pick(activityHubs);
//   //   const type = pickType();
//   //   const loc = jitterAround(rng, hub, 420);

//   //   pois.push({
//   //     id: `poi_syn_${i + 1}`,
//   //     name: `${type[0].toUpperCase()}${type.slice(1)} ${i + 1}`,
//   //     type,
//   //     location: loc,
//   //   });
//   // }
//   // // include your real anchors too
//   // const allPois = [...FALLBACK_POIS, ...pois];

//   // Stops: grid + jitter, avoid river corridor
//   const stops: BusStop[] = [];
//   const [south, west, north, east] = ASTON_BBOX;
//   const rows = Math.max(5, Math.floor(Math.sqrt(stopCount)));
//   const cols = Math.max(5, Math.ceil(stopCount / rows));
//   let id = 1;

//   for (let r = 0; r < rows; r++) {
//     const lat = south + (r + 0.5) * ((north - south) / rows);
//     for (let c = 0; c < cols; c++) {
//       if (stops.length >= stopCount) break;
//       const lon = west + (c + 0.5) * ((east - west) / cols);
//       let loc = clampToAstonBBox([lat, lon]);
//       loc = jitterAround(rng, loc, 170);
//       if (isInRiverCorridor(loc)) continue;
//       stops.push({ id: `stop_syn_${id++}`, name: `Stop ${stops.length + 1}`, location: loc });
//     }
//   }

//   CITY_CACHE = { seed, pois: allPois, stops, residentialHubs };
//   return CITY_CACHE;
// }

// export function getCityPOIs(seed = 1337) {
//   return buildCity(seed).pois;
// }

// export function getCityStops(seed = 1337) {
//   return buildCity(seed).stops;
// }

// Key: valid home sampling (no rivers)
export function randomHomeLocation(seed = 1337): [number, number] {
  //const { residentialHubs } = loadAstonPOIs(seed);
  const rng = makeRng(seed + Math.floor(Math.random() * 1_000_000)); // per-call variety
  let tries = 0;

  // while (tries++ < 40) {
  //   const hub = rng.pick(residentialHubs);
  //   const p = jitterAround(rng, hub, 280);
  //   if (!isInRiverCorridor(p)) return p;
  // }
  // last resort
  const p = clampToAstonBBox(randomPointInAston());
  return isInRiverCorridor(p) ? clampToAstonBBox([p[0], p[1] - 0.01]) : p;
}

// Legacy helpers used in older engine/UI
export function findNearestStop(location: [number, number]): BusStop {
  return nearestStopFrom(BUS_STOPS, location);
}
export function findDestinationStop(_originStopId: string, destination: [number, number]): BusStop {
  return nearestStopFrom(BUS_STOPS, destination);
}
function nearestStopFrom(stops: BusStop[], location: [number, number]): BusStop {
  let best = stops[0];
  let bestDist = Infinity;
  for (const s of stops) {
    const d = haversineDistance(location, s.location);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}
