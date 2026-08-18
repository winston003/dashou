import type { AccessStatus, CopyCatalog } from "../types";

type Props = { access: AccessStatus; copy: CopyCatalog };

export function ProgressSteps({ access, copy }: Props) {
  const status = access.status;
  const waiting = status === "pending" || status === "provisioning";
  if (!waiting) return null;
  const preparing = status === "provisioning";
  return (
    <div class="progress-card" aria-live="polite">
      <ol class="progress-list">
        <li class="complete"><span>✓</span> {copy.progressReceived}</li>
        <li class={preparing ? "active" : "complete"}><span>{preparing ? "●" : "✓"}</span> {preparing ? copy.trialProvisioningTitle : copy.progressPreparing}</li>
        <li class={preparing ? "active" : "pending"}><span>{preparing ? "●" : "○"}</span> {copy.progressChecking}</li>
        <li class="pending"><span>○</span> {copy.progressReady}</li>
      </ol>
      <p>{copy.trialPendingBody}</p>
    </div>
  );
}
