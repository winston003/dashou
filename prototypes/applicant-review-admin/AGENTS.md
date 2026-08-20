# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Prototype Design Decisions

- The selected visual direction is the inbox-first applicant review table with a contextual decision drawer.
- Preserve Dashou's warm ivory, brown, and muted copper visual language.
- Keep the primary workflow focused on reviewing one application, selecting an authorization period, and approving or rejecting with an auditable confirmation.
- Never render secrets, tokens, local directory paths, file contents, or chat content in applicant details.
- Applicant rows and detail timelines must come from the live Dashou control-plane API; do not invent names, roles, review outcomes, or event history when those fields are absent upstream.
- Keep the admin token server-side. The browser may call only the loopback Vite middleware, which exposes the narrow list, detail, approve, and reject routes needed by this panel.
- Keep the operator panel local-only until a proper administrator authentication layer exists. Never publish an unauthenticated proxy that can reach live approve or reject endpoints.
- Treat approve and reject as live mutations: require an explicit confirmation, do not trigger them during visual or read-only QA, and record unexecuted mutation tests as `NOT_EXECUTED`.
- Label `first_seen` as the first observation by a client version that supports analytics; never present it as the installation timestamp.
- Keep MCP analytics split into connection, tool-call attempt, tool-call success, and categorized tool-call failure. A tool call counts as first use only after the tool handler succeeds.
- Client milestone events must be crash-safe and idempotent: persist a local pending event before returning, reuse its event ID on retry, and mark it sent only after the control plane confirms receipt.
