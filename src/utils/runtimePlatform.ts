type NavigatorLike = {
  platform?: string;
  userAgent?: string;
};

export type RuntimePlatform = "linux" | "windows" | "macos" | "unknown";

const currentNavigator = (): NavigatorLike | null =>
  typeof navigator === "undefined" ? null : navigator;

export const getRuntimePlatform = (platform = currentNavigator()?.platform ?? ""): RuntimePlatform => {
  if (/^win/i.test(platform)) return "windows";
  if (/mac/i.test(platform)) return "macos";
  if (/linux/i.test(platform)) return "linux";
  return "unknown";
};

export const isLinuxPlatform = (platform = currentNavigator()?.platform ?? ""): boolean =>
  getRuntimePlatform(platform) === "linux";

export const isWindowsPlatform = (platform = currentNavigator()?.platform ?? ""): boolean =>
  getRuntimePlatform(platform) === "windows";

export const isMacOsPlatform = (platform = currentNavigator()?.platform ?? ""): boolean =>
  getRuntimePlatform(platform) === "macos";

export const isLinuxWebKitRuntime = (nav = currentNavigator()): boolean => {
  if (!nav) return false;
  const platform = nav.platform ?? "";
  const userAgent = nav.userAgent ?? "";

  return (
    isLinuxPlatform(platform) &&
    /(applewebkit|webkitgtk)/i.test(userAgent) &&
    !/(chrome|chromium|crios|edg|firefox)/i.test(userAgent)
  );
};

export const shouldEnableWebglRendererByDefault = (
  platform = currentNavigator()?.platform,
): boolean => {
  if (platform === undefined) return true;
  return !isLinuxPlatform(platform) && !isWindowsPlatform(platform);
};

export const isPowerShellCommand = (command: string): boolean =>
  /\b(pwsh|powershell|cmd(?:\.exe)?)\b/i.test(command);
