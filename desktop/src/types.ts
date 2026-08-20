export type RuntimePhase =
  | "needs_setup"
  | "stopped"
  | "starting"
  | "connecting"
  | "ready"
  | "recovering"
  | "blocked";

export type UiError = {
  code: string;
  retryable: boolean;
  diagnosticId?: string;
};

export type ChatGPTConnectionPhase =
  | "not_started"
  | "setup_opened"
  | "authorization_requested"
  | "oauth_completed"
  | "connected"
  | "first_task_completed";

export type ChatGPTConnectionStatus = {
  phase: ChatGPTConnectionPhase;
  setupOpenedAt?: number;
  authorizationRequestedAt?: number;
  oauthCompletedAt?: number;
  firstSessionAt?: number;
  firstToolSuccessAt?: number;
};

export type DesktopSnapshot = {
  version: string;
  deviceNickname: string;
  deviceFingerprint: string;
  platform: string;
  lastCheckedUnixSeconds: number;
  configured: boolean;
  allowedRoots: string[];
  runtimePhase: RuntimePhase;
  localHealth: boolean;
  publicHealth: boolean;
  mcpUrl?: string;
  recoveryAttempts: number;
  error?: UiError;
  launchAtLogin: boolean;
  notifyWhenReady: boolean;
  contentVersion: string;
  uiSource: "built-in" | "downloaded";
  chatgptConnection?: ChatGPTConnectionStatus;
};

export type AccessStatus = {
  status: "not_applied" | "pending" | "provisioning" | "approved" | "active" | "activated" | "rejected" | "expired" | "revoked";
  applicationId?: string;
  createdAt?: string;
  period?: string;
  expiresAt?: string;
  mcpUrl?: string;
  reason?: string;
};

export type CopyCatalog = {
  loading: string;
  brandTagline: string;
  footerTrust: string;
  mainNavigation: string;
  setupTitle: string;
  setupIntro: string;
  startSetup: string;
  submitting: string;
  trialIdle: string;
  trialPendingTitle: string;
  trialPendingBody: string;
  trialProvisioningTitle: string;
  trialProvisioningBody: string;
  trialSlow: string;
  progressReceived: string;
  progressPreparing: string;
  progressChecking: string;
  progressReady: string;
  readyTitle: string;
  readyBody: string;
  chooseFolders: string;
  chooseFoldersHint: string;
  folderPickerTitle: string;
  folderListLabel: string;
  keepOneFolder: string;
  addFolder: string;
  removeFolder: string;
  noFolders: string;
  startUsing: string;
  trustTitle: string;
  trustBody: string;
  failureTitle: string;
  failureBody: string;
  retry: string;
  copyDiagnostics: string;
  preparing: string;
  connecting: string;
  ready: string;
  recovering: string;
  blocked: string;
  stopped: string;
  openChatGPT: string;
  copyPassword: string;
  passwordCopied: string;
  copyAddress: string;
  addressCopied: string;
  residentNote: string;
  settings: string;
  settingsIntro: string;
  currentVersion: string;
  use: string;
  helpTitle: string;
  helpBody: string;
  helpPath: string;
  autostart: string;
  autostartHint: string;
  notifications: string;
  notificationsHint: string;
  checkUpdate: string;
  checkingUpdate: string;
  updateReady: string;
  updateFound: string;
  updateAvailable: string;
  updateNotesUnavailable: string;
  updateLater: string;
  installUpdate: string;
  installingUpdate: string;
  updateInstallFailure: string;
  alreadyLatest: string;
  advanced: string;
  importInvite: string;
  configureAgain: string;
  workspaceEyebrow: string;
  connectedEyebrow: string;
  connectingEyebrow: string;
  recoveringEyebrow: string;
  readyHint: string;
  recoveringHint: string;
  workingHint: string;
  savingFolders: string;
  foldersSaved: string;
  reconnecting: string;
  chatgptOpened: string;
  diagnosticsFailure: string;
  statusReady: string;
  applicationReceived: string;
  diagnosticsCopied: string;
  troubleshootingTitle: string;
  troubleshootingHint: string;
  currentStatus: string;
  currentStep: string;
  deviceLabel: string;
  recentCheck: string;
  applicationLabel: string;
  applicationNotStarted: string;
  applicationWaiting: string;
  applicationPreparing: string;
  applicationReady: string;
  applicationRejected: string;
  applicationEnded: string;
  stepNotApplied: string;
  stepWaitingConfirmation: string;
  stepPreparingConnection: string;
  stepStartingLocalService: string;
  stepRecoveringConnection: string;
  stepReady: string;
  stepRuntimeBlocked: string;
  stepOtherConnection: string;
  stepNeedsAttention: string;
  updateUnavailable: string;
  autostartFailure: string;
  notificationUnavailable: string;
  settingsSaveFailure: string;
  inviteImported: string;
  inviteImportFailure: string;
  passwordNotReady: string;
  chatgptFailure: string;
  addressFailure: string;
  folderPickerFailure: string;
  foldersSaveFailure: string;
  errorOtherProcess: string;
  errorControlTimeout: string;
  errorControlConnect: string;
  errorControlResponse: string;
  errorRuntimeStart: string;
  errorRuntimeHealthTimeout: string;
  errorNotConfigured: string;
  errorMissingResources: string;
  errorNoRoots: string;
  errorInvalidRoot: string;
  errorDuplicateRoot: string;
  errorInvite: string;
  notificationTitle: string;
  notificationBody: string;
  uiFailureTitle: string;
  uiFailureBody: string;
  reloadUi: string;
  computerReadyEyebrow: string;
  computerReadyTitle: string;
  computerReadyBody: string;
  connectChatGPT: string;
  connectStepOne: string;
  connectStepTwo: string;
  connectStepThree: string;
  developerModeTitle: string;
  developerModeBody: string;
  developerModePath: string;
  developerModeChecks: string;
  openedDeveloperMode: string;
  createAppTitle: string;
  createAppBody: string;
  appNameLabel: string;
  appNameValue: string;
  appDescriptionLabel: string;
  appDescriptionValue: string;
  serverUrlLabel: string;
  authenticationLabel: string;
  authenticationValue: string;
  copyValue: string;
  copiedName: string;
  copiedDescription: string;
  copiedAddressForSetup: string;
  reopenChatGPT: string;
  waitingForAuthorization: string;
  authorizationBody: string;
  oauthCompletedTitle: string;
  oauthCompletedBody: string;
  chatgptConnectedTitle: string;
  chatgptConnectedBody: string;
  firstTaskPrompt: string;
  copyTaskAndOpen: string;
  firstTaskCompletedTitle: string;
  firstTaskCompletedBody: string;
  startConnectionOpened: string;
  connectedHint: string;
  firstTaskHint: string;
  chatgptStatusLabel: string;
  chatgptNotStarted: string;
  chatgptSetupOpened: string;
  chatgptAuthorizationRequested: string;
  chatgptOauthCompleted: string;
  chatgptConnected: string;
  chatgptFirstTaskCompleted: string;
};

export type Preferences = {
  launchAtLogin: boolean;
  notifyWhenReady: boolean;
};

export type AvailableUpdate = {
  currentVersion: string;
  version: string;
  body?: string;
  date?: string;
};
