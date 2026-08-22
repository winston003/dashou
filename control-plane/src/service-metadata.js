export const CONTROL_PLANE_SERVICE_VERSION = "1.0.1";
export const CONTROL_PLANE_API_VERSION = 1;
export const CONTROL_PLANE_CAPABILITIES = Object.freeze([
  "adminReviewV1",
  "analyticsV1",
  "clientEventsV1",
  "resourceOwnershipV1",
  "retirementV1",
  "reversibleReviewV1",
]);

export function controlPlaneHealth(buildSha = "dev") {
  return {
    ok: true,
    name: "dashou-pilot-control",
    serviceVersion: CONTROL_PLANE_SERVICE_VERSION,
    apiVersion: CONTROL_PLANE_API_VERSION,
    capabilities: [...CONTROL_PLANE_CAPABILITIES],
    // Kept for older diagnostics. It now identifies the service, not the desktop app.
    version: CONTROL_PLANE_SERVICE_VERSION,
    buildSha,
  };
}
