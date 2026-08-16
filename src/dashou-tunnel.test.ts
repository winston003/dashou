import assert from "node:assert/strict";
import test from "node:test";
import { cloudflaredRunSpec } from "./dashou-tunnel.js";

test("Cloudflare Tunnel token is passed through environment, not process arguments", () => {
  const token = "eyJ-private-pilot-token";
  const spec = cloudflaredRunSpec(token);

  assert.equal(spec.command, "cloudflared");
  assert.deepEqual(spec.args, ["tunnel", "--no-autoupdate", "--loglevel", "warn", "run"]);
  assert.equal(spec.args.includes(token), false);
  assert.equal(spec.env.TUNNEL_TOKEN, token);
  assert.equal(spec.windowsHide, true);
});

test("empty Tunnel token is rejected", () => {
  assert.throws(() => cloudflaredRunSpec("   "), /token is empty/i);
});
