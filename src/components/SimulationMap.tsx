import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { Agent, Vehicle, BusRoute, POI } from '@/types/simulation';
import { ASTON_BOUNDARY, ASTON_CENTER, ASTON_ZOOM, BUS_STOPS } from '@/data/astonData';
import { getFlowEdges } from '@/simulation/engine';

// Age to color interpolation
function ageToColor(age: number): string {
  const t = Math.min(age / 90, 1);
  const h = 80 + t * 72;
  const s = 70;
  const l = 55 - t * 10;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function stateToOpacity(state: Agent['state']): number {
  switch (state) {
    case 'at_home': return 0.35;
    case 'walking_to_stop': return 0.8;
    case 'waiting': return 0.9;
    case 'riding': return 1;
    case 'walking_to_dest': return 0.8;
    case 'at_destination': return 0.25;
    default: return 0.75;
  }
}

function stateToRadius(state: Agent['state']): number {
  switch (state) {
    case 'riding': return 5;
    case 'waiting': return 4.5;
    case 'walking_to_stop':
    case 'walking_to_dest': return 4;
    default: return 3.5;
  }
}

type SimpleStop = {
  id: string;
  name: string;
  location: [number, number];
};

interface SimulationMapProps {
  agents: Agent[];
  vehicles: Vehicle[];
  generatedRoutes: BusRoute[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  showFlow: boolean;
  showCorridors: boolean;

  showPOIs: boolean;
  pois: POI[];

  baseRoutes?: BusRoute[];
  stops?: SimpleStop[];
}

function poiColor(type: POI['type']) {
  switch (type) {
    case 'education': return 'hsl(210, 80%, 60%)';
    case 'employment': return 'hsl(35, 90%, 55%)';
    case 'retail': return 'hsl(300, 70%, 60%)';
    case 'healthcare': return 'hsl(0, 80%, 60%)';
    case 'social': return 'hsl(160, 70%, 50%)';
    case 'leisure': return 'hsl(190, 80%, 55%)';
    case 'religious': return 'hsl(270, 60%, 60%)';
    case 'transport': return 'hsl(50, 90%, 55%)';
    default: return 'hsl(0,0%,70%)';
  }
}

export default function SimulationMap({
  agents,
  vehicles,
  generatedRoutes,
  selectedAgentId,
  onSelectAgent,
  baseRoutes,
  stops,
  showFlow,
  showCorridors,
  showPOIs,
  pois,
}: SimulationMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  const agentLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const stopsLayerRef = useRef<L.LayerGroup | null>(null);
  const flowLayerRef = useRef<L.LayerGroup | null>(null);
  const poiLayerRef = useRef<L.LayerGroup | null>(null);

  const agentMarkersRef = useRef<Map<string, L.CircleMarker>>(new Map());

  // IMPORTANT: in Skyline mode, if baseRoutes is provided, never fall back.
  const effectiveRoutes = baseRoutes !== undefined ? baseRoutes : [];

  const fallbackStops: SimpleStop[] = (BUS_STOPS as any[])
    .map((s) => ({
      id: String(s.id),
      name: String(s.name ?? s.id),
      location: (s.location ?? s.position) as [number, number],
    }))
    .filter(s => Array.isArray(s.location) && s.location.length === 2);

  const effectiveStops = stops && stops.length > 0 ? stops : fallbackStops;

  // Build stop lookup (for flow layer)
  const stopById = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const s of effectiveStops) m.set(String(s.id), s.location);
    return m;
  }, [effectiveStops]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: ASTON_CENTER,
      zoom: ASTON_ZOOM,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Aston boundary
    L.polygon(
      (ASTON_BOUNDARY as any).map(([lat, lng]: any) => [lat, lng] as L.LatLngTuple),
      {
        color: 'hsl(152, 70%, 45%)',
        weight: 1.5,
        opacity: 0.4,
        fillColor: 'hsl(152, 70%, 45%)',
        fillOpacity: 0.03,
        dashArray: '5, 5',
      }
    ).addTo(map);

    agentLayerRef.current = L.layerGroup().addTo(map);
    vehicleLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    stopsLayerRef.current = L.layerGroup().addTo(map);
    flowLayerRef.current = L.layerGroup().addTo(map);
    poiLayerRef.current = L.layerGroup().addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // POI layer
  useEffect(() => {
    if (!poiLayerRef.current) return;
    poiLayerRef.current.clearLayers();
    if (!showPOIs) return;
    if (!pois || pois.length === 0) return;

    const maxToRender = 450; // keep map responsive
    const list = pois.slice(0, maxToRender);

    for (const p of list) {
      const c = poiColor(p.type);
      const marker = L.circleMarker(p.location as any, {
        radius: 4,
        weight: 1,
        opacity: 0.6,
        fillOpacity: 0.65,
        color: c,
        fillColor: c,
      } as any);

      const debug = (p as any).osmTag ? `<div style="opacity:0.7;font-size:11px">${(p as any).osmTag}</div>` : '';
      marker.bindTooltip(
        `<div style="font-size:12px">
          <div style="font-weight:600">${p.name}</div>
          <div style="opacity:0.8">type: ${p.type}</div>
          ${debug}
        </div>`,
        { sticky: true }
      );

      marker.addTo(poiLayerRef.current);
    }
  }, [showPOIs, pois]);

  // ✅ Stops layer (NOW ADDED)
  useEffect(() => {
    if (!stopsLayerRef.current) return;
    stopsLayerRef.current.clearLayers();
    if (!effectiveStops || effectiveStops.length === 0) return;

    const maxStops = 250; // keep map responsive
    const list = effectiveStops.slice(0, maxStops);

    for (const s of list) {
      const marker = L.circleMarker(s.location as any, {
        radius: 3,
        weight: 1,
        opacity: 0.7,
        fillOpacity: 0.65,
        color: 'hsl(0, 0%, 85%)',
        fillColor: 'hsl(0, 0%, 85%)',
      } as any);

      marker.bindTooltip(
        `<div style="font-size:12px">
          <div style="font-weight:600">${s.name}</div>
          <div style="opacity:0.8">id: ${String(s.id)}</div>
        </div>`,
        { sticky: true }
      );

      marker.addTo(stopsLayerRef.current);
    }
  }, [effectiveStops]);

  // Flow layer
  useEffect(() => {
    if (!flowLayerRef.current) return;
    flowLayerRef.current.clearLayers();
    if (!showFlow) return;

    const flowEdges = getFlowEdges();
    if (!flowEdges.length) return;

    const sorted = flowEdges.slice().sort((a, b) => b.count - a.count).slice(0, 250);
    const maxCount = sorted[0]?.count ?? 1;

    for (const e of sorted) {
      const a = stopById.get(String(e.from));
      const b = stopById.get(String(e.to));
      if (!a || !b) continue;

      const t = e.count / maxCount;
      const weight = 1 + t * 6;

      L.polyline([a, b] as any, {
        color: 'hsl(152, 70%, 55%)',
        weight,
        opacity: 0.12 + t * 0.25,
      }).addTo(flowLayerRef.current);
    }
  }, [showFlow, stopById, agents]);

  // Routes layer (generated corridors)
  useEffect(() => {
    if (!routeLayerRef.current) return;
    routeLayerRef.current.clearLayers();

    const allRoutes = [...(showRoutes ? effectiveRoutes : []),...(showCorridors ? generatedRoutes : []),
];
    if (allRoutes.length === 0) return;

    const flow = getFlowEdges();
    const flowCountByEdge = new Map<string, number>();
    for (const f of flow) flowCountByEdge.set(`${f.from}→${f.to}`, f.count);

    for (const route of allRoutes) {
      if (!route.geometry || route.geometry.length === 0) continue;

      const isGenerated = generatedRoutes.some(gr => gr.id === route.id);

      let demandScore = 0;
      if (isGenerated && route.stopIds && route.stopIds.length > 1) {
        for (let i = 0; i < route.stopIds.length - 1; i++) {
          demandScore += flowCountByEdge.get(`${route.stopIds[i]}→${route.stopIds[i + 1]}`) ?? 0;
        }
      }

      const weight = isGenerated ? Math.min(9, 3 + Math.log10(1 + demandScore) * 3) : 3;

      L.polyline(route.geometry as any, {
        color: route.color,
        weight,
        opacity: isGenerated ? 0.85 : 0.55,
        dashArray: isGenerated ? '8, 4' : undefined,
      })
        .bindTooltip(route.name, { sticky: true })
        .addTo(routeLayerRef.current);
    }
  }, [showRoutes, showCorridors, generatedRoutes, effectiveRoutes, agents]);

  // Agents layer
  useEffect(() => {
    if (!agentLayerRef.current) return;

    const existingMarkers = agentMarkersRef.current;
    const currentAgentIds = new Set(agents.map(a => a.id));

    for (const [id, marker] of existingMarkers) {
      if (!currentAgentIds.has(id)) {
        agentLayerRef.current.removeLayer(marker);
        existingMarkers.delete(id);
      }
    }

    for (const agent of agents) {
      const color = ageToColor(agent.age);
      const opacity = stateToOpacity(agent.state);
      const radius = stateToRadius(agent.state);
      const isSelected = agent.id === selectedAgentId;

      let marker = existingMarkers.get(agent.id);
      if (marker) {
        marker.setLatLng(agent.currentLocation as any);
        marker.setStyle({
          fillColor: isSelected ? '#ffffff' : color,
          fillOpacity: isSelected ? 1 : opacity,
          radius: isSelected ? 8 : radius,
          weight: isSelected ? 2 : 0,
          color: isSelected ? '#ffffff' : color,
        } as any);
      } else {
        marker = L.circleMarker(agent.currentLocation as any, {
          radius: isSelected ? 8 : radius,
          fillColor: isSelected ? '#ffffff' : color,
          fillOpacity: isSelected ? 1 : opacity,
          weight: isSelected ? 2 : 0,
          color: isSelected ? '#ffffff' : color,
        } as any);

        marker.on('click', () => onSelectAgent(agent.id));
        marker.addTo(agentLayerRef.current);
        existingMarkers.set(agent.id, marker);
      }
    }
  }, [agents, selectedAgentId, onSelectAgent]);

  return <div ref={mapContainerRef} className="w-full h-full" />;
}
