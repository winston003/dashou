import type { AccessStatus, AvailableUpdate, ChatGPTConnectionPhase, DesktopSnapshot, Preferences, RuntimePhase } from "./types";

export type Tab = "use" | "settings";

export type AppState = {
  tab: Tab;
  snapshot: DesktopSnapshot | null;
  access: AccessStatus;
  selectedRoots: string[];
  rootsDirty: boolean;
  loading: boolean;
  busy: string | null;
  helpOpen: boolean;
  toast: string | null;
  error: string | null;
  preferences: Preferences;
  availableUpdate: AvailableUpdate | null;
};

export const initialState: AppState = {
  tab: "use",
  snapshot: null,
  access: { status: "not_applied" },
  selectedRoots: [],
  rootsDirty: false,
  loading: true,
  busy: null,
  helpOpen: false,
  toast: null,
  error: null,
  preferences: { launchAtLogin: true, notifyWhenReady: false },
  availableUpdate: null,
};

export type Action =
  | { type: "snapshot"; snapshot: DesktopSnapshot; syncRoots?: boolean }
  | { type: "access"; access: AccessStatus }
  | { type: "roots"; roots: string[] }
  | { type: "tab"; tab: Tab }
  | { type: "loading"; value: boolean }
  | { type: "busy"; value: string | null }
  | { type: "help"; value: boolean }
  | { type: "toast"; value: string | null }
  | { type: "error"; value: string | null }
  | { type: "preferences"; value: Preferences }
  | { type: "availableUpdate"; value: AvailableUpdate | null };

export function phaseLabel(phase: RuntimePhase): "preparing" | "connecting" | "ready" | "recovering" | "blocked" | "stopped" {
  if (phase === "starting") return "preparing";
  if (phase === "connecting") return "connecting";
  if (phase === "ready") return "ready";
  if (phase === "recovering") return "recovering";
  if (phase === "blocked") return "blocked";
  return "stopped";
}

export function accessIsReady(snapshot: DesktopSnapshot | null, access: AccessStatus): boolean {
  return Boolean(snapshot?.configured || ["approved", "active", "activated"].includes(access.status));
}

export function accessIsWaiting(access: AccessStatus): boolean {
  return access.status === "pending" || access.status === "provisioning";
}

export function shouldPollAccess(access: AccessStatus): boolean {
  return ["not_applied", "pending", "provisioning", "approved"].includes(access.status);
}

export function canRemoveRoot(roots: string[]): boolean {
  return roots.length > 1;
}

export function canCopyPassword(snapshot: DesktopSnapshot | null): boolean {
  return Boolean(
    snapshot?.configured
      && snapshot.localHealth
      && snapshot.runtimePhase !== "blocked"
      && snapshot.runtimePhase !== "stopped",
  );
}

export function chatgptGuideStep(phase: ChatGPTConnectionPhase): 1 | 2 | 3 {
  if (phase === "not_started") return 1;
  if (phase === "setup_opened") return 2;
  if (phase === "authorization_requested") return 3;
  return 3;
}

function rootsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((root) => rightSet.has(root));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "snapshot":
      {
        const syncRoots = action.syncRoots ?? !state.rootsDirty;
        const connectionIsHealthy = action.snapshot.runtimePhase === "ready"
          && action.snapshot.localHealth
          && action.snapshot.publicHealth;
        return {
          ...state,
          snapshot: action.snapshot,
          selectedRoots: syncRoots ? action.snapshot.allowedRoots : state.selectedRoots,
          rootsDirty: syncRoots ? false : state.rootsDirty,
          // A restart/ownership error is an operation result, not a durable
          // diagnosis. Once a fresh snapshot proves both sides are healthy,
          // remove the stale banner instead of making users keep seeing it.
          error: connectionIsHealthy ? null : state.error,
          preferences: {
            launchAtLogin: action.snapshot.launchAtLogin,
            notifyWhenReady: action.snapshot.notifyWhenReady,
          },
          loading: false,
        };
      }
    case "access":
      return { ...state, access: action.access, error: null };
    case "roots":
      {
        const selectedRoots = [...new Set(action.roots.filter(Boolean))];
        return {
          ...state,
          selectedRoots,
          rootsDirty: !rootsEqual(selectedRoots, state.snapshot?.allowedRoots ?? []),
        };
      }
    case "tab":
      return { ...state, tab: action.tab };
    case "loading":
      return { ...state, loading: action.value };
    case "busy":
      return { ...state, busy: action.value };
    case "help":
      return { ...state, helpOpen: action.value };
    case "toast":
      return { ...state, toast: action.value };
    case "error":
      return { ...state, error: action.value };
    case "preferences":
      return { ...state, preferences: action.value };
    case "availableUpdate":
      return { ...state, availableUpdate: action.value };
    default:
      return state;
  }
}
