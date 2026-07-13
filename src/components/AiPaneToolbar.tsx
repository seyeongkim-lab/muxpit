import { useEffect, useMemo } from "react";
import { useAiCliStore, AI_KINDS, AI_LABEL, buildAiLaunchSpec } from "../stores/aiCli";
import { useWorkspaceStore, type AiKind } from "../stores/workspace";
import { useSshHostsStore, buildSshCommand, buildSshConnection } from "../stores/sshHosts";
import { parseSshCommandLine, sshConnectionToCommandLine, type SshConnection } from "../utils/sshConnection";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { getTmuxActivePaneCwd } from "../stores/tmuxSessions";

interface AiPaneToolbarProps {
  workspaceId: string;
  leafId: string;
  /** AI CLI currently running in this pane. We hide its own button. */
  currentKind: AiKind;
  /** `user@host` of the underlying SSH connection — keys availability lookup. */
  sshTarget: string;
  sshConnection?: SshConnection;
}

/**
 * Renders a thin row of "+ <ai>" buttons on top of a pane that is already
 * running an AI CLI. Buttons appear only for AI CLIs that the host probe
 * found installed (and excludes the one already running here).
 *
 * The probe itself is dispatched in `App.autoAiSplit` at connect time. If we
 * mount before the probe finished (e.g. session restore), we kick a deferred
 * probe by reusing the parent leaf's ssh command — best-effort, silent on
 * failure.
 */
export const AiPaneToolbar = ({ workspaceId, leafId, currentKind, sshTarget, sshConnection }: AiPaneToolbarProps) => {
  const available = useAiCliStore((s) => s.availableByHost[sshTarget]);
  const probe = useAiCliStore((s) => s.probe);
  const splitLeafWithCommand = useWorkspaceStore((s) => s.splitLeafWithCommand);
  const hosts = useSshHostsStore((s) => s.hosts);
  const cwd = useWorkspaceInfoStore(
    (s) => s.leafCwds[workspaceId]?.[leafId] ?? s.info[workspaceId]?.cwd,
  );

  const host = useMemo(
    () => hosts.find((h) => `${h.user}@${h.host}` === sshTarget),
    [hosts, sshTarget],
  );

  // Build a *clean* base ssh command (no embedded remote payload) for both the
  // probe fallback and new pane launches. Reusing the parent leaf's `command`
  // would splice another remote payload into an ssh invocation that already has
  // one, producing `ssh ... "...claude..." "...codex..."` — ssh joins those args
  // and the resulting remote command is garbage.
  const baseSshCommand = useMemo(
    () => (sshConnection ? sshConnectionToCommandLine(sshConnection) : host ? buildSshCommand(host) : `ssh ${sshTarget}`),
    [sshConnection, host, sshTarget],
  );
  const baseSshConnection = useMemo(
    () => sshConnection ?? (host ? buildSshConnection(host) : parseSshCommandLine(baseSshCommand)?.connection),
    [sshConnection, host, baseSshCommand],
  );

  // Re-probe lazily if availability is unknown for this target (e.g. session
  // restored before `App.autoAiSplit` got a chance to populate the cache).
  useEffect(() => {
    if (available !== undefined) return;
    probe(sshTarget, baseSshCommand, baseSshConnection).catch(() => {});
  }, [available, sshTarget, baseSshCommand, baseSshConnection, probe]);

  const handleAdd = async (kind: AiKind) => {
    const launchCwd = cwd ?? await getTmuxActivePaneCwd(workspaceId).catch(() => undefined);
    const spec = buildAiLaunchSpec(kind, baseSshCommand, baseSshConnection, launchCwd);
    splitLeafWithCommand(workspaceId, leafId, "vertical", spec.command, {
      aiKind: kind,
      aiSshTarget: sshTarget,
      sshConnection: spec.sshConnection,
      sshRemoteCommand: spec.sshRemoteCommand,
    });
  };

  const candidates = AI_KINDS.filter((k) => k !== currentKind && available?.has(k));
  if (!available || candidates.length === 0) return null;

  return (
    <div className="wmux-ai-bar">
      <span className="wmux-ai-bar-label">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2zm6 12l.8 2.7L21 17.5l-2.2.8L18 21l-.8-2.7L15 17.5l2.2-.8L18 14zM5 14l.6 2L7 16.5l-1.4.5L5 19l-.6-2L3 16.5l1.4-.5L5 14z" />
        </svg>
        Add AI Pane
      </span>
      {candidates.map((k) => (
        <button
          key={k}
          className="wmux-ai-btn"
          onClick={() => void handleAdd(k)}
          title={`Open a ${AI_LABEL[k]} pane on ${sshTarget}`}
        >
          {AI_LABEL[k]}
        </button>
      ))}
    </div>
  );
};
