import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface CloudflaredRunSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface RunningCloudflareTunnel {
  process: ChildProcess;
  close(): Promise<void>;
}

export function cloudflaredRunSpec(token: string, environment: NodeJS.ProcessEnv = process.env): CloudflaredRunSpec {
  const normalized = token.trim();
  if (!normalized) throw new Error("Cloudflare Tunnel token is empty");

  return {
    command: environment.DASHOU_CLOUDFLARED_PATH?.trim() || "cloudflared",
    args: ["tunnel", "--no-autoupdate", "--loglevel", "warn", "run"],
    env: {
      ...environment,
      TUNNEL_TOKEN: normalized,
    },
  };
}

export function cloudflaredVersion(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return execFileSync(environment.DASHOU_CLOUDFLARED_PATH?.trim() || "cloudflared", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function startCloudflareTunnel(token: string): RunningCloudflareTunnel {
  const spec = cloudflaredRunSpec(token);
  const child = spawn(spec.command, spec.args, {
    env: spec.env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.on("error", (error) => {
    console.error(`Cloudflare Tunnel 启动失败：${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") return;
    console.error(`Cloudflare Tunnel 已退出：code=${String(code)} signal=${String(signal)}`);
  });

  return {
    process: child,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit").then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
