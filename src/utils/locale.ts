const FALLBACK_LOCALE = "en-US";

const stripEncoding = (value: string): string => value.split(".")[0] ?? value;

export const normalizeLocaleTag = (
  value: unknown,
  fallback = FALLBACK_LOCALE,
): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;

  const tag = stripEncoding(raw).replace(/_/g, "-");
  if (!tag || /^c$/i.test(tag) || /^posix$/i.test(tag)) return fallback;

  try {
    return Intl.getCanonicalLocales(tag)[0] ?? fallback;
  } catch {
    return fallback;
  }
};

export const normalizeLocaleTags = (
  values: readonly unknown[] | undefined,
  fallback = FALLBACK_LOCALE,
): string[] => {
  const normalized = (values ?? [])
    .map((value) => normalizeLocaleTag(value, fallback))
    .filter((value, index, all) => all.indexOf(value) === index);
  return normalized.length > 0 ? normalized : [fallback];
};

export const installNavigatorLocaleFallback = (
  nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean => {
  if (!nav) return false;

  const language = normalizeLocaleTag(nav.language);
  const languages = normalizeLocaleTags(nav.languages?.length ? nav.languages : [nav.language], language);
  const needsFallback = nav.language !== language || nav.languages?.join("\0") !== languages.join("\0");
  if (!needsFallback) return false;

  try {
    Object.defineProperty(nav, "language", {
      configurable: true,
      get: () => language,
    });
    Object.defineProperty(nav, "languages", {
      configurable: true,
      get: () => languages,
    });
    if (typeof document !== "undefined") {
      document.documentElement.lang = language;
    }
    return true;
  } catch {
    return false;
  }
};
