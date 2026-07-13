import { useCallback } from "react";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";

export const useExperimentalRestoreSettings = () => {
  const cwdRestore = useSettingsStore((state) => state.enableExperimentalCwdRestore);
  const agentSessionRestore = useSettingsStore(
    (state) => state.enableExperimentalAgentSessionRestore,
  );
  const setCwdRestore = useSettingsStore(
    (state) => state.setEnableExperimentalCwdRestore,
  );
  const setAgentSessionRestore = useSettingsStore(
    (state) => state.setEnableExperimentalAgentSessionRestore,
  );
  const setDangerousResume = useSettingsStore(
    (state) => state.setEnableExperimentalAgentDangerousResume,
  );

  const updateCwdRestore = useCallback((enabled: boolean) => {
    setCwdRestore(enabled);
    if (!enabled) useWorkspaceStore.getState().clearSavedCwd();
  }, [setCwdRestore]);

  const updateAgentSessionRestore = useCallback((enabled: boolean) => {
    setAgentSessionRestore(enabled);
    if (!enabled) {
      setDangerousResume(false);
      useWorkspaceStore.getState().clearSavedAgentSessions();
    }
  }, [setAgentSessionRestore, setDangerousResume]);

  return {
    cwdRestore,
    agentSessionRestore,
    updateCwdRestore,
    updateAgentSessionRestore,
  };
};
