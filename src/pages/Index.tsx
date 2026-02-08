// src/pages/Index.tsx

import { useCallback } from 'react';
import SimulationMap from '@/components/SimulationMap';
import ControlPanel from '@/components/ControlPanel';
import { useSimulation } from '@/hooks/useSimulation';
import { BUS_ROUTES } from '@/data/astonData';

export default function Index() {
  const {
    state,
    start,
    pause,
    resume,
    reset,
    setSpeed,
    toggleCorridors,
    toggleFlow,
    togglePOIs,
    selectAgent,
    clearGeneratedRoutes,
    generateFromFlow,
  } = useSimulation();

  const handleGenerateRoute = useCallback(() => {
    generateFromFlow();
  }, [generateFromFlow]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex-1 relative">
        <SimulationMap
          agents={state.agents}
          vehicles={state.vehicles}
          showFlow={(state as any).showFlow}
          showCorridors={(state as any).showCorridors}
          showPOIs={(state as any).showPOIs}
          pois={state.pois}
          generatedRoutes={state.generatedRoutes}
          selectedAgentId={state.selectedAgentId}
          onSelectAgent={selectAgent}
          baseRoutes={[]}
          stops={state.networkStops as any}
        />
      </div>

      <ControlPanel
        state={state as any}
        onStart={start}
        onPause={pause}
        onResume={resume}
        onReset={reset}
        onSetSpeed={setSpeed}
        onToggleFlow={toggleFlow}
        onToggleCorridors={toggleCorridors}
        onTogglePOIs={togglePOIs}
        onGenerateRoute={handleGenerateRoute}
        onClearRoutes={clearGeneratedRoutes}
      />
    </div>
  );
}