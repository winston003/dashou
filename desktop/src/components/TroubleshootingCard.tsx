import { useEffect, useState } from "preact/hooks";
import { applicationStatusLabel, chatgptConnectionLabel, formatLastChecked, platformLabel, troubleshootingNeedsAttention, troubleshootingStatus, troubleshootingStep, troubleshootingStepLabel } from "../diagnostics";
import type { AccessStatus, CopyCatalog, DesktopSnapshot } from "../types";

type Props = {
  snapshot: DesktopSnapshot | null;
  access: AccessStatus;
  copy: CopyCatalog;
  onCopy: () => void;
};

export function TroubleshootingCard({ snapshot, access, copy, onCopy }: Props) {
  const step = troubleshootingStep(access, snapshot);
  const needsAttention = troubleshootingNeedsAttention(access, snapshot);
  const [open, setOpen] = useState(needsAttention);

  useEffect(() => {
    if (needsAttention) setOpen(true);
  }, [needsAttention]);

  return (
    <details class="troubleshooting-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary class="troubleshooting-summary">
        <div>
          <p class="eyebrow">{copy.troubleshootingTitle}</p>
          <strong>{snapshot?.deviceNickname ?? "搭手·准备中"}</strong>
        </div>
        <span class="troubleshooting-summary-status">{troubleshootingStatus(access, snapshot, copy)}</span>
      </summary>
      <div class="troubleshooting-body">
        <div class="troubleshooting-heading">
          <span class="fingerprint">{snapshot?.deviceFingerprint ?? "--------"}</span>
          <span>{copy.troubleshootingHint}</span>
        </div>
        <dl class="troubleshooting-grid">
          <div><dt>{copy.currentStatus}</dt><dd>{troubleshootingStatus(access, snapshot, copy)}</dd></div>
          <div><dt>{copy.currentStep}</dt><dd>{troubleshootingStepLabel(step, copy)}</dd></div>
          <div><dt>{copy.deviceLabel}</dt><dd>{platformLabel(snapshot?.platform ?? "")}</dd></div>
          <div><dt>{copy.recentCheck}</dt><dd>{formatLastChecked(snapshot?.lastCheckedUnixSeconds ?? 0)}</dd></div>
          <div><dt>{copy.applicationLabel}</dt><dd>{applicationStatusLabel(access.status, copy)}</dd></div>
          <div><dt>{copy.chatgptStatusLabel}</dt><dd>{chatgptConnectionLabel(snapshot?.chatgptConnection?.phase, copy)}</dd></div>
        </dl>
        <button class="button button-secondary troubleshooting-button" type="button" onClick={onCopy}>{copy.copyDiagnostics}</button>
      </div>
    </details>
  );
}
