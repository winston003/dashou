# Design QA

## Comparison Target

- Source visual truth: `/Users/whilewon/.codex/generated_images/01a01a13-455d-76c1-aba4-3309e674a2ae/exec-abba4432-9892-46e3-9f2c-0ddd045fdc06.png`
- Final live-API implementation screenshot: `/Users/whilewon/workspace/dashou/prototypes/applicant-review-admin/implementation-live-api-final.png`
- Full-view live-API comparison: `/Users/whilewon/workspace/dashou/prototypes/applicant-review-admin/design-comparison-live-api-final.png`
- State: desktop, live applications loaded, pending filter available, one pending application selected, decision drawer open.

## Viewport And Normalization

- CSS viewport: `1440 x 1024`.
- Device pixel ratio: `1`.
- Browser visual viewport: `1425 x 1024`; the remaining width is browser scrollbar allocation.
- Source pixels: `1487 x 1058`.
- Captured implementation pixels: `1425 x 1013`.
- Density normalization: both images were resized to `1440 x 1024` before full-view and focused-region comparison. The comparison is therefore based on equal pixel dimensions, not browser chrome or source export density.
- Responsive check: `760 x 900`; the 430px decision drawer remained within the viewport, closed correctly, and reopened by selecting a row. The document did not introduce page-level horizontal overflow.

## Full-View Comparison Evidence

- The implementation preserves the source's thin 64px header, warm ivory base, muted copper selection color, border-led separation, compact status filters, dense application table, and fixed right decision drawer.
- Table and drawer proportions match the source closely; the selected row, safety result, duration control, approval action, and rejection action remain visible in the same initial viewport.
- The final capture shows the six applications returned by the live Dashou control plane at verification time: three pending and three activated. The UI no longer pads the list with mock records.

## Focused Region Evidence

- The decision drawer preserves the hierarchy and alignment for application identity, metadata, live event timeline, safety result, authorization duration, approval, rejection, and audit note.
- The event timeline renders the selected application's real control-plane events and error codes. It does not synthesize generic progress labels.
- The generated mock's initial avatar is replaced with a Phosphor user icon because the implementation uses a coherent icon library instead of a custom SVG or text-glyph asset.

## Required Fidelity Surfaces

- Fonts and typography: passed. System Chinese UI fonts and Georgia for the compact brand lockup reproduce the source hierarchy, weights, line lengths, truncation, and body sizing without clipped text.
- Spacing and layout rhythm: passed. Header, filter row, 73px table rows, 430px drawer, dividers, radii, and action spacing align with the source. The core actions remain above the fold.
- Colors and visual tokens: passed. Ivory, brown, copper, green, blue, amber, and red semantic states match the source's quiet operational palette with sufficient contrast.
- Image quality and asset fidelity: passed. The screen contains no raster art requirement. All functional icons use `@phosphor-icons/react`; there are no handcrafted SVGs, placeholder graphics, emoji, gradients, or CSS art.
- Copy and content: passed. Simplified Chinese labels reflect the live Dashou application statuses and control-plane terminology. Because the API does not expose applicant names or roles, the UI identifies applications using contact, device, and platform fields only. No secrets, tokens, local paths, file contents, or chat contents appear in applicant details.

## Interaction And Browser Verification

- Live read: `GET /admin/applications` returned six applications; the UI rendered all six without exposing the admin token.
- Filtering: selected `待审核`; three live pending applications were shown.
- Search: entered a value from a live record; one matching application was returned, and clearing search restored the list.
- Selection: opened a live application; the drawer loaded its actual metadata and event timeline.
- Approval: opened the live-action confirmation dialog and verified the selected authorization period and warning copy. Final submission was intentionally not clicked. `NOT_EXECUTED`: `POST /admin/applications/:id/approve` against an existing live application.
- Rejection: verified that submission stays disabled without a reason and becomes enabled after entering one. Final submission was intentionally not clicked. `NOT_EXECUTED`: `POST /admin/applications/:id/reject` against an existing live application.
- Timeline: expanded and collapsed successfully.
- Console: zero application warnings or errors in the final live-data flow. A Statsig timeout observed in browser-control infrastructure was not emitted by this application.
- Local API tests: `npm test` passed, 8 of 8.
- Build: `npm run build` passed.
- Sites package tests: `npm run test:sites` passed, 4 of 4.

## Live API And Security Boundary

- Live reads were verified against the configured Dashou pilot control-plane URL. The token was present in the existing mode-`0600` local admin config and was never printed or sent to the browser.
- The Vite middleware proxies only list, detail, approve, and reject. Reset, revoke, accounts, malformed IDs, unexpected query keys, cross-origin writes, and non-loopback access are blocked.
- Request bodies are limited to 8 KiB and upstream responses to 1 MiB. The token reaches `curl` through stdin configuration rather than process arguments; mutation bodies use short-lived mode-`0600` temporary files.
- The panel is intentionally local-only. Public hosting of the privileged proxy is `NOT_IMPLEMENTED` until an administrator-authentication layer is designed and verified.

## Comparison History

### Pass 1

- [P2] The event timeline and application-information rhythm pushed the safety check and primary decision actions about one section lower than the source.
- Fix: reduced detail-section vertical padding and list gaps, reduced timeline row minimum height, and tightened the safety-check margins.
- Post-fix evidence: `design-comparison-pass-2.png` shows the safety check and both decision buttons restored to the source's above-the-fold region.

### Pass 2

- [P3] Contact information wrapped to two lines while the source kept it on one line.
- Fix: changed the drawer contact row to `email · phone` on one line.
- Post-fix evidence: `design-comparison-final.png` and `design-comparison-drawer-final.png` show the corrected alignment.

## Remaining Follow-Up Polish

- [P3] The source mock uses an initial-based avatar while the implementation uses a library user icon. Both preserve the same visual weight; the library icon is intentionally retained for asset integrity.
- [P3] The live record count differs from the generated concept because the control plane currently returns six applications.

## Final Result

No actionable P0, P1, or P2 findings remain.

final result: passed
