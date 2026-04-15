import { usePrefixStore } from "../stores/prefix";
import { useSettingsStore, PREFIX_KEY_CHOICES } from "../stores/settings";

export const PrefixIndicator = () => {
  const active = usePrefixStore((s) => s.active);
  const prefixKey = useSettingsStore((s) => s.prefixKey);

  if (!active) return null;

  const label =
    PREFIX_KEY_CHOICES.find((c) => c.value === prefixKey)?.label.split(" ")[0] ?? prefixKey;

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 12,
        zIndex: 1000,
        padding: "4px 10px",
        borderRadius: 4,
        backgroundColor: "#f9e2af",
        color: "#1e1e2e",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      PREFIX {label} — waiting
    </div>
  );
};
