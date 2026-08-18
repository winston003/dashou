import type { CopyCatalog, Preferences } from "../types";

type Props = {
  copy: CopyCatalog;
  version: string;
  preferences: Preferences;
  busy: string | null;
  onPreference: (key: keyof Preferences, value: boolean) => void;
  onCheckUpdate: () => void;
  onCopyDiagnostics: () => void;
  onCopyAddress: () => void;
  onImportInvite: () => void;
  onConfigureAgain: () => void;
};

export function SettingsView({ copy, version, preferences, busy, onPreference, onCheckUpdate, onCopyDiagnostics, onCopyAddress, onImportInvite, onConfigureAgain }: Props) {
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
      </section>
      <section class="settings-card compact-card">
        <div class="setting-line"><span>{copy.currentVersion}</span><code>{version}</code></div>
        <div class="settings-actions">
          <button class="button button-secondary" type="button" disabled={busy === "update"} onClick={onCheckUpdate}>{busy === "update" ? copy.checkingUpdate : copy.checkUpdate}</button>
        </div>
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
