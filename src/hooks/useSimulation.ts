// src/hooks/useSimulation.ts

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUS_STOPS, ASTON_CENSUS, loadAstonPOIs ,randomHomeLocation, loadAstonBusStops} from '@/data/astonData';
import type { Agent, SimulationMetrics, BusRoute, BusStop, POI } from '@/types/simulation';
import { fetchNetwork } from '@/api/network'; // wherever your network.ts lives


import {
  createAgents,
  stepSimulation,
  calculateMetrics,
  generateRoutesFromFlow,
  clearFlow,
  getFlowEdges,
} from '@/simulation/engine';

const EMPTY_METRICS: SimulationMetrics = {
  totalAgents: 0,
  activeAgents: 0,
  walkingAgents: 0,
  waitingAgents: 0,
  ridingAgents: 0,
  arrivedAgents: 0,
  averageTravelTime: 0,
  averageWaitTime: 0,
  totalCO2: 0,
  co2PerCapita: 0,
  co2Saved: 0,
  totalDistance: 0,
  averageAge: 0,
  accessibilityCoverage: 0,
};

type AnalysisSnapshot = {
  minute: number;
  edges: number;
  totalTraversals: number;
  peakHour: number;
  totalCO2: number;
  totalDistanceKm: number;
};

type ProposalSnapshot = {
  minute: number;
  routesCount: number;
  routeKm: number;
  demandCapturedPct: number;
  demandCapturedTraversals: number;
  efficiency: number;
};

function computeFlowSummary() {
  const edges = getFlowEdges();
  const hourly = Array(24).fill(0);
  let totalTraversals = 0;

  for (const e of edges) {
    totalTraversals += e.count;
    for (let h = 0; h < 24; h++) hourly[h] += e.hourly[h] || 0;
  }

  const peakHour = hourly.reduce((bestH, v, h) => (v > hourly[bestH] ? h : bestH), 0);
  return { edgesCount: edges.length, totalTraversals, peakHour };
}

function routeLengthKm(geometry: [number, number][]) {
  let sum = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const [lat1, lon1] = geometry[i];
    const [lat2, lon2] = geometry[i + 1];
    const R = 6371;
    const x = ((lon2 - lon1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    const y = ((lat2 - lat1) * Math.PI / 180);
    sum += Math.sqrt(x * x + y * y) * R;
  }
  return sum;
}

function computeDemandCapturedByRoutes(generatedRoutes: BusRoute[]) {
  const flows = getFlowEdges();
  const flowByEdge = new Map<string, number>();
  let totalTraversals = 0;

  for (const f of flows) {
    flowByEdge.set(`${f.from}→${f.to}`, f.count);
    totalTraversals += f.count;
  }

  let captured = 0;
  for (const r of generatedRoutes) {
    if (!r.stopIds || r.stopIds.length < 2) continue;
    for (let i = 0; i < r.stopIds.length - 1; i++) {
      captured += flowByEdge.get(`${r.stopIds[i]}→${r.stopIds[i + 1]}`) ?? 0;
    }
  }

  captured = Math.min(captured, totalTraversals);
  const pct = totalTraversals > 0 ? (captured / totalTraversals) * 100 : 0;
  return { capturedTraversals: captured, totalTraversals, capturedPct: pct };
}

export function useSimulation() {
  const [pois, setPois] = useState<POI[]>([]);

  const [state, setState] = useState<any>({
    agents: [],
    vehicles: [],
    generatedRoutes: [],
    showRoutes: true,
    showFlow: true,
    showCorridors: true,
    networkStops: [],
    networkLoaded: false,
    currentMinute: 0,
    isRunning: false,
    isPaused: false,
    speed: 1,
    selectedAgentId: null,
    metrics: EMPTY_METRICS,

    simStartMinute: 6 * 60,
    simDurationMinutes: 16 * 60,

    analysis: {
      baseline: null as AnalysisSnapshot | null,
      proposal: null as ProposalSnapshot | null,
    },
  });

  useEffect(() => {
    console.log('[POI] loading...');
    loadAstonPOIs()
      .then((p) => {
        console.log('[POI] loaded', p.length);
        setPois(p);
      })
      .catch((err) => console.error('[POI] failed', err));
  }, []);
  
// useEffect(() => {
//   (async () => {
//     try {
//       const r = await fetch('http://localhost:8000/api/network');

//       console.log('[network] status:', r.status);

//       if (!r.ok) {
//         // This makes your OSM fallback run on 500/404/etc
//         throw new Error(`backend /api/network failed: ${r.status}`);
//       }

//       const net = await r.json();
//       console.log('[network] loaded stops:', net.stops?.length);

//       setState(prev => ({
//         ...prev,
//         networkStops: (net.stops ?? []).map((s: any) => ({
//           id: String(s.id),
//           name: s.name ?? String(s.id),
//           location: [Number(s.lat), Number(s.lng)] as [number, number],
//         })),
//         networkLoaded: true,
//       }));
//     } catch (err) {
//       console.error('[network] backend failed, falling back to OSM stops', err);

//       const osmStops = await loadAstonBusStops();
//       console.log('[network] OSM stops:', osmStops.length);

//       setState(prev => ({
//         ...prev,
//         networkStops: osmStops,
//         networkLoaded: true,
//       }));
//     }
//   })();
// }, []);
  
// new
useEffect(() => { // new use effect for parameterised values
  fetchNetwork(2500, 3)
    .then(net => {
      console.log('[network] loaded stops:', net.stops.length, 'routes:', net.routes.length);

      setState(prev => ({
        ...prev,
        networkStops: net.stops.map(s => ({
          id: String(s.id),
          name: s.name ?? String(s.id),
          location: [Number(s.lat), Number(s.lng)] as [number, number],
        })),
        networkLoaded: true,
      }));
    })
    .catch(async err => {
      console.error('[network] backend failed, falling back to OSM stops', err);
      const osmStops = await loadAstonBusStops();
      setState(prev => ({ ...prev, networkStops: osmStops, networkLoaded: true }));
    });
}, []);
  const timerRef = useRef<number | null>(null);

const start = useCallback(() => {
  console.log('[start] networkStops:', state.networkStops?.length, 'first:', state.networkStops?.[0]?.id);

  if (!state.networkStops || state.networkStops.length < 10) {
    console.warn('[start] stops not loaded yet:', state.networkStops?.length);
    return;
  }
  const seed = 1337;
  const agentCount = Math.min(800, ASTON_CENSUS.totalPopulation);

  console.log('[start] using pois:', pois.length);
  const agents = createAgents(agentCount, pois, () => randomHomeLocation(seed));

  clearFlow();

  setState((prev: any) => ({
    ...prev,
    // keep existing stops unless you actually computed new ones
    networkStops: prev.networkStops,
    networkLoaded: true,

    agents,
    vehicles: [],
    generatedRoutes: [],
    currentMinute: prev.simStartMinute,
    isRunning: true,
    isPaused: false,
    metrics: EMPTY_METRICS,
    analysis: { baseline: null, proposal: null },
  }));
  //Note: add state.networkStops to the dependency list because we read it in start().
}, [pois, state.networkStops]);

  const pause = useCallback(() => setState((prev: any) => ({ ...prev, isPaused: true })), []);
  const resume = useCallback(() => setState((prev: any) => ({ ...prev, isPaused: false })), []);

  const reset = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    clearFlow();
    setState((prev: any) => ({
      ...prev,
      agents: [],
      vehicles: [],
      generatedRoutes: [],
      currentMinute: 0,
      isRunning: false,
      isPaused: false,
      metrics: EMPTY_METRICS,
      analysis: { baseline: null, proposal: null },
    }));
  }, []);



  useEffect(() => {
    if (!state.isRunning || state.isPaused) return;

    timerRef.current = window.setInterval(() => {
      setState((prev: any) => {
        const endMinute = prev.simStartMinute + prev.simDurationMinutes;

        if (prev.currentMinute >= endMinute) {
          if (!prev.analysis?.baseline) {
            const flow = computeFlowSummary();
            const baseline: AnalysisSnapshot = {
              minute: prev.currentMinute,
              edges: flow.edgesCount,
              totalTraversals: flow.totalTraversals,
              peakHour: flow.peakHour,
              totalCO2: prev.metrics.totalCO2,
              totalDistanceKm: prev.metrics.totalDistance,
            };
            return { ...prev, isPaused: true, analysis: { ...prev.analysis, baseline } };
          }
          return { ...prev, isPaused: true };
        }

        const result = stepSimulation(prev.agents, [], prev.currentMinute, [], prev.networkStops);

        const agents: Agent[] = result.agents.map((a: Agent) => ({
          ...a,
          currentLocation: [a.currentLocation[0], a.currentLocation[1]] as [number, number],
        }));

        const metrics = calculateMetrics(agents);

        return {
          ...prev,
          agents,
          currentMinute: prev.currentMinute + 1,
          metrics,
        };
      });
    }, Math.max(20, 100 / state.speed));

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state.isRunning, state.isPaused, state.speed, state.networkStops]);

  const setSpeed = useCallback((speed: number) => setState((prev: any) => ({ ...prev, speed })), []);
  const toggleCorridors = useCallback(
  () => setState((prev: any) => ({ ...prev, showCorridors: !prev.showCorridors })),
  []
);

  const toggleRoutes = useCallback(() => setState((prev: any) => ({ ...prev, showRoutes: !prev.showRoutes })), []);
  const toggleFlow = useCallback(
  () => setState((prev: any) => ({ ...prev, showFlow: !prev.showFlow })),
  []
);
  const selectAgent = useCallback((id: string | null) => setState((prev: any) => ({ ...prev, selectedAgentId: id })), []);

  const clearGeneratedRoutes = useCallback(() => {
    setState((prev: any) => ({
      ...prev,
      generatedRoutes: [],
      analysis: { ...prev.analysis, proposal: null },
    }));
  }, []);

  const generateFromFlow = useCallback(() => {
  setState((prev: any) => {
  const stops = Array.isArray(prev.networkStops) ? prev.networkStops : BUS_STOPS;

    if (!Array.isArray(stops) || stops.length < 2) {
      console.warn('[generate] no valid stops', prev.networkStops);
      return prev;
    }

    // 🔍 DEBUG FLOW (ADD HERE)
    const flowEdges = getFlowEdges();
    console.log(
      '[generate] flow edges:',
      flowEdges.length,
      'top:',
      flowEdges[0]
    );

    if (flowEdges.length === 0) {
      console.warn('[generate] no flow yet - run sim for a bit first');
      return prev;
    }

    const routes = generateRoutesFromFlow(stops, {
      topEdges: 120,
      minCount: 8,
      maxRoutes: 8,
      maxStopsPerRoute: 18,
    });
    console.log('[generate] stops in use:', stops.length, 'sample:', stops.slice(0, 3));
    console.log('[generate] stop id sample:', stops.slice(0, 10).map(s => s.id));
    console.log('[generate] routes:', routes.length, routes[0]);
    console.log('[generate] using stops:', stops.length, 'first:', stops[0]);
    const { capturedTraversals, capturedPct } = computeDemandCapturedByRoutes(routes);

    const routeKm = routes.reduce(
      (s: number, r: BusRoute) => s + (r.geometry ? routeLengthKm(r.geometry as any) : 0),
      0
    );

    const efficiency = routeKm > 0 ? capturedTraversals / routeKm : 0;

    const proposal: ProposalSnapshot = {
      minute: prev.currentMinute,
      routesCount: routes.length,
      routeKm: Math.round(routeKm * 100) / 100,
      demandCapturedPct: Math.round(capturedPct * 10) / 10,
      demandCapturedTraversals: capturedTraversals,
      efficiency: Math.round(efficiency * 10) / 10,
    };

      return { ...prev, generatedRoutes: routes, analysis: { ...prev.analysis, proposal } };
    });
  }, []);
  return {
  state,
  pois,
  start,
  pause,
  resume,
  reset,
  setSpeed,
  selectAgent,
  clearGeneratedRoutes,
  generateFromFlow,
  toggleFlow,
  toggleCorridors,
  toggleRoutes,
  };
}
