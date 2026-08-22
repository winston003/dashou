export function hasControlPlaneCapability(metadata, capability) {
  return Array.isArray(metadata?.capabilities) && metadata.capabilities.includes(capability);
}

export function missingCapabilityMessage(metadata, capability, featureLabel) {
  const serviceVersion = metadata?.serviceVersion ?? metadata?.version ?? "旧版";
  return `当前线上控制面（${serviceVersion}）未声明 ${capability}，${featureLabel}已安全停用。请升级独立控制面服务；无需升级客户端或 Admin 面板。`;
}
