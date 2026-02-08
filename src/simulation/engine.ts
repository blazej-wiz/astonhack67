// src/simulation/engine.ts
// Offline-first: life-like schedules + dwell + flow recording
import { routeLengthKm } from '@/hooks/useSimulation';


import {
  ASTON_BBOX,
  ASTON_BOUNDARY,
  haversineDistance,
  randomPointInAston,
  CARBON_FACTORS,
  clampToAstonBBox,
} from '@/data/astonData';

import type { Agent, SimulationMetrics, BusStop, BusRoute, POI } from '@/types/simulation';

// ----------------------------------
// Point-in-polygon + safe random
// ----------------------------------


function isValidLocation(loc: any): loc is [number, number] {
  return (
    Array.isArray(loc) &&
    loc.length === 2 &&
    typeof loc[0] === 'number' &&
    typeof loc[1] === 'number' &&
    Number.isFinite(loc[0]) &&
    Number.isFinite(loc[1])
  );
}

function sanitizeStops(stops: BusStop[]): BusStop[] {
  return stops.filter(s => s && s.id && isValidLocation((s as any).location));
}

function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  const [x, y] = point; // lat, lng treated as x,y for ray casting
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;

    if (intersect) inside = !inside;
  }
  return inside;
}

function randomPointInAstonSafe(): [number, number] {
  // Your existing randomPointInAston likely already respects boundary,
  // but we harden it just in case.
  for (let i = 0; i < 50; i++) {
    const p = randomPointInAston();
    if (pointInPolygon(p, ASTON_BOUNDARY as any)) return p;
  }
  return randomPointInAston();
}


function inBoundary(p: [number, number]) {
  return pointInPolygon(p, ASTON_BOUNDARY as any);
}

// ----------------------------------
// Movement
// ----------------------------------

const WALK_KM_PER_MIN = 5 / 60;
const TRANSIT_KM_PER_MIN = 25 / 60;

function moveToward(
  current: [number, number],
  target: [number, number],
  stepKm: number
): { next: [number, number]; arrived: boolean; movedKm: number } {
  const d = haversineDistance(current, target);
  if (!Number.isFinite(d) || d <= 0) return { next: [...target], arrived: true, movedKm: 0 };
  if (d <= stepKm) return { next: [...target], arrived: true, movedKm: d };
  const t = stepKm / d;
  return {
    next: [
      current[0] + (target[0] - current[0]) * t,
      current[1] + (target[1] - current[1]) * t,
    ],
    arrived: false,
    movedKm: stepKm,
  };
}

// ----------------------------------
// Graph (undirected kNN) + cache
// ----------------------------------

interface GraphEdge {
  to: string;
  distanceKm: number;
}

function addEdge(edges: Map<string, GraphEdge[]>, from: string, to: string, dist: number) {
  const list = edges.get(from);
  if (!list) return;
  if (list.some(e => e.to === to)) return;
  list.push({ to, distanceKm: dist });
}

function buildTransitGraph(stops: BusStop[], k = 14) {
  const edges = new Map<string, GraphEdge[]>();
  for (const s of stops) edges.set(s.id, []);

  for (const a of stops) {
    const neighbours = stops
      .filter(b => b.id !== a.id)
      .map(b => ({ id: b.id, dist: haversineDistance(a.location, b.location) }))
      .filter(x => Number.isFinite(x.dist))
      .sort((x, y) => x.dist - y.dist)
      .slice(0, k);

    for (const n of neighbours) {
      addEdge(edges, a.id, n.id, n.dist);
      addEdge(edges, n.id, a.id, n.dist);
    }
  }
  return edges;
}

let GRAPH_KEY: string | null = null;
let GRAPH_CACHE: Map<string, GraphEdge[]> | null = null;
let PATH_CACHE = new Map<string, string[] | null>();

function stopsKey(stops: BusStop[]) {
  const n = stops.length;
  const s0 = stops[0]?.id ?? '';
  const s1 = stops[Math.min(10, n - 1)]?.id ?? '';
  return `${n}:${s0}:${s1}`;
}

function getGraph(stops: BusStop[]) {
  const key = stopsKey(stops);
  if (key === GRAPH_KEY && GRAPH_CACHE) return GRAPH_CACHE;
  GRAPH_KEY = key;
  GRAPH_CACHE = buildTransitGraph(stops, 14);
  PATH_CACHE = new Map();
  return GRAPH_CACHE;
}

function shortestPath(graph: Map<string, GraphEdge[]>, from: string, to: string): string[] | null {
  const ck = `${from}→${to}`;
  if (PATH_CACHE.has(ck)) return PATH_CACHE.get(ck)!;
  if (from === to) {
    PATH_CACHE.set(ck, [from]);
    return [from];
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const q = new Set<string>();

  for (const k of graph.keys()) {
    dist.set(k, Infinity);
    prev.set(k, null);
    q.add(k);
  }
  if (!dist.has(from) || !dist.has(to)) {
    PATH_CACHE.set(ck, null);
    return null;
  }

  dist.set(from, 0);

  while (q.size) {
    let u: string | null = null;
    let best = Infinity;
    for (const k of q) {
      const d = dist.get(k)!;
      if (d < best) {
        best = d;
        u = k;
      }
    }
    if (!u) break;
    q.delete(u);
    if (u === to) break;

    for (const e of graph.get(u) || []) {
      const alt = dist.get(u)! + e.distanceKm;
      if (alt < dist.get(e.to)!) {
        dist.set(e.to, alt);
        prev.set(e.to, u);
      }
    }
  }

  if (!prev.get(to)) {
    PATH_CACHE.set(ck, null);
    return null;
  }

  const path: string[] = [];
  let cur: string | null = to;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur)!;
  }

  PATH_CACHE.set(ck, path);
  return path;
}

function nearestStop(stops: BusStop[], loc: [number, number]): BusStop {
  let best = stops[0];
  let bestDist = Infinity;
  for (const s of stops) {
    const d = haversineDistance(loc, s.location);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

// ----------------------------------
// FLOW
// ----------------------------------

export type FlowEdge = {
  from: string;
  to: string;
  count: number;
  hourly: number[];
};

const FLOW = new Map<string, FlowEdge>();

function recordFlow(from: string, to: string, minute: number) {
  const hour = Math.floor((((minute % 1440) + 1440) % 1440) / 60);
  const key = `${from}→${to}`;
  let e = FLOW.get(key);
  if (!e) {
    e = { from, to, count: 0, hourly: Array(24).fill(0) };
    FLOW.set(key, e);
  }
  e.count += 1;
  e.hourly[hour] += 1;
}

export function getFlowEdges(): FlowEdge[] {
  return Array.from(FLOW.values());
}

export function clearFlow() {
  FLOW.clear();
}

type GenerateOptions = {
  topEdges?: number;
  minCount?: number;
  maxRoutes?: number;
  maxStopsPerRoute?: number;
};

function pickColor(i: number) {
  const palette = [
    'hsl(280, 70%, 60%)',
    'hsl(50, 90%, 55%)',
    'hsl(190, 80%, 55%)',
    'hsl(320, 70%, 55%)',
    'hsl(150, 70%, 50%)',
    'hsl(30, 90%, 55%)',
  ];
  return palette[i % palette.length];
}
export function generateRoutesFromFlow(stops: BusStop[], opts: GenerateOptions = {}): BusRoute[] {
  if (!Array.isArray(stops) || stops.length < 2) return [];
  const stopById = new Map(stops.map(s => [s.id, s]));
  const { topEdges = 120, minCount = 8, maxRoutes = 8, maxStopsPerRoute = 18 } = opts;

  const edges = getFlowEdges()
    .filter(e => e.count >= minCount && stopById.has(e.from) && stopById.has(e.to))
    .sort((a, b) => b.count - a.count)
    .slice(0, topEdges);

  if (!edges.length) return [];

  const out = new Map<string, FlowEdge[]>();
  const inp = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inp.has(e.to)) inp.set(e.to, []);
    out.get(e.from)!.push(e);
    inp.get(e.to)!.push(e);
  }
  for (const [k, list] of out) list.sort((a, b) => b.count - a.count);
  for (const [k, list] of inp) list.sort((a, b) => b.count - a.count);

  const used = new Set<string>();
  const routes: BusRoute[] = [];
  const edgeKey = (e: FlowEdge) => `${e.from}→${e.to}`;

  function bestUnusedOutgoing(node: string) {
    const list = out.get(node) || [];
    for (const e of list) if (!used.has(edgeKey(e))) return e;
    return null;
  }
  function bestUnusedIncoming(node: string) {
    const list = inp.get(node) || [];
    for (const e of list) if (!used.has(edgeKey(e))) return e;
    return null;
  }

  for (const seed of edges) {
    if (routes.length >= maxRoutes) break;
    if (used.has(edgeKey(seed))) continue;

    const forward: string[] = [seed.from, seed.to];
    used.add(edgeKey(seed));

    while (forward.length < maxStopsPerRoute) {
      const last = forward[forward.length - 1];
      const next = bestUnusedOutgoing(last);
      if (!next) break;
      if (forward.includes(next.to)) {
        used.add(edgeKey(next));
        break;
      }
      forward.push(next.to);
      used.add(edgeKey(next));
    }

    const backward: string[] = [];
    while (backward.length + forward.length < maxStopsPerRoute) {
      const first = backward.length ? backward[0] : forward[0];
      const prev = bestUnusedIncoming(first);
      if (!prev) break;
      if (backward.includes(prev.from) || forward.includes(prev.from)) {
        used.add(edgeKey(prev));
        break;
      }
      backward.unshift(prev.from);
      used.add(edgeKey(prev));
    }

    const stopIds = [...backward, ...forward];
    const geometry = stopIds
      .map(id => stopById.get(id)?.location)
      .filter((p): p is [number, number] => !!p);

    if (stopIds.length >= 3 && geometry.length === stopIds.length) {
      routes.push({
        id: `flow_route_${Date.now()}_${routes.length}`,
        name: `Proposed Corridor ${routes.length + 1}`,
        stopIds,
        frequency: 10,
        vehicleCapacity: 0,
        color: pickColor(routes.length),
        geometry,
      });
    }
  }

  return routes;
}

// ----------------------------------
// LIFE-LIKE AGENT MODEL (key fix)
// ----------------------------------

type Trip = {
  depart: number;                 // minute of day
  destination: [number, number];  // lat/lng
  dwell: number;                  // minutes to stay
};

const DAY = 24 * 60;

function randInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pickOne<T>(arr: T[]): T | null {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function pickPoi(pois: POI[], types: POI['type'][]): POI | null {
  const c = pois.filter(p => types.includes(p.type));
  return pickOne(c);
}

function safeDest(p: [number, number]): [number, number] {
  const c = clampToAstonBBox(p);
  return inBoundary(c) ? c : c; // boundary is rectangular anyway; kept for future polygon
}

// function makeDailySchedule(agent: Agent, pois: POI[], primary: POI | null): Trip[] {
//   const home = agent.homeLocation;
//   const trips: Trip[] = [];

//   // Base: everyone might do 1–3 activities + return home, with dwell.
//   // Students: school + maybe shop/social
//   if (agent.age < 18) {
//     const school = primary ?? pickPoi(pois, ['education']);
//     if (school) {
//       trips.push({ depart: 8 * 60 + randInt(-25, 25), destination: safeDest(school.location), dwell: randInt(300, 420) });


function pickDestination(pois: POI[]): [number, number] {
  if (pois.length > 0) {
    const p = pois[Math.floor(Math.random() * pois.length)];
    return p.location; // MUST be [lat, lng]
  }
  return randomPointInAstonSafe();
}

function makeSchedule(agent: Agent, pois: POI[] = [],): Trip[] {
  //const home = safeDest(homeSampler());
    const home = agent.homeLocation; // ✅ home comes from the agent

  const schedule: Trip[] = [];
  if (agent.age < 18) {
    schedule.push({ depart: 8 * 60 + randInt(-20, 30), destination: pickDestination(pois) , dwell:0});
    schedule.push({ depart: 15 * 60 + randInt(-15, 45), destination: home , dwell:0});
  }
  else if (agent.age < 65 && Math.random() < 0.65) {
    schedule.push({ depart: 7 * 60 + randInt(-40, 70), destination: pickDestination(pois), dwell:0 }); // “work”
    schedule.push({ depart: 17 * 60 + randInt(-20, 80), destination: home , dwell:0});

    if (Math.random() < 0.25) {
      schedule.splice(1, 0, { depart: 18 * 60 + randInt(0, 60), destination: pickDestination(pois), dwell:0});
      schedule.push({ depart: 19 * 60 + randInt(0, 90), destination: home , dwell:0});
    }
  }
  else {
    if (Math.random() < 0.7) {
      schedule.push({ depart: 11 * 60 + randInt(-30, 60), destination: pickDestination(pois) , dwell:0});
      schedule.push({ depart: 13 * 60 + randInt(0, 120), destination: home, dwell:0 });
    }
  }
  schedule.sort((a, b) => a.depart - b.depart);
  return schedule;
}


// ----------------------------------
// ASSIGNMENT LITE (Phase 1)
// Routes act as "lines". We compute best option:
// - walk-only
// - 1-line bus
// - 2-line bus (1 transfer)
// ----------------------------------

type TripPlan = {
  mode: 'walk' | 'bus';
  // boarding/alighting
  boardStopId?: string;
  alightStopId?: string;
  transferStopId?: string;

  // lines used
  routeIds: string[]; // length 0 (walk), 1 (direct), 2 (transfer)

  // components (minutes)
  walkAccessMin: number;
  walkEgressMin: number;
  waitMin: number;
  rideMin: number;
  transfers: number;

  // distance (km) for debugging/CO2 later
  walkKm: number;
  rideKm: number;

  // generalized cost (lower is better)
  cost: number;

  // debug label
  label: string;
};

type AssignmentWeights = {
  w_walk: number;
  w_wait: number;
  w_ride: number;
  w_xfer: number;
  xferPenaltyMin: number; // extra minutes per transfer to discourage messy paths
};

// sensible defaults for hackathon
const ASSIGN_W: AssignmentWeights = {
  w_walk: 1.0,
  w_wait: 0.7,     // waiting feels worse than riding
  w_ride: 1.0,
  w_xfer: 6.0,
  xferPenaltyMin: 6,
};

function minutesForWalk(km: number) {
  return km / WALK_KM_PER_MIN;
}
function minutesForRide(km: number) {
  return km / TRANSIT_KM_PER_MIN;
}

function routeHeadwayMin(route: BusRoute): number {
  // your BusRoute.frequency is already "minutes between vehicles"
  const f = Number(route.frequency);
  return Number.isFinite(f) && f > 0 ? f : 12;
}

function buildStopById(stops: BusStop[]) {
  return new Map(stops.map(s => [s.id, s]));
}

function routeStopIndex(route: BusRoute) {
  const idx = new Map<string, number>();
  (route.stopIds || []).forEach((id, i) => idx.set(id, i));
  return idx;
}


function routeStopSegment(route: BusRoute, fromStopId: string, toStopId: string): string[] | null {
  if (!route.stopIds || route.stopIds.length < 2) return null;
  const idx = routeStopIndex(route);
  const i = idx.get(fromStopId);
  const j = idx.get(toStopId);
  if (i == null || j == null) return null;
  if (i === j) return [fromStopId];

  // ✅ bidirectional segment
  if (i < j) return route.stopIds.slice(i, j + 1);
  return route.stopIds.slice(j, i + 1).reverse();
}



function routeRideDistanceKm(
  route: BusRoute,
  stopById: Map<string, BusStop>,
  fromStopId: string,
  toStopId: string
): number | null {
  const idx = routeStopIndex(route);
  const i = idx.get(fromStopId);
  const j = idx.get(toStopId);

  if (i == null || j == null) return null;
  if (i === j) return 0;

  // ✅ allow travel in either direction along the same line
  const a = Math.min(i, j);
  const b = Math.max(i, j);

  let km = 0;
  for (let k = a; k < b; k++) {
    const s1Id = route.stopIds[k];
    const s2Id = route.stopIds[k + 1];
    const s1 = stopById.get(s1Id);
    const s2 = stopById.get(s2Id);
    if (!s1 || !s2) return null;

    const d = haversineDistance(s1.location, s2.location);
    km += Number.isFinite(d) ? d : 0;
  }

  return km;
}


function generalizedCost(plan: Omit<TripPlan, 'cost'>, w: AssignmentWeights): number {
  return (
    w.w_walk * (plan.walkAccessMin + plan.walkEgressMin) +
    w.w_wait * plan.waitMin +
    w.w_ride * plan.rideMin +
    w.w_xfer * (plan.transfers * w.xferPenaltyMin)
  );
}

function computeTripPlanLite(
  origin: [number, number],
  destination: [number, number],
  stops: BusStop[],
  routes: BusRoute[],
  w: AssignmentWeights = ASSIGN_W
): TripPlan {
  const stopById = buildStopById(stops);

  // Always include walk-only fallback
  const walkKm = haversineDistance(origin, destination);
  const walkOnlyBase: Omit<TripPlan, 'cost'> = {
    mode: 'walk',
    routeIds: [],
    walkAccessMin: minutesForWalk(Number.isFinite(walkKm) ? walkKm : 0),
    walkEgressMin: 0,
    waitMin: 0,
    rideMin: 0,
    transfers: 0,
    walkKm: Number.isFinite(walkKm) ? walkKm : 0,
    rideKm: 0,
    label: 'walk_only',
  };
  let best: TripPlan = { ...walkOnlyBase, cost: generalizedCost(walkOnlyBase, w) };

  // If no routes, return walk-only
  if (!routes || routes.length === 0) return best;

  // Nearest stops to origin/destination (small K improves realism and avoids weird "nearest" corner cases)
  const K = 6;
  const originCandidates = stops
    .map(s => ({ id: s.id, km: haversineDistance(origin, s.location) }))
    .filter(x => Number.isFinite(x.km))
    .sort((a, b) => a.km - b.km)
    .slice(0, K);

  const destCandidates = stops
    .map(s => ({ id: s.id, km: haversineDistance(destination, s.location) }))
    .filter(x => Number.isFinite(x.km))
    .sort((a, b) => a.km - b.km)
    .slice(0, K);

  // ✅ Phase 2B: don't consider bus if access/egress walk is too long (keeps choices realistic)
const MAX_WALK_ACCESS_MIN = 15; // tweak: 10–15 feels realistic


  // DIRECT (1-line) candidates
  for (const r of routes) {
    if (!r.stopIds || r.stopIds.length < 2) continue;

    const headway = routeHeadwayMin(r);
const expectedWait = (headway / 2) * 0.6; // ✅ make bus more attractive

    for (const o of originCandidates) {
      for (const d of destCandidates) {
        const rideKm = routeRideDistanceKm(r, stopById, o.id, d.id);
        if (rideKm == null) continue;

        const accessMin = minutesForWalk(o.km);
        const egressKm = haversineDistance((stopById.get(d.id)!).location, destination);
        const egressMin = minutesForWalk(Number.isFinite(egressKm) ? egressKm : 0);
        // ✅ skip unrealistic bus options
if (accessMin > MAX_WALK_ACCESS_MIN || egressMin > MAX_WALK_ACCESS_MIN) continue;


        const base: Omit<TripPlan, 'cost'> = {
          mode: 'bus',
          routeIds: [r.id],
          boardStopId: o.id,
          alightStopId: d.id,
          walkAccessMin: accessMin,
          walkEgressMin: egressMin,
          waitMin: expectedWait,
          rideMin: minutesForRide(rideKm),
          transfers: 0,
          walkKm: (Number.isFinite(o.km) ? o.km : 0) + (Number.isFinite(egressKm) ? egressKm : 0),
          rideKm,
          label: `direct:${r.id}`,
        };

        const plan: TripPlan = { ...base, cost: generalizedCost(base, w) };
        if (plan.cost < best.cost) best = plan;
      }
    }
  }

  // ONE TRANSFER (2-line) candidates
  // Find an interchange stop that exists on both routes, travel A: board->xfer, then B: xfer->alight
  for (let i = 0; i < routes.length; i++) {
    const r1 = routes[i];
    if (!r1.stopIds || r1.stopIds.length < 2) continue;
    const idx1 = routeStopIndex(r1);
    const headway1 = routeHeadwayMin(r1);

    for (let j = 0; j < routes.length; j++) {
      if (i === j) continue;
      const r2 = routes[j];
      if (!r2.stopIds || r2.stopIds.length < 2) continue;
      const idx2 = routeStopIndex(r2);
      const headway2 = routeHeadwayMin(r2);

      // intersection stops
      const commonStops: string[] = [];
      for (const sid of r1.stopIds) if (idx2.has(sid)) commonStops.push(sid);
      if (commonStops.length === 0) continue;

      for (const o of originCandidates) {
        for (const d of destCandidates) {
          // try a few best common stops (limit to keep compute cheap)
          const commonLimited = commonStops.slice(0, 10);

          for (const xfer of commonLimited) {
            // r1: o -> xfer (must be forward)
            const ride1Km = routeRideDistanceKm(r1, stopById, o.id, xfer);
            if (ride1Km == null) continue;

            // r2: xfer -> d (must be forward)
            const ride2Km = routeRideDistanceKm(r2, stopById, xfer, d.id);
            if (ride2Km == null) continue;

            const accessMin = minutesForWalk(o.km);
            const egressKm = haversineDistance((stopById.get(d.id)!).location, destination);
            const egressMin = minutesForWalk(Number.isFinite(egressKm) ? egressKm : 0);
            // ✅ skip unrealistic bus options
if (accessMin > MAX_WALK_ACCESS_MIN || egressMin > MAX_WALK_ACCESS_MIN) continue;


const expectedWait = (headway1 / 2 + headway2 / 2) * 0.6;

            const base: Omit<TripPlan, 'cost'> = {
              mode: 'bus',
              routeIds: [r1.id, r2.id],
              boardStopId: o.id,
              transferStopId: xfer,
              alightStopId: d.id,
              walkAccessMin: accessMin,
              walkEgressMin: egressMin,
              waitMin: expectedWait,
              rideMin: minutesForRide(ride1Km + ride2Km),
              transfers: 1,
              walkKm: (Number.isFinite(o.km) ? o.km : 0) + (Number.isFinite(egressKm) ? egressKm : 0),
              rideKm: ride1Km + ride2Km,
              label: `xfer:${r1.id}->${r2.id}@${xfer}`,
            };

            const plan: TripPlan = { ...base, cost: generalizedCost(base, w) };
            if (plan.cost < best.cost) best = plan;
          }
        }
      }
    }
  }

  return best;
}




// ----------------------------------
// Agents
// ----------------------------------

export function createAgents(count: number, pois: POI[], homeSampler: () => [number, number]): Agent[] {
const agents: Agent[] = [];
  const edu = pois.filter(p => p.type === 'education');
  const emp = pois.filter(p => p.type === 'employment');

  for (let i = 0; i < count; i++) {
    const home = safeDest(homeSampler());
    //const home = randomPointInAstonSafe();

    const age = Math.floor(Math.random() * 80) + 5;

    // primary place: school/work anchor improves realism + repeated flow
    // let primary: POI | null = null;
    // if (age < 18) primary = pickOne(edu);
    // else if (age < 65 && Math.random() < 0.75) primary = pickOne(emp);

    const agent: Agent = {
      id: `agent_${i}`,
      homeLocation: home,
      //currentLocation: [...home],
      currentLocation: home,
      targetLocation: null,
      nearestStopId: null,
      destinationStopId: null,
      age,
      ageGroup: age < 18 ? 'child' : age < 65 ? 'adult' : 'senior',
      state: 'at_home',
      schedule: [],
      currentScheduleIndex: 0,
      carbonEmitted: 0,
      carBaselineCO2: 0,
      totalTimeSpent: 0,
      walkingTime: 0,
      waitingTime: 0,
      ridingTime: 0,
      distanceTraveled: 0,
      currentRouteId: null,
    };


   // (agent as any)._daily = makeDailySchedule(agent, pois, primary);
    (agent as any)._daily = makeSchedule(agent, pois);

    console.log('[createAgents] pois:', pois.length);
    //console.log('[engine] agent0 daily', (agents[0] as any)?._daily);
    // Store schedule on the agent without touching your types
    (agent as any)._mode = 'idle';
    (agent as any)._tripIndex = 0;
    (agent as any)._dwellLeft = 0;
    (agent as any)._path = null;
    (agent as any)._pathIndex = 0;

    agents.push(agent);
  }
  return agents;
}

// ----------------------------------
// Simulation step
// ----------------------------------

export function stepSimulation(
  agents: Agent[],
  _vehicles: any[],
  minute: number,
  _routes: BusRoute[],
  rawStops?: BusStop[],
  mode: 'demand' | 'assignment' = 'demand'
) {

  if (!rawStops || rawStops.length < 2) return { agents, vehicles: [] };

  const [south, west, north, east] = ASTON_BBOX;

  const insideAstonBBox = (p: [number, number]) => {
    const [lat, lng] = p;
    return lat >= south && lat <= north && lng >= west && lng <= east;
  };

  const stops = sanitizeStops(rawStops)
    .filter(s => insideAstonBBox(s.location))
    .map(s => ({ ...s, location: clampToAstonBBox(s.location) }));

  if (stops.length < 2) return { agents, vehicles: [] };

  const graph = getGraph(stops);
  const t = ((minute % DAY) + DAY) % DAY;

const routeById = new Map<string, BusRoute>((_routes || []).map(r => [r.id, r]));


  for (const agent of agents) {
    const a = agent as any;
    const daily: Trip[] = a._daily || [];
    let idx: number = a._tripIndex ?? 0;

    agent.currentLocation = clampToAstonBBox(agent.currentLocation);

    // dwell logic: if at destination, stay for a while
    if (a._dwellLeft && a._dwellLeft > 0) {
      a._dwellLeft -= 1;
      agent.state = idx === 0 ? 'at_home' : 'at_destination';
      agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
      continue;
    }

    // If idle: decide whether to depart
    if (!a._mode || a._mode === 'idle') {
      const next = daily[idx];

      if (!next) {
        agent.state = 'at_home';
        agent.targetLocation = null;
        continue;
      }

      if (t < next.depart) {
        agent.state = idx === 0 ? 'at_home' : 'at_destination';
        agent.targetLocation = null;
        continue;
      }

      agent.targetLocation = clampToAstonBBox(next.destination);

      // --- Car baseline (counterfactual) ---
// Hackathon baseline: "Without transit, this trip would be by car"
const tripKm = haversineDistance(agent.currentLocation, agent.targetLocation);
if (Number.isFinite(tripKm) && tripKm > 0) {
  agent.carBaselineCO2 =
    (agent.carBaselineCO2 ?? 0) + (CARBON_FACTORS.car_per_km * tripKm) / 1000; // kg
}



            // --- Phase 1: compute assignment plan based on active routes ---
      const activeRoutes = _routes || [];
      const plan = computeTripPlanLite(
        agent.currentLocation,
        agent.targetLocation,
        stops,
        activeRoutes
      );

      // store plan (Phase 2 will actually execute it)
      a._plan = plan;
            // keep these ids for UI/debug consistency
      if (plan.boardStopId) agent.nearestStopId = plan.boardStopId;
      if (plan.alightStopId) agent.destinationStopId = plan.alightStopId;

      // -----------------------------
      // MODE SWITCH:
      // assignment = execute plan (walk/wait/ride)
      // demand = baseline kNN movement to generate flows
      // -----------------------------
      if (mode === 'assignment') {
        // Start executing the chosen plan (Phase 2)
        a._mode = 'executing_plan';
        a._phase = 'idle';
        a._phaseLeft = 0;

        if (plan.mode === 'walk') {
          a._phase = 'walk_to_dest';
          a._phaseLeft = Math.max(0, Math.ceil(plan.walkAccessMin));
          agent.state = 'walking_to_dest';
        } else {
          a._phase = 'walk_to_stop';
          a._phaseLeft = Math.max(0, Math.ceil(plan.walkAccessMin));
          agent.state = 'walking_to_stop';
        }

        agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
        continue;
      }

      // mode === 'demand': baseline movement for generating flows
      const origin = nearestStop(stops, agent.currentLocation);
      const dest = nearestStop(stops, agent.targetLocation);
      recordFlow(origin.id, dest.id, minute);
recordFlow(dest.id, origin.id, minute); // optional: makes corridors bidirectional


      agent.nearestStopId = origin.id;
      agent.destinationStopId = dest.id;

      // ✅ Option A: Baseline demand = walk-only, but record demand on the stop graph
const path = shortestPath(graph, origin.id, dest.id);

if (path && path.length >= 2) {
  // Decompose OD into corridor edges (so generator still works well)
  for (let i = 0; i < path.length - 1; i++) {
    recordFlow(path[i], path[i + 1], minute);
    recordFlow(path[i + 1], path[i], minute); // bidirectional helps corridors
  }
} else {
  // Fallback: record OD directly
  recordFlow(origin.id, dest.id, minute);
  recordFlow(dest.id, origin.id, minute);
}

// Baseline movement is walk-only (no stops / no waiting / no transit)
a._mode = 'walk_direct';
agent.state = 'walking_to_dest';
continue;



    }


    
    // Transit
        // ----------------------------------
    // Phase 2: Execute plan (timed phases, snap locations)
    // ----------------------------------
    if (mode === 'assignment' && a._mode === 'executing_plan' && a._plan) {
      const plan = a._plan as TripPlan;

      // still clamp for safety
      agent.currentLocation = clampToAstonBBox(agent.currentLocation);

      // decrement phase timer
      if (a._phaseLeft > 0) {
  a._phaseLeft -= 1;

  // Smooth distance + CO2 accumulation (prevents popping)
  if (a._phase === 'walk_to_stop') {
    const denom = (plan.walkAccessMin + plan.walkEgressMin) || 1;
    const kmPerMin = plan.walkKm / denom;
    agent.distanceTraveled += kmPerMin;
  } else if (a._phase === 'walk_to_dest') {
    const denom = (plan.walkAccessMin + plan.walkEgressMin) || 1;
    const kmPerMin = plan.walkKm / denom;
    agent.distanceTraveled += kmPerMin;
  } else if (a._phase === 'ride') {
    const kmPerMin = plan.rideMin > 0 ? (plan.rideKm / plan.rideMin) : 0;
    agent.distanceTraveled += kmPerMin;
    agent.carbonEmitted += (CARBON_FACTORS.bus_per_passenger_km * kmPerMin) / 1000;
  }

  // Time + state updates
  if (a._phase === 'walk_to_stop' || a._phase === 'walk_to_dest') {
    agent.walkingTime += 1;
    agent.state = a._phase === 'walk_to_stop' ? 'walking_to_stop' : 'walking_to_dest';
  } else if (a._phase === 'wait') {
    agent.waitingTime += 1;
    agent.state = 'waiting';
  } else if (a._phase === 'ride') {
    agent.ridingTime += 1;
    agent.state = 'riding';
  }

  agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
  continue;
}


      // phase complete -> advance
      const stopById = new Map(stops.map(s => [s.id, s]));

      // WALK ONLY
      if (plan.mode === 'walk') {
        // snap to destination, begin dwell
        if (agent.targetLocation) agent.currentLocation = clampToAstonBBox(agent.targetLocation);

        agent.distanceTraveled += plan.walkKm;

        // Phase 3C: if walk-only is actually a "car trip" in the counterfactual, count it as car emissions in proposal
const CAR_TRIP_THRESHOLD_KM = 1.2;
if (plan.walkKm >= CAR_TRIP_THRESHOLD_KM) {
  agent.carbonEmitted += (CARBON_FACTORS.car_per_km * plan.walkKm) / 1000;
}




        const trip = daily[idx];
        a._dwellLeft = trip?.dwell ?? randInt(30, 120);
        agent.targetLocation = null;
        a._mode = 'idle';
        a._tripIndex = idx + 1;
        agent.state = 'at_destination';

        agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
        continue;
      }

      // BUS PHASES
      if (a._phase === 'walk_to_stop') {
  const b = plan.boardStopId ? stopById.get(plan.boardStopId) : null;
  if (!b) {
    a._phase = 'walk_to_dest';
    agent.state = 'walking_to_dest';
    continue;
  }

  const m = moveToward(agent.currentLocation, b.location, WALK_KM_PER_MIN);
  agent.currentLocation = clampToAstonBBox(m.next);
  agent.walkingTime += 1;
  agent.distanceTraveled += m.movedKm;
  agent.state = 'walking_to_stop';

  if (m.arrived) {
    a._phase = 'wait';
    a._waitLeft = Math.max(0, Math.round(plan.waitMin));
    agent.state = 'waiting';
  }

  agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
  continue;
}


      if (a._phase === 'wait') {
  // ✅ build ride segments stop-by-stop (so we can move along the corridor)
  const rids = plan.routeIds || [];
  const segments: string[][] = [];

  if (rids.length === 1 && plan.boardStopId && plan.alightStopId) {
    const r = routeById.get(rids[0]);
    const seg = r ? routeStopSegment(r, plan.boardStopId, plan.alightStopId) : null;
    if (seg && seg.length >= 2) segments.push(seg);
  }

  if (rids.length === 2 && plan.boardStopId && plan.transferStopId && plan.alightStopId) {
    const r1 = routeById.get(rids[0]);
    const r2 = routeById.get(rids[1]);
    const seg1 = r1 ? routeStopSegment(r1, plan.boardStopId, plan.transferStopId) : null;
    const seg2 = r2 ? routeStopSegment(r2, plan.transferStopId, plan.alightStopId) : null;
    if (seg1 && seg1.length >= 2) segments.push(seg1);
    if (seg2 && seg2.length >= 2) segments.push(seg2);
  }

  // If we failed to build segments, fall back to walking
  if (segments.length === 0) {
    a._phase = 'walk_to_dest';
    agent.state = 'walking_to_dest';
    continue;
  }

  // store ride plan
  a._rideSegments = segments;     // string[][]
  a._rideSegIndex = 0;            // which segment we're on
  a._rideStopCursor = 0;          // index within the segment

  a._phase = 'ride';
  agent.state = 'riding';
  continue;
}


      if (a._phase === 'ride') {
  const segs: string[][] = a._rideSegments || [];
  const segIndex: number = a._rideSegIndex ?? 0;
  const cursor: number = a._rideStopCursor ?? 0;

  if (!segs[segIndex] || segs[segIndex].length < 2) {
    a._phase = 'walk_to_dest';
    agent.state = 'walking_to_dest';
    continue;
  }

  const seg = segs[segIndex];
  const fromId = seg[cursor];
  const toId = seg[cursor + 1];

  if (!toId) {
    // segment finished
    if (segIndex + 1 < segs.length) {
      a._rideSegIndex = segIndex + 1;
      a._rideStopCursor = 0;
      agent.state = 'riding';
      continue;
    }
    // all ride done
    a._phase = 'walk_to_dest';
    agent.state = 'walking_to_dest';
    continue;
  }

  const toStop = stopById.get(toId);
  if (!toStop) {
    a._phase = 'walk_to_dest';
    agent.state = 'walking_to_dest';
    continue;
  }

  const m = moveToward(agent.currentLocation, toStop.location, TRANSIT_KM_PER_MIN);
  agent.currentLocation = clampToAstonBBox(m.next);
  agent.ridingTime += 1;
  agent.distanceTraveled += m.movedKm;

  // accrue bus CO₂ smoothly (instead of once-per-trip)
agent.carbonEmitted += (CARBON_FACTORS.bus_per_passenger_km * plan.rideKm) / 1000;

  agent.state = 'riding';

  if (m.arrived) {
    a._rideStopCursor = cursor + 1;
  }

  agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
  continue;
}


      if (a._phase === 'walk_to_dest' && agent.targetLocation) {
  const target = clampToAstonBBox(agent.targetLocation);
  const m = moveToward(agent.currentLocation, target, WALK_KM_PER_MIN);
  agent.currentLocation = clampToAstonBBox(m.next);
  agent.walkingTime += 1;
  agent.distanceTraveled += m.movedKm;
  agent.state = 'walking_to_dest';

  if (m.arrived) {
    const trip = daily[idx];
    a._dwellLeft = trip?.dwell ?? randInt(30, 120);
    agent.targetLocation = null;
    a._mode = 'idle';
    a._tripIndex = idx + 1;
    agent.state = 'at_destination';

    // cleanup ride buffers
    a._rideSegments = null;
    a._rideSegIndex = 0;
    a._rideStopCursor = 0;
  }

  agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
  continue;
}


    }
          // ----------------------------------
    // Demand-mode movement (baseline) - generates FLOW
    // ----------------------------------
    
    // ----------------------------------
// Demand-mode: walk to origin stop first
// ----------------------------------



if (mode === 'demand' && a._mode === 'transit' && a._path) {
  const path = a._path as string[];

      if (a._pathIndex >= path.length - 1) {
        a._mode = 'walk_final';
        agent.state = 'walking_to_dest';
        continue;
      }

      const fromId = path[a._pathIndex];
      const toId = path[a._pathIndex + 1];
      const toStop = stops.find(s => s.id === toId);

      if (!toStop) {
        a._mode = 'walk_direct';
        continue;
      }

      const m = moveToward(agent.currentLocation, toStop.location, TRANSIT_KM_PER_MIN);
      agent.currentLocation = clampToAstonBBox(m.next);
      agent.ridingTime++;
      agent.distanceTraveled += m.movedKm;
      agent.state = 'riding';

      // record demand flow on stop-to-stop edges
      recordFlow(fromId, toId, minute);

      if (m.arrived) a._pathIndex++;
      agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
      continue;
    }

    if (mode === 'demand' && a._mode === 'walk_final' && agent.targetLocation) {
      const target = clampToAstonBBox(agent.targetLocation);
      const m = moveToward(agent.currentLocation, target, WALK_KM_PER_MIN);
      agent.currentLocation = clampToAstonBBox(m.next);
      agent.walkingTime++;
      agent.distanceTraveled += m.movedKm;
      agent.state = 'walking_to_dest';

      if (m.arrived) {
        const trip = daily[idx];
        a._dwellLeft = trip?.dwell ?? randInt(30, 120);
        agent.targetLocation = null;
        a._mode = 'idle';
        a._tripIndex = idx + 1;
        agent.state = 'at_destination';
      }

      agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
      continue;
    }

    if (mode === 'demand' && a._mode === 'walk_direct' && agent.targetLocation) {
      const target = clampToAstonBBox(agent.targetLocation);
      const m = moveToward(agent.currentLocation, target, WALK_KM_PER_MIN);
      agent.currentLocation = clampToAstonBBox(m.next);
      agent.walkingTime++;
      agent.distanceTraveled += m.movedKm;
      agent.state = 'walking_to_dest';

      if (m.arrived) {
        const trip = daily[idx];
        a._dwellLeft = trip?.dwell ?? randInt(30, 120);
        agent.targetLocation = null;
        a._mode = 'idle';
        a._tripIndex = idx + 1;
        agent.state = 'at_destination';
      }

      agent.totalTimeSpent = agent.walkingTime + agent.ridingTime + agent.waitingTime;
      continue;
    }

  }

  // --- Service-based bus emissions (kg) ---
// Add CO2 based on how much bus service is operated this minute.
// Very defensible for hackathon: emissions scale with service, not ridership.
if (mode === 'assignment' && _routes && _routes.length) {
  // km of service operated per minute across all routes
  // assume each route runs once per headway; approximate frequency = 60/headway
  let serviceKmThisMinute = 0;

  for (const r of _routes) {
    const headway = Math.max(5, routeHeadwayMin(r)); // safety
    const freqPerHour = 60 / headway;
    const freqPerMinute = freqPerHour / 60;

    const km = r.geometry ? routeLengthKm(r.geometry as any) : 0;
    serviceKmThisMinute += km * freqPerMinute;
  }

  const busCO2kgThisMinute = (CARBON_FACTORS.bus_per_passenger_km * serviceKmThisMinute) / 1000;
  const perAgent = busCO2kgThisMinute / Math.max(1, agents.length);

  for (const a of agents) {
    a.carbonEmitted += perAgent;
  }
}



  return { agents, vehicles: [] };
}


// ----------------------------------
// Metrics
// ----------------------------------

export function calculateMetrics(agents: Agent[]): SimulationMetrics {
  
  const totalCO2 = agents.reduce((s, a) => s + a.carbonEmitted, 0);

// baseline: if everyone drove the distance they travelled
const totalDistKm = agents.reduce((s, a) => s + (a.distanceTraveled ?? 0), 0);
const totalCarBaselineCO2 =
  (CARBON_FACTORS.car_per_km * totalDistKm) / 1000; // kg

// remaining cars: only agents who *didn't* get a bus plan
const remainingCarDistKm = agents.reduce((s, a) => {
  const mode = (a as any)._lastPlanMode;
  return s + (mode === 'walk' ? (a.distanceTraveled ?? 0) : 0);
}, 0);

const remainingCarCO2 =
  (CARBON_FACTORS.car_per_km * remainingCarDistKm) / 1000; // kg

// scenario = bus service emissions (already in carbonEmitted) + remaining cars
const scenarioCO2 = totalCO2 + remainingCarCO2;

const co2Saved = Math.max(0, totalCarBaselineCO2 - scenarioCO2);

if (agents.length && agents.every(a => a.state === 'at_destination')) {
  console.log('[CO2 FINAL]', {
    totalCO2,
    totalCarBaselineCO2,
    co2Saved: Math.max(0, totalCarBaselineCO2 - totalCO2),
  });
}


  const totalDist = agents.reduce((s, a) => s + a.distanceTraveled, 0);

  const riding = agents.filter(a => a.state === 'riding').length;
  const walking = agents.filter(a => a.state === 'walking_to_stop' || a.state === 'walking_to_dest').length;
  const arrived = agents.filter(a => a.state === 'at_destination').length;
    const waiting = agents.filter(a => a.state === 'waiting').length;

  return {
    totalAgents: agents.length,
    activeAgents: agents.length - arrived,
    walkingAgents: walking,
    waitingAgents: waiting,
    ridingAgents: riding,
    arrivedAgents: arrived,
    averageTravelTime: agents.length ? agents.reduce((s, a) => s + a.totalTimeSpent, 0) / agents.length : 0,
    averageWaitTime: agents.length ? agents.reduce((s, a) => s + a.waitingTime, 0) / agents.length : 0,

    totalCO2: Math.round(scenarioCO2 * 100) / 100,
co2PerCapita: agents.length ? Math.round((scenarioCO2 / agents.length) * 1000) / 1000 : 0,
co2Saved: Math.round(co2Saved * 100) / 100,


    totalDistance: Math.round(totalDist * 100) / 100,
    averageAge: agents.length ? agents.reduce((s, a) => s + a.age, 0) / agents.length : 0,
    accessibilityCoverage: 100,
  };
}
