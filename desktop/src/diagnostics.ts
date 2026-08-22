import type { AccessStatus, ChatGPTConnectionPhase, CopyCatalog, DesktopSnapshot, RuntimePhase } from "./types";

export type TroubleshootingStep =
  | "not_applied"
  | "waiting_confirmation"
  | "preparing_connection"
  | "starting_local_service"
  | "recovering_connection"
  | "ready"
  | "runtime_blocked"
  | "other_connection"
  | "needs_attention";

export function troubleshootingNeedsAttention(access: AccessStatus, snapshot: DesktopSnapshot | null): boolean {
  return Boolean(
    snapshot?.error
      || snapshot?.runtimePhase === "blocked"
      || ["recovery_required", "rejected", "expired", "revoked"].includes(access.status),
  );
}

export function troubleshootingStep(access: AccessStatus, snapshot: DesktopSnapshot | null): TroubleshootingStep {
  if (snapshot?.error?.code === "OTHER_PROCESS") return "other_connection";
  if (access.status === "not_applied") return "not_applied";
  if (access.status === "pending") return "waiting_confirmation";
  if (access.status === "provisioning") return "preparing_connection";
  if (["recovery_required", "rejected", "expired", "revoked"].includes(access.status)) return "needs_attention";
  if (!snapshot?.configured) return "preparing_connection";
  if (snapshot.runtimePhase === "ready") return "ready";
  if (snapshot.runtimePhase === "recovering") return "recovering_connection";
  if (["starting", "connecting"].includes(snapshot.runtimePhase)) return "starting_local_service";
  if (snapshot.runtimePhase === "blocked") return "runtime_blocked";
  return "needs_attention";
}

export function troubleshootingStatus(access: AccessStatus, snapshot: DesktopSnapshot | null, copy: CopyCatalog): string {
  const step = troubleshootingStep(access, snapshot);
  if (step === "ready") return copy.ready;
  if (step === "other_connection") return copy.stepNeedsAttention;
  if (step === "runtime_blocked") return copy.blocked;
  if (step === "recovering_connection") return copy.recovering;
  if (step === "waiting_confirmation" || step === "preparing_connection") return copy.preparing;
  if (step === "not_applied") return copy.applicationNotStarted;
  return copy.stepNeedsAttention;
}

export function troubleshootingStepLabel(step: TroubleshootingStep, copy: CopyCatalog): string {
  const labels: Record<TroubleshootingStep, string> = {
    not_applied: copy.stepNotApplied,
    waiting_confirmation: copy.stepWaitingConfirmation,
    preparing_connection: copy.stepPreparingConnection,
    starting_local_service: copy.stepStartingLocalService,
    recovering_connection: copy.stepRecoveringConnection,
    ready: copy.stepReady,
    runtime_blocked: copy.stepRuntimeBlocked,
    other_connection: copy.stepOtherConnection,
    needs_attention: copy.stepNeedsAttention,
  };
  return labels[step];
}

export function applicationStatusLabel(status: AccessStatus["status"], copy: CopyCatalog): string {
  if (status === "not_applied") return copy.applicationNotStarted;
  if (status === "pending") return copy.applicationWaiting;
  if (status === "provisioning") return copy.applicationPreparing;
  if (["approved", "active", "activated"].includes(status)) return copy.applicationReady;
  if (status === "recovery_required") return copy.applicationRecovery;
  if (status === "rejected") return copy.applicationRejected;
  return copy.applicationEnded;
}

export function platformLabel(platform: string): string {
  if (platform === "windows-x86_64") return "Windows";
  if (platform === "macos-aarch64") return "macOS Apple 芯片";
  if (platform === "macos-x86_64") return "macOS Intel 芯片";
  if (platform.startsWith("macos-")) return "macOS";
  return platform || "这台电脑";
}

export function formatLastChecked(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(unixSeconds * 1000));
  } catch {
    return "—";
  }
}

export function runtimePhaseForDiagnostics(snapshot: DesktopSnapshot | null): RuntimePhase | "unknown" {
  return snapshot?.runtimePhase ?? "unknown";
}

export function chatgptConnectionLabel(phase: ChatGPTConnectionPhase | undefined, copy: CopyCatalog): string {
  if (phase === "setup_opened") return copy.chatgptSetupOpened;
  if (phase === "authorization_requested") return copy.chatgptAuthorizationRequested;
  if (phase === "oauth_completed") return copy.chatgptOauthCompleted;
  if (phase === "connected") return copy.chatgptConnected;
  if (phase === "first_task_completed") return copy.chatgptFirstTaskCompleted;
  return copy.chatgptNotStarted;
}
