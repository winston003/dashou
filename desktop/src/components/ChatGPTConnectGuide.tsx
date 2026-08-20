import { chatgptGuideStep } from "../state";
import type { CopyCatalog, DesktopSnapshot } from "../types";

type Props = {
  snapshot: DesktopSnapshot;
  copy: CopyCatalog;
  passwordAvailable: boolean;
  busy: string | null;
  onStart: () => void;
  onOpenChatGPT: () => void;
  onCopy: (value: string, successMessage: string) => void;
  onCopyPassword: () => void;
  onCopyFirstTask: () => void;
};

export function ChatGPTConnectGuide({
  snapshot,
  copy,
  passwordAvailable,
  busy,
  onStart,
  onOpenChatGPT,
  onCopy,
  onCopyPassword,
  onCopyFirstTask,
}: Props) {
  const phase = snapshot.chatgptConnection?.phase ?? "not_started";
  const step = chatgptGuideStep(phase);

  if (phase === "first_task_completed") {
    return (
      <section class="connection-guide connection-complete" aria-live="polite">
        <div class="connection-heading"><span class="connection-check" aria-hidden="true">✓</span><div><p class="eyebrow">{copy.connectedEyebrow}</p><h2>{copy.firstTaskCompletedTitle}</h2></div></div>
        <p>{copy.firstTaskCompletedBody}</p>
        <button class="button button-primary" type="button" onClick={onOpenChatGPT}>{copy.openChatGPT}</button>
      </section>
    );
  }

  if (phase === "connected") {
    return (
      <section class="connection-guide" aria-live="polite">
        <GuideHeader step={3} title={copy.chatgptConnectedTitle} copy={copy} />
        <p class="guide-body">{copy.chatgptConnectedBody}</p>
        <div class="first-task"><span>{copy.firstTaskPrompt}</span></div>
        <button class="button button-primary full-button" type="button" onClick={onCopyFirstTask}>{copy.copyTaskAndOpen}</button>
      </section>
    );
  }

  if (phase === "oauth_completed") {
    return (
      <section class="connection-guide" aria-live="polite">
        <GuideHeader step={3} title={copy.oauthCompletedTitle} copy={copy} />
        <p class="guide-body">{copy.oauthCompletedBody}</p>
        <div class="connection-wait"><span class="mini-spinner" aria-hidden="true" />{copy.waitingForAuthorization}</div>
      </section>
    );
  }

  if (phase === "authorization_requested") {
    return (
      <section class="connection-guide" aria-live="polite">
        <GuideHeader step={3} title={copy.connectStepThree} copy={copy} />
        <p class="guide-body">{copy.authorizationBody}</p>
        <ol class="micro-steps"><li>回到搭手</li><li>复制授权密码</li><li>粘贴到浏览器并允许连接</li></ol>
        <button class="button button-primary full-button" type="button" disabled={!passwordAvailable || busy !== null} onClick={onCopyPassword}>{copy.copyPassword}</button>
      </section>
    );
  }

  if (phase === "setup_opened") {
    return (
      <section class="connection-guide" aria-live="polite">
        <GuideHeader step={2} title={copy.createAppTitle} copy={copy} />
        <p class="guide-body">{copy.createAppBody}</p>
        <div class="setup-fields">
          <SetupField label={copy.appNameLabel} value={copy.appNameValue} copy={copy} onCopy={() => onCopy(copy.appNameValue, copy.copiedName)} />
          <SetupField label={copy.appDescriptionLabel} value={copy.appDescriptionValue} copy={copy} onCopy={() => onCopy(copy.appDescriptionValue, copy.copiedDescription)} />
          <SetupField label={copy.serverUrlLabel} value={snapshot.mcpUrl ?? "—"} copy={copy} onCopy={() => snapshot.mcpUrl && onCopy(snapshot.mcpUrl, copy.copiedAddressForSetup)} />
          <div class="setup-field static-field"><span>{copy.authenticationLabel}</span><strong>{copy.authenticationValue}</strong></div>
        </div>
        <div class="guide-actions">
          <button class="button button-secondary" type="button" onClick={onOpenChatGPT}>{copy.reopenChatGPT}</button>
          <p>{copy.developerModePath}</p>
        </div>
      </section>
    );
  }

  return (
    <section class="connection-guide connection-start" aria-live="polite">
      <GuideHeader step={step} title={copy.computerReadyTitle} copy={copy} />
      <p class="guide-body">{copy.computerReadyBody}</p>
      <div class="developer-tip">
        <strong>{copy.developerModeTitle}</strong>
        <p>{copy.developerModeBody}</p>
        <code>{copy.developerModePath}</code>
        <span>{copy.developerModeChecks}</span>
      </div>
      <button class="button button-primary full-button" type="button" disabled={busy !== null || !snapshot.mcpUrl} onClick={onStart}>{copy.connectChatGPT}</button>
    </section>
  );
}

function GuideHeader({ step, title, copy }: { step: number; title: string; copy: CopyCatalog }) {
  return <div class="guide-header"><p class="eyebrow">{copy.connectChatGPT} · {step}/3</p><h2>{title}</h2></div>;
}

function SetupField({ label, value, copy, onCopy }: { label: string; value: string; copy: CopyCatalog; onCopy: () => void }) {
  return <div class="setup-field"><span>{label}</span><strong title={value}>{value}</strong><button class="copy-chip" type="button" onClick={onCopy}>{copy.copyValue}</button></div>;
}
