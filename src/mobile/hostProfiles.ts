export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  cwd: string;
  trustedFingerprint?: string;
}

const STORAGE_KEY = "wmux-mobile-hosts-v1";

const isHostProfile = (value: unknown): value is HostProfile => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === "string"
    && typeof profile.name === "string"
    && typeof profile.host === "string"
    && typeof profile.port === "number"
    && typeof profile.user === "string"
    && typeof profile.cwd === "string"
    && (profile.trustedFingerprint === undefined || typeof profile.trustedFingerprint === "string");
};

export const loadHostProfiles = (): HostProfile[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isHostProfile) : [];
  } catch {
    return [];
  }
};

export const saveHostProfiles = (profiles: HostProfile[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
};

export const upsertHostProfile = (
  profiles: HostProfile[],
  profile: HostProfile,
): HostProfile[] => {
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  return index < 0
    ? [...profiles, profile]
    : profiles.map((candidate) => candidate.id === profile.id ? profile : candidate);
};
