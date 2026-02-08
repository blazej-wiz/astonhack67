// src/api/osm.ts
// Fetch real POIs from OpenStreetMap via Overpass API (cached, offline-ish)

import type { POI, POIType } from '@/types/simulation';
import { ASTON_BBOX, clampToAstonBBox } from '@/data/astonData';

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// Cache
const CACHE_KEY = 'aston_osm_pois_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements: OverpassElement[];
};

function nowMs() {
  return Date.now();
}

function loadCache(): POI[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: POI[] };
    if (!parsed?.ts || !parsed?.data) return null;
    if (nowMs() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCache(data: POI[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: nowMs(), data }));
  } catch {
    // ignore cache failures
  }
}

function getLatLng(el: OverpassElement): [number, number] | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return [el.lat, el.lon];
  if (el.center && typeof el.center.lat === 'number' && typeof el.center.lon === 'number') {
    return [el.center.lat, el.center.lon];
  }
  return null;
}

function tag(el: OverpassElement, k: string): string | undefined {
  return el.tags?.[k];
}

function inferType(tags: Record<string, string> | undefined): POIType | null {
  if (!tags) return null;

  const amenity = tags.amenity;
  const shop = tags.shop;
  const leisure = tags.leisure;
  const tourism = tags.tourism;
  const office = tags.office;
  const industrial = tags.industrial;
  const railway = tags.railway;
  const publicTransport = tags.public_transport;
  const highway = tags.highway;

  // Education
  if (amenity && ['school', 'college', 'university', 'kindergarten'].includes(amenity)) return 'education';

  // Healthcare
  if (amenity && ['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy'].includes(amenity)) return 'healthcare';

  // Retail
  if (shop) return 'retail';
  if (amenity && ['marketplace'].includes(amenity)) return 'retail';

  // Employment (very broad)
  if (office) return 'employment';
  if (industrial) return 'employment';

  // Social / Community
  if (amenity && ['community_centre', 'social_facility', 'library'].includes(amenity)) return 'social';

  // Religious
  if (amenity && ['place_of_worship'].includes(amenity)) return 'religious';

  // Leisure / Tourism
  if (leisure || tourism) return 'leisure';
  if (amenity && ['cinema', 'theatre', 'arts_centre', 'pub', 'bar', 'restaurant', 'cafe'].includes(amenity)) return 'leisure';

  // Transport
  if (railway && ['station', 'tram_stop', 'halt', 'subway_entrance'].includes(railway)) return 'transport';
  if (publicTransport && ['station', 'stop_position', 'platform'].includes(publicTransport)) return 'transport';
  if (highway && ['bus_stop'].includes(highway)) return 'transport';

  return null;
}

function formatName(tags: Record<string, string> | undefined, fallback: string) {
  const n = tags?.name?.trim();
  return n && n.length > 1 ? n : fallback;
}

function pickDebugTag(tags: Record<string, string> | undefined): string {
  if (!tags) return '';
  const keys = ['amenity', 'shop', 'office', 'leisure', 'tourism', 'railway', 'public_transport', 'highway'];
  for (const k of keys) {
    if (tags[k]) return `${k}=${tags[k]}`;
  }
  return '';
}

function overpassQueryForAstonBBox(): string {
  const [south, west, north, east] = ASTON_BBOX;

  // Note: Overpass bbox order is (south,west,north,east)
  // We intentionally include ways/relations and ask for "center" so we can place them.
  return `
[out:json][timeout:25];
(
  // Education
  node["amenity"~"school|college|university|kindergarten"](${south},${west},${north},${east});
  way["amenity"~"school|college|university|kindergarten"](${south},${west},${north},${east});
  relation["amenity"~"school|college|university|kindergarten"](${south},${west},${north},${east});

  // Healthcare
  node["amenity"~"hospital|clinic|doctors|dentist|pharmacy"](${south},${west},${north},${east});
  way["amenity"~"hospital|clinic|doctors|dentist|pharmacy"](${south},${west},${north},${east});
  relation["amenity"~"hospital|clinic|doctors|dentist|pharmacy"](${south},${west},${north},${east});

  // Retail
  node["shop"](${south},${west},${north},${east});
  way["shop"](${south},${west},${north},${east});
  relation["shop"](${south},${west},${north},${east});
  node["amenity"="marketplace"](${south},${west},${north},${east});
  way["amenity"="marketplace"](${south},${west},${north},${east});
  relation["amenity"="marketplace"](${south},${west},${north},${east});

  // Employment (broad)
  node["office"](${south},${west},${north},${east});
  way["office"](${south},${west},${north},${east});
  relation["office"](${south},${west},${north},${east});
  node["industrial"](${south},${west},${north},${east});
  way["industrial"](${south},${west},${north},${east});
  relation["industrial"](${south},${west},${north},${east});

  // Social / Religious / Leisure
  node["amenity"~"community_centre|social_facility|library|place_of_worship|cinema|theatre|arts_centre|pub|bar|restaurant|cafe"](${south},${west},${north},${east});
  way["amenity"~"community_centre|social_facility|library|place_of_worship|cinema|theatre|arts_centre|pub|bar|restaurant|cafe"](${south},${west},${north},${east});
  relation["amenity"~"community_centre|social_facility|library|place_of_worship|cinema|theatre|arts_centre|pub|bar|restaurant|cafe"](${south},${west},${north},${east});

  node["leisure"](${south},${west},${north},${east});
  way["leisure"](${south},${west},${north},${east});
  relation["leisure"](${south},${west},${north},${east});
  node["tourism"](${south},${west},${north},${east});
  way["tourism"](${south},${west},${north},${east});
  relation["tourism"](${south},${west},${north},${east});

  // Transport anchors (rail stations etc)
  node["railway"~"station|tram_stop|halt|subway_entrance"](${south},${west},${north},${east});
  way["railway"~"station|tram_stop|halt|subway_entrance"](${south},${west},${north},${east});
  relation["railway"~"station|tram_stop|halt|subway_entrance"](${south},${west},${north},${east});
  node["public_transport"~"station|stop_position|platform"](${south},${west},${north},${east});
  way["public_transport"~"station|stop_position|platform"](${south},${west},${north},${east});
  relation["public_transport"~"station|stop_position|platform"](${south},${west},${north},${east});
);
out center tags;
`.trim();
}

export async function fetchAstonPOIs(opts?: { forceRefresh?: boolean; maxPois?: number }): Promise<POI[]> {
  const forceRefresh = !!opts?.forceRefresh;
  const maxPois = opts?.maxPois ?? 600;

  if (!forceRefresh) {
    const cached = loadCache();
    if (cached && cached.length) return cached;
  }

  const q = overpassQueryForAstonBBox();

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: `data=${encodeURIComponent(q)}`,
  });

  if (!res.ok) {
    throw new Error(`Overpass failed: ${res.status}`);
  }

  const json = (await res.json()) as OverpassResponse;
  const elements = json.elements || [];

  const pois: POI[] = [];

  for (const el of elements) {
    const ll = getLatLng(el);
    if (!ll) continue;

    const t = inferType(el.tags);
    if (!t) continue;

    const location = clampToAstonBBox([ll[0], ll[1]]);
    const name = formatName(el.tags, `${t[0].toUpperCase()}${t.slice(1)} (${el.type} ${el.id})`);
    const debug = pickDebugTag(el.tags);

    // Make a stable unique id
    const id = `osm_${el.type}_${el.id}`;

    pois.push({
      id,
      name,
      location,
      type: t,
      // keep some tags for UI debugging (non-breaking: TS allows extra props only if your POI type is strict)
      ...(debug ? ({ osmTag: debug } as any) : {}),
    } as POI);
  }

  // De-dup by id and trim
  const uniq = new Map<string, POI>();
  for (const p of pois) if (!uniq.has(p.id)) uniq.set(p.id, p);

  const out = Array.from(uniq.values()).slice(0, maxPois);

  saveCache(out);
  return out;
}
