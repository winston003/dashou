export type DashouToolAction = "read" | "write" | "edit" | "execute";

export interface DashouPermissionDecision {
  allowed: boolean;
  reason: string;
}

export class DashouPermissionGate {
  constructor(private readonly allowProjectCommands: boolean) {}

  decide(action: DashouToolAction): DashouPermissionDecision {
    if (action === "execute" && !this.allowProjectCommands) {
      return {
        allowed: false,
        reason: "这台电脑尚未允许项目命令。请打开搭手 → 设置，开启“允许 ChatGPT 运行项目命令”后再试。",
      };
    }
    return { allowed: true, reason: "inside_authorized_workspace" };
  }
}
