import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const DASHOU_V0_TOOLS = ["list_projects", "open_project", "read", "write", "edit", "execute"] as const;

export function dashouVersion(): string {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("无法读取搭手版本号");
  return packageJson.version;
}

export interface DashouCapabilities {
  name: "dashou";
  version: string;
  protocol: "streamable-http";
  oauth: true;
  tools: string[];
}

export function dashouCapabilities(): DashouCapabilities {
  return {
    name: "dashou",
    version: dashouVersion(),
    protocol: "streamable-http",
    oauth: true,
    tools: [...DASHOU_V0_TOOLS],
  };
}
