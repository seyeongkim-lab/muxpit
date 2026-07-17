export const newDesktopAgentChannelNamespace = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const desktopAgentChannelId = (
  namespace: string,
  provider: string,
  purpose: string,
  timestamp: number,
  sequence: number,
): string => `${namespace}-${provider}-${purpose}-${timestamp}-${sequence}`;
