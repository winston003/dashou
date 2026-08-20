import type { AccessStatus, AvailableUpdate, CopyCatalog, DesktopSnapshot, Preferences } from "../types";
import { TroubleshootingCard } from "./TroubleshootingCard";

type Props = {
  copy: CopyCatalog;
  snapshot: DesktopSnapshot | null;
  access: AccessStatus;
  version: string;
  preferences: Preferences;
  busy: string | null;
  availableUpdate: AvailableUpdate | null;
  onPreference: (key: keyof Preferences, value: boolean) => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onDismissUpdate: () => void;
  onCopyDiagnostics: () => void;
  onCopyAddress: () => void;
  onImportInvite: () => void;
  onConfigureAgain: () => void;
};

export function SettingsView({ copy, snapshot, access, version, preferences, busy, availableUpdate, onPreference, onCheckUpdate, onInstallUpdate, onDismissUpdate, onCopyDiagnostics, onCopyAddress, onImportInvite, onConfigureAgain }: Props) {
  return (
    <div class="settings-page">
      <section class="settings-card">
        <h1>{copy.settings}</h1>
        <p class="lede">{copy.settingsIntro}</p>
        <SettingToggle
          label={copy.autostart}
          hint={copy.autostartHint}
          checked={preferences.launchAtLogin}
          disabled={busy === "preferences"}
          onChange={(value) => onPreference("launchAtLogin", value)}
        />
        <SettingToggle
          label={copy.notifications}
          hint={copy.notificationsHint}
          checked={preferences.notifyWhenReady}
          disabled={busy === "notifications"}
          onChange={(value) => onPreference("notifyWhenReady", value)}
        />
        <SettingToggle
          label={copy.projectCommands}
          hint={copy.projectCommandsHint}
          checked={preferences.allowProjectCommands}
          disabled={busy === "preferences"}
          onChange={(value) => onPreference("allowProjectCommands", value)}
        />
      </section>
      <TroubleshootingCard snapshot={snapshot} access={access} copy={copy} onCopy={onCopyDiagnostics} />
      <section class="settings-card compact-card">
        <div class="setting-line"><span>{copy.currentVersion}</span><code>{version}</code></div>
        {availableUpdate ? (
          <div class="update-preview" role="region" aria-labelledby="update-title">
            <strong id="update-title">{copy.updateAvailable} {availableUpdate.version}</strong>
            <p>{availableUpdate.body?.trim() || copy.updateNotesUnavailable}</p>
            <div class="update-actions">
              <button class="button button-secondary" type="button" disabled={busy === "installUpdate"} onClick={onDismissUpdate}>{copy.updateLater}</button>
              <button class="button button-primary" type="button" disabled={busy === "installUpdate"} onClick={onInstallUpdate}>{busy === "installUpdate" ? copy.installingUpdate : copy.installUpdate}</button>
            </div>
          </div>
        ) : (
          <div class="settings-actions">
            <button class="button button-secondary" type="button" disabled={busy === "update"} onClick={onCheckUpdate}>{busy === "update" ? copy.checkingUpdate : copy.checkUpdate}</button>
          </div>
        )}
      </section>
      <details class="advanced-card">
        <summary>{copy.advanced}</summary>
        <div class="advanced-actions">
          <button class="button button-secondary" type="button" onClick={onConfigureAgain}>{copy.configureAgain}</button>
          <button class="button button-secondary" type="button" onClick={onCopyAddress}>{copy.copyAddress}</button>
          <button class="button button-secondary" type="button" onClick={onImportInvite}>{copy.importInvite}</button>
          <button class="button button-secondary" type="button" onClick={onCopyDiagnostics}>{copy.copyDiagnostics}</button>
        </div>
      </details>
    </div>
  );
}

function SettingToggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <label class="setting-toggle">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)} />
      <span class="toggle" aria-hidden="true" />
    </label>
  );
}
