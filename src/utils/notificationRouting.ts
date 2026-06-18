import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";

export const shouldSuppressNotificationForActiveTarget = (
  workspaceId?: string | null,
  surfaceId?: string | null,
) => {
  if (!workspaceId) return false;
  if (typeof document === "undefined") return false;
  if (document.hidden || !document.hasFocus()) return false;

  const { activeId, workspaces } = useWorkspaceStore.getState();
  if (activeId !== workspaceId) return false;

  if (!surfaceId) return true;

  const workspace = workspaces.find((w) => w.id === workspaceId);
  return workspace?.focusedLeafId === surfaceId;
};

export const shouldShowNotificationForTarget = (
  workspaceId?: string | null,
  surfaceId?: string | null,
) => {
  if (!useSettingsStore.getState().enableNotifications) return false;
  return !shouldSuppressNotificationForActiveTarget(workspaceId, surfaceId);
};
