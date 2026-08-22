import { useCallback, useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { defaultCopy, mergeCopy } from "./copy";
import { setAutostart, tauriBridge, normalizeBridgeError, type Bridge } from "./bridge";
import { reducer, initialState, phaseLabel, accessIsReady, accessIsWaiting, accessCanApply, shouldPollAccess, canCopyPassword } from "./state";
import type { AccessStatus, CopyCatalog, DesktopSnapshot, Preferences, RuntimePhase } from "./types";
import { applicationStatusLabel, troubleshootingNeedsAttention, troubleshootingStatus, troubleshootingStep, troubleshootingStepLabel } from "./diagnostics";
import { FolderPicker } from "./components/FolderPicker";
import { ProgressSteps } from "./components/ProgressSteps";
import { SettingsView } from "./components/SettingsView";
import { TroubleshootingCard } from "./components/TroubleshootingCard";
import { ChatGPTConnectGuide } from "./components/ChatGPTConnectGuide";
import "./styles.css";
import handMark from "./assets/hand-mark.svg";
import mascot from "./assets/mascot.png";

type Props = { bridge?: Bridge };

const statusCopy: Record<string, keyof CopyCatalog> = {
  starting: "preparing",
  connecting: "connecting",
  ready: "ready",
  recovering: "recovering",
  blocked: "blocked",
  stopped: "stopped",
};

export function App({ bridge = tauriBridge }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [copy, setCopy] = useReducer((current: CopyCatalog, value: unknown) => mergeCopy(value), defaultCopy);
  const copyRef = useRef(copy);
  const pollRef = useRef<number | undefined>();
  const loadInFlight = useRef<Promise<void> | null>(null);
  const accessRef = useRef(state.access);
  const toastTimer = useRef<number | undefined>();
  const previousPhase = useRef<RuntimePhase | null>(null);
  const autostartSynced = useRef(false);
  const accessFailureRecorded = useRef(false);
  const activationRecorded = useRef(false);
  const runtimeReadyRecorded = useRef(false);
  const connectionPhaseRecorded = useRef<string | null>(null);

  const toast = useCallback((message: string) => {
    dispatch({ type: "toast", value: message });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => dispatch({ type: "toast", value: null }), 3200);
  }, []);

  const load = useCallback((withAccess = true, syncRoots = false): Promise<void> => {
    if (loadInFlight.current) return loadInFlight.current;

    let task: Promise<void>;
    task = (async () => {
      try {
        const snapshot = await bridge.snapshot();
        dispatch({ type: "snapshot", snapshot, syncRoots });
        if (snapshot.runtimePhase === "recovering" && previousPhase.current !== "recovering") void bridge.recordEvent("runtime_recovering");
        if (snapshot.runtimePhase === "blocked" && previousPhase.current !== "blocked") void bridge.recordEvent("runtime_blocked", "error", snapshot.error?.code);
        if (snapshot.runtimePhase === "ready" && !runtimeReadyRecorded.current) {
          runtimeReadyRecorded.current = true;
          void bridge.recordEvent("runtime_ready");
        }
        const chatgptPhase = snapshot.chatgptConnection?.phase ?? "not_started";
        if (chatgptPhase !== connectionPhaseRecorded.current) {
          connectionPhaseRecorded.current = chatgptPhase;
          if (chatgptPhase === "oauth_completed") void bridge.recordEvent("oauth_completed");
          if (chatgptPhase === "connected") void bridge.recordEvent("first_mcp_session");
          if (chatgptPhase === "first_task_completed") void bridge.recordEvent("first_tool_success");
        }
        if (!autostartSynced.current && snapshot.configured) {
          autostartSynced.current = true;
          void setAutostart(snapshot.launchAtLogin).catch(() => undefined);
        }
        if (snapshot.runtimePhase === "ready" && previousPhase.current && previousPhase.current !== "ready" && snapshot.notifyWhenReady) {
          void bridge.notifyReady(copyRef.current.notificationTitle, copyRef.current.notificationBody).catch(() => undefined);
        }
        previousPhase.current = snapshot.runtimePhase;
        if (withAccess && shouldPollAccess(accessRef.current)) {
          try {
            const access = await bridge.applicationStatus();
            accessRef.current = access;
            dispatch({ type: "access", access });
            if (access.status === "not_applied" && access.reason) {
              activationRecorded.current = false;
              runtimeReadyRecorded.current = false;
              connectionPhaseRecorded.current = null;
              previousPhase.current = null;
              toast(access.reason);
              void bridge.recordEvent("application_status_failed", "error", "APPLICATION_RESET_REQUIRED");
              void bridge.snapshot().then((refreshed) => dispatch({ type: "snapshot", snapshot: refreshed, syncRoots: true })).catch(() => undefined);
            }
            if (access.status === "recovery_required") {
              toast(access.reason ?? copyRef.current.identityRecoveryBody);
              void bridge.recordEvent("application_status_failed", "error", "APPLICATION_RECOVERY_REQUIRED", access.applicationId);
            }
            if (["approved", "active", "activated"].includes(access.status) && !activationRecorded.current) {
              activationRecorded.current = true;
              void bridge.recordEvent("activation_completed", "ok", undefined, access.applicationId);
            }
            accessFailureRecorded.current = false;
          } catch (error) {
            if (!accessFailureRecorded.current) {
              accessFailureRecorded.current = true;
              void bridge.recordEvent("application_status_failed", "error", errorCode(error));
            }
          }
        }
      } catch (error) {
        dispatch({ type: "loading", value: false });
        dispatch({ type: "error", value: friendlyError(error, copy.errorRuntimeStart, copy) });
      }
    })().finally(() => {
      if (loadInFlight.current === task) loadInFlight.current = null;
    });
    loadInFlight.current = task;
    return task;
  }, [bridge, toast]);

  useEffect(() => {
    void load(true, true);
    void bridge.recordEvent("app_opened");
    pollRef.current = window.setInterval(() => void load(), 5000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [bridge, load]);

  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);

  useEffect(() => {
    accessRef.current = state.access;
  }, [state.access]);

  useEffect(() => {
    void bridge.copyCatalog().then(setCopy).catch(() => undefined);
  }, [bridge]);

  const snapshot = state.snapshot;
  const accessReady = accessIsReady(snapshot, state.access);
  const recoveryRequired = state.access.status === "recovery_required";
  const isWaiting = accessIsWaiting(state.access);
  const runtimePhase = snapshot?.runtimePhase ?? "needs_setup";
  const chatgptPhase = snapshot?.chatgptConnection?.phase ?? "not_started";
  const statusEyebrow = runtimePhase === "ready"
    ? ["connected", "first_task_completed"].includes(chatgptPhase) ? copy.connectedEyebrow : copy.computerReadyEyebrow
    : runtimePhase === "recovering"
      ? copy.recoveringEyebrow
      : copy.connectingEyebrow;
  const passwordAvailable = canCopyPassword(snapshot);
  const rootsChanged = useMemo(() => {
    const saved = snapshot?.allowedRoots ?? [];
    return saved.length !== state.selectedRoots.length || saved.some((root) => !state.selectedRoots.includes(root));
  }, [snapshot?.allowedRoots, state.selectedRoots]);

  async function applyAccess() {
    dispatch({ type: "busy", value: "access" });
    dispatch({ type: "error", value: null });
    void bridge.recordEvent("application_submit_started");
    try {
      const access = await bridge.applyForAccess();
      accessRef.current = access;
      dispatch({ type: "access", access });
      if (access.status === "recovery_required") {
        void bridge.recordEvent("application_submit_failed", "error", "APPLICATION_RECOVERY_REQUIRED", access.applicationId);
        toast(access.reason ?? copy.identityRecoveryBody);
      } else {
        void bridge.recordEvent("application_submitted", "ok", undefined, access.applicationId);
        toast(copy.applicationReceived);
      }
    } catch (error) {
      const message = friendlyError(error, copy.failureBody, copy);
      dispatch({ type: "error", value: message });
      void bridge.recordEvent("application_submit_failed", "error", errorCode(error));
    } finally { dispatch({ type: "busy", value: null }); }
  }

  async function saveFolders() {
    if (state.selectedRoots.length === 0) return;
    dispatch({ type: "busy", value: "folders" });
    dispatch({ type: "error", value: null });
    void bridge.recordEvent("runtime_start_started");
    try {
      const updated = await bridge.updateRoots(state.selectedRoots);
      dispatch({ type: "snapshot", snapshot: updated, syncRoots: true });
      await load(false, true);
      void setAutostart(true).catch(() => undefined);
      void bridge.recordEvent("folders_selected");
      void bridge.recordEvent("runtime_started");
      toast("工作文件夹已保存，可以开始了。");
    } catch (error) {
      dispatch({ type: "error", value: friendlyError(error, copy.foldersSaveFailure, copy) });
      void bridge.recordEvent("runtime_start_failed", "error", errorCode(error));
    } finally { dispatch({ type: "busy", value: null }); }
  }

  async function addFolders() {
    try {
      const roots = await bridge.chooseFolders(copy.folderPickerTitle);
      if (roots.length) {
        dispatch({ type: "roots", roots: [...state.selectedRoots, ...roots] });
        void bridge.recordEvent("folder_added");
      }
    } catch (error) { dispatch({ type: "error", value: friendlyError(error, copy.folderPickerFailure, copy) }); }
  }

  function removeFolder(root: string) {
    if (state.selectedRoots.length <= 1) {
      toast(copy.keepOneFolder);
      return;
    }
    dispatch({ type: "roots", roots: state.selectedRoots.filter((item) => item !== root) });
    void bridge.recordEvent("folder_removed");
  }

  async function restart() {
    dispatch({ type: "busy", value: "restart" });
    void bridge.recordEvent("runtime_start_started");
    try { await bridge.restartRuntime(); await load(false); void bridge.recordEvent("runtime_started"); toast(copy.reconnecting); }
    catch (error) { void bridge.recordEvent("runtime_start_failed", "error", errorCode(error)); dispatch({ type: "error", value: friendlyError(error, copy.failureBody, copy) }); }
    finally { dispatch({ type: "busy", value: null }); }
  }

  async function copyPassword() {
    try {
      const value = await bridge.connectionCode();
      if (!value) throw new Error("授权密码还没有准备好");
      await bridge.copy(value);
      await bridge.recordEvent("connection_password_copied");
      toast(copy.passwordCopied);
    } catch (error) { dispatch({ type: "error", value: friendlyError(error, copy.passwordNotReady, copy) }); }
  }

  async function openChatGPT() {
    try {
      await bridge.openChatGPT();
      void bridge.recordEvent("chatgpt_opened");
      toast(copy.chatgptOpened);
    } catch { dispatch({ type: "error", value: copy.chatgptFailure }); }
  }

  async function startChatGPTConnection() {
    if (!snapshot?.mcpUrl) return;
    dispatch({ type: "busy", value: "chatgpt" });
    dispatch({ type: "error", value: null });
    try {
      await bridge.copy(snapshot.mcpUrl);
      await bridge.markChatGPTSetupOpened();
      await bridge.openChatGPT();
      void bridge.recordEvent("chatgpt_setup_opened");
      void bridge.recordEvent("chatgpt_opened");
      toast(copy.startConnectionOpened);
      await load(false);
    } catch {
      dispatch({ type: "error", value: copy.chatgptFailure });
    } finally {
      dispatch({ type: "busy", value: null });
    }
  }

  async function copyConnectionValue(value: string, successMessage: string) {
    try {
      await bridge.copy(value);
      toast(successMessage);
    } catch {
      dispatch({ type: "error", value: copy.addressFailure });
    }
  }

  async function copyFirstTask() {
    try {
      await bridge.copy(copy.firstTaskPrompt);
      await bridge.openChatGPT();
      void bridge.recordEvent("chatgpt_opened");
      toast(copy.chatgptOpened);
    } catch {
      dispatch({ type: "error", value: copy.chatgptFailure });
    }
  }

  async function copyAddress() {
    if (!snapshot?.mcpUrl) return;
    try { await bridge.copy(snapshot.mcpUrl); toast(copy.addressCopied); }
    catch { dispatch({ type: "error", value: copy.addressFailure }); }
  }

  async function preference(key: keyof Preferences, value: boolean) {
    dispatch({ type: "busy", value: key === "notifyWhenReady" ? "notifications" : "preferences" });
    try {
      if (key === "launchAtLogin") {
        try { await setAutostart(value); } catch { toast(copy.autostartFailure); }
      }
      if (key === "notifyWhenReady" && value) {
        const granted = await bridge.enableNotifications();
        if (!granted) { toast(copy.notificationUnavailable); value = false; }
      }
      const updated = await bridge.setPreferences({ [key]: value });
      dispatch({ type: "snapshot", snapshot: updated });
      dispatch({ type: "preferences", value: { launchAtLogin: updated.launchAtLogin, notifyWhenReady: updated.notifyWhenReady, allowProjectCommands: updated.allowProjectCommands } });
      if (key === "notifyWhenReady" && value) void bridge.recordEvent("notification_enabled");
    } catch (error) { dispatch({ type: "error", value: friendlyError(error, copy.settingsSaveFailure, copy) }); }
    finally { dispatch({ type: "busy", value: null }); }
  }

  async function checkUpdate() {
    dispatch({ type: "busy", value: "update" });
    try {
      const update = await bridge.checkUpdate();
      dispatch({ type: "availableUpdate", value: update });
      void bridge.recordEvent("update_checked");
      toast(update ? copy.updateFound : copy.alreadyLatest);
    }
    catch { void bridge.recordEvent("update_checked", "error", "UPDATE_CHECK_FAILED"); toast(copy.updateUnavailable); }
    finally { dispatch({ type: "busy", value: null }); }
  }

  async function installUpdate() {
    dispatch({ type: "busy", value: "installUpdate" });
    try {
      void bridge.recordEvent("update_install_started");
      await bridge.installUpdate();
    } catch {
      void bridge.recordEvent("update_install_failed", "error", "UPDATE_INSTALL_FAILED");
      toast(copy.updateInstallFailure);
      dispatch({ type: "busy", value: null });
    }
  }

  async function diagnostics() {
    try {
      const report = await bridge.diagnosticReport() as Record<string, unknown>;
      const step = troubleshootingStep(state.access, snapshot);
      await bridge.copy(JSON.stringify({
        ...report,
        currentStatus: troubleshootingStatus(state.access, snapshot, copy),
        currentStep: troubleshootingStepLabel(step, copy),
        applicationStatus: applicationStatusLabel(state.access.status, copy),
        timeline: Array.isArray(report.events) ? report.events : [],
      }, null, 2));
      void bridge.recordEvent("diagnostics_copied");
      toast(copy.diagnosticsCopied);
    }
    catch { toast(copy.diagnosticsFailure); }
  }

  async function importInvite() {
    try { await bridge.importInvite(copy.importInvite); await load(true, true); toast(copy.inviteImported); }
    catch (error) { dispatch({ type: "error", value: friendlyError(error, copy.inviteImportFailure, copy) }); }
  }

  const phase = phaseLabel(runtimePhase);
  const statusText = copy[statusCopy[runtimePhase] ?? "stopped"];
  const displayStatusText = runtimePhase === "ready" && chatgptPhase === "first_task_completed"
    ? copy.firstTaskCompletedTitle
    : runtimePhase === "ready" && chatgptPhase === "connected"
      ? copy.chatgptConnectedTitle
      : statusText;
  const runtimeHint = runtimePhase === "ready" && chatgptPhase === "first_task_completed"
    ? copy.firstTaskHint
    : runtimePhase === "ready" && chatgptPhase === "connected"
      ? copy.connectedHint
      : runtimePhase === "ready"
        ? copy.readyHint
        : phase === "recovering" ? copy.recoveringHint : copy.workingHint;
  const showSetup = !accessReady || !snapshot?.configured || rootsChanged;

  if (state.loading && !snapshot) return <main class="app-shell loading-shell"><img class="loading-mark" src={handMark} alt="搭手" /><p>{copy.loading}</p></main>;

  return (
    <main class="app-shell">
      <header class="app-header">
        <div class="brand"><img class="brand-mark" src={handMark} alt="搭手" /><div><strong>搭手</strong><small>{copy.brandTagline}</small></div></div>
        <nav class="tabs" aria-label={copy.mainNavigation}>
          <button class={state.tab === "use" ? "tab active" : "tab"} type="button" onClick={() => dispatch({ type: "tab", tab: "use" })}>{copy.use}</button>
          <button class={state.tab === "settings" ? "tab active" : "tab"} type="button" onClick={() => dispatch({ type: "tab", tab: "settings" })}>{copy.settings}</button>
        </nav>
      </header>

      {state.tab === "settings" ? (
        <SettingsView copy={copy} snapshot={snapshot} access={state.access} version={snapshot?.version ?? "0.1.3-rc.15"} preferences={state.preferences} busy={state.busy} availableUpdate={state.availableUpdate} onPreference={preference} onCheckUpdate={checkUpdate} onInstallUpdate={installUpdate} onDismissUpdate={() => dispatch({ type: "availableUpdate", value: null })} onCopyDiagnostics={diagnostics} onCopyAddress={copyAddress} onImportInvite={importInvite} onConfigureAgain={() => dispatch({ type: "tab", tab: "use" })} />
      ) : (
        <div class="use-page">
          {showSetup ? (
            <section class="hero-card">
              <div class="hero-copy">
                <p class="eyebrow">{copy.workspaceEyebrow}</p>
                <h1>{accessReady ? copy.readyTitle : copy.setupTitle}</h1>
                <p class="lede">{accessReady ? copy.readyBody : copy.setupIntro}</p>
              </div>
              {!accessReady && accessCanApply(state.access) ? <div class="hero-side"><img class="mascot" src={mascot} alt="" aria-hidden="true" /><button class="button button-primary hero-button" type="button" disabled={state.busy === "access" || isWaiting} onClick={applyAccess}>{state.busy === "access" ? copy.submitting : copy.startSetup}</button></div> : null}
              {recoveryRequired ? <div class="recover-panel"><strong>{copy.identityRecoveryTitle}</strong><p>{state.access.reason ?? copy.identityRecoveryBody}</p><button class="button button-primary" type="button" onClick={diagnostics}>{copy.copyDiagnostics}</button></div> : null}
              {!accessReady && !recoveryRequired && (state.access.reason || state.access.status === "rejected") ? <p class="inline-error">{state.access.reason || copy.failureBody}</p> : null}
              <ProgressSteps access={state.access} copy={copy} />
              <TroubleshootingCard snapshot={snapshot} access={state.access} copy={copy} onCopy={diagnostics} />
              {accessReady ? <FolderPicker roots={state.selectedRoots} copy={copy} disabled={state.busy !== null} onAdd={addFolders} onRemove={removeFolder} /> : null}
              {accessReady ? <button class="button button-primary full-button" type="button" disabled={!state.selectedRoots.length || state.busy !== null} onClick={saveFolders}>{state.busy === "folders" ? copy.savingFolders : copy.startUsing}</button> : null}
              <div class="trust-panel"><strong>{copy.trustTitle}</strong><p>{copy.trustBody}</p></div>
            </section>
          ) : (
            <>
              <section class="ready-card">
                <div class="ready-heading"><StatusDot phase={runtimePhase} label={displayStatusText} /><div><p class="eyebrow">{statusEyebrow}</p><h1>{displayStatusText}</h1></div></div>
                <p class="lede">{runtimeHint}</p>
                {runtimePhase === "ready" && snapshot ? <ChatGPTConnectGuide snapshot={snapshot} copy={copy} passwordAvailable={passwordAvailable} busy={state.busy} onStart={startChatGPTConnection} onOpenChatGPT={openChatGPT} onCopy={copyConnectionValue} onCopyPassword={copyPassword} onCopyFirstTask={copyFirstTask} /> : null}
                {runtimePhase === "blocked" || runtimePhase === "stopped" ? <div class="recover-panel"><strong>{runtimePhase === "blocked" ? copy.failureTitle : copy.stopped}</strong><p>{runtimePhase === "blocked" && snapshot?.error ? friendlyError({ code: snapshot.error.code }, copy.failureBody, copy) : runtimePhase === "blocked" ? copy.failureBody : copy.workingHint}</p><button class="button button-primary" type="button" disabled={state.busy === "restart"} onClick={restart}>{copy.retry}</button></div> : null}
                <FolderPicker roots={state.selectedRoots} copy={copy} disabled={state.busy !== null} onAdd={addFolders} onRemove={removeFolder} />
                {troubleshootingNeedsAttention(state.access, snapshot) ? <TroubleshootingCard snapshot={snapshot} access={state.access} copy={copy} onCopy={diagnostics} /> : null}
              </section>
              <p class="resident-note">{copy.residentNote}</p>
            </>
          )}
          {state.error ? <p class="error-banner" role="alert">{state.error}</p> : null}
        </div>
      )}
      <footer class="app-footer"><span>{copy.footerTrust}</span></footer>
      <div class="toast" role="status" aria-live="polite" aria-atomic="true" data-visible={Boolean(state.toast)}>{state.toast}</div>
    </main>
  );
}

function StatusDot({ phase, label }: { phase: RuntimePhase; label: string }) {
  return <span class={`status-dot ${phase}`} aria-label={label} />;
}

const errorCopy: Record<string, keyof CopyCatalog> = {
  OTHER_PROCESS: "errorOtherProcess",
  CONTROL_TIMEOUT: "errorControlTimeout",
  CONTROL_CONNECT: "errorControlConnect",
  CONTROL_RESPONSE_INVALID: "errorControlResponse",
  RUNTIME_START_FAILED: "errorRuntimeStart",
  RUNTIME_TAKEOVER_FAILED: "errorRuntimeTakeover",
  RUNTIME_HEALTH_TIMEOUT: "errorRuntimeHealthTimeout",
  RUNTIME_LOG_UNAVAILABLE: "errorRuntimeStart",
  ROOTS_UPDATE_ROLLBACK: "foldersSaveFailure",
  NOT_CONFIGURED: "errorNotConfigured",
  MISSING_RESOURCES: "errorMissingResources",
  ROOTS_REQUIRED: "errorNoRoots",
  INVALID_ROOT: "errorInvalidRoot",
  DUPLICATE_ROOT: "errorDuplicateRoot",
  INVITE_INVALID: "errorInvite",
  INVITE_AUTH_INVALID: "errorInvite",
  INVITE_UNSAFE: "errorInvite",
  PASSWORD_NOT_READY: "passwordNotReady",
};

export function friendlyError(error: unknown, fallback: string, copy: CopyCatalog = defaultCopy): string {
  const key = errorCopy[errorCode(error)];
  return key ? copy[key] : fallback;
}

export function errorCode(error: unknown): string {
  return normalizeBridgeError(error).code ?? "CLIENT_UNKNOWN";
}
