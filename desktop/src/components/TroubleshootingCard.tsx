import { applicationStatusLabel, formatLastChecked, platformLabel, troubleshootingStatus, troubleshootingStep, troubleshootingStepLabel } from "../diagnostics";
import type { AccessStatus, CopyCatalog, DesktopSnapshot } from "../types";

type Props = {
  snapshot: DesktopSnapshot | null;
  access: AccessStatus;
  copy: CopyCatalog;
  onCopy: () => void;
};

export function TroubleshootingCard({ snapshot, access, copy, onCopy }: Props) {
  const step = troubleshootingStep(access, snapshot);
  return (
    <section class="troubleshooting-card" aria-labelledby="troubleshooting-title">
      <div class="troubleshooting-heading">
        <div>
          <p class="eyebrow">{copy.troubleshootingTitle}</p>
          <h2 id="troubleshooting-title">{snapshot?.deviceNickname ?? "搭手·准备中"}</h2>
        </div>
        <span class="fingerprint">{snapshot?.deviceFingerprint ?? "--------"}</span>
      </div>
      <p class="troubleshooting-hint">{copy.troubleshootingHint}</p>
      <dl class="troubleshooting-grid">
        <div><dt>{copy.currentStatus}</dt><dd>{troubleshootingStatus(access, snapshot, copy)}</dd></div>
        <div><dt>{copy.currentStep}</dt><dd>{troubleshootingStepLabel(step, copy)}</dd></div>
        <div><dt>{copy.currentVersion}</dt><dd>{snapshot?.version ?? "—"}</dd></div>
        <div><dt>{copy.deviceLabel}</dt><dd>{platformLabel(snapshot?.platform ?? "")}</dd></div>
        <div><dt>{copy.recentCheck}</dt><dd>{formatLastChecked(snapshot?.lastCheckedUnixSeconds ?? 0)}</dd></div>
        <div><dt>{copy.applicationLabel}</dt><dd>{applicationStatusLabel(access.status, copy)}</dd></div>
      </dl>
      <button class="button button-secondary troubleshooting-button" type="button" onClick={onCopy}>{copy.copyDiagnostics}</button>
    </section>
  );
}
