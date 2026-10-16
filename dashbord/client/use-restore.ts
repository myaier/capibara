import { useCallback, useEffect, useRef, useState } from "react";
import { usePaseo, useRpc } from "./fleet-client";
import { followRestore, restoreSession, restoreSessionStatus, type RestoreSessionResult } from "../shared/history";
import { useForeground } from "./use-foreground";

export interface RestoreSessionControl {
  /**
   * Starts restoring the archived session (a second call while it runs joins it) and resolves with how it ended. Never
   * rejects: a host timeout or a lost connection resolves as `pending` with 「宿主仍在恢复，稍后刷新查看。」, other errors as a
   * Chinese `failed`; `restored` and `already_active` mean the session can be opened. Leaving the view resolves it as `pending`.
   */
  restore(): Promise<RestoreSessionResult>;
  /** From the tap until the outcome. */
  restoring: boolean;
  /** The server's current step while restoring (e.g. 「正在重建关联的 worktree，可能要一两分钟」); null before the first answer. */
  progress: string | null;
}

/**
 * 恢复会话 as a job (opus-F73): the server answers at once and the restore is read every 2.5 s while the app is in the
 * foreground; in the background the next read waits for it to come back.
 */
export function useRestoreSession(agentId: string): RestoreSessionControl {
  const start = useRpc(restoreSession), status = useRpc(restoreSessionStatus), paseo = usePaseo();
  const foreground = useForeground(), front = useRef(foreground), mounted = useRef(true);
  front.current = foreground;
  const flight = useRef<{ agentId: string; promise: Promise<RestoreSessionResult> } | null>(null);
  const [state, setState] = useState<{ agentId: string; progress: string | null } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const restore = useCallback((): Promise<RestoreSessionResult> => {
    if (flight.current?.agentId === agentId) return flight.current.promise;
    const wait = (ms: number) => new Promise<boolean>(resolve => {
      const check = () => { if (!mounted.current) resolve(false); else if (front.current) resolve(true); else setTimeout(check, 1000); };
      setTimeout(check, ms);
    });
    const promise = followRestore({ agentId, wait, start: () => start({ agentId }), status: jobId => status({ jobId }),
      // Read-only (fetch_agent): it never loads the session.
      archived: async () => { const snapshot = await paseo.agents.ref(agentId).refresh(); return snapshot?.agent ? !!snapshot.agent.archivedAt : null; },
      onProgress: progress => { if (mounted.current) setState(current => current?.agentId === agentId ? { agentId, progress } : current); } })
      .finally(() => {
        if (flight.current?.promise === promise) flight.current = null;
        if (mounted.current) setState(current => current?.agentId === agentId ? null : current);
      });
    flight.current = { agentId, promise };
    setState({ agentId, progress: null });
    return promise;
  }, [agentId, paseo, start, status]);
  return { restore, restoring: state?.agentId === agentId, progress: state?.agentId === agentId ? state.progress : null };
}
