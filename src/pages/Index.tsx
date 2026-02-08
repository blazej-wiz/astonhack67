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
    toggleRoutes,          // ✅ if you want the panel to toggle “routes”
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
          generatedRoutes={state.generatedRoutes}
          selectedAgentId={state.selectedAgentId}
          onSelectAgent={selectAgent}
          showFlow={state.showFlow}
          showCorridors={state.showCorridors}
          stops={state.networkStops}
          baseRoutes={state.showRoutes ? BUS_ROUTES : []}
          showRoutes={state.showRoutes}
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
        onGenerateRoute={handleGenerateRoute}
        onClearRoutes={clearGeneratedRoutes}
      />
    </div>
  );
}