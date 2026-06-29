// OSC 52 clipboard handling. A program inside the terminal (e.g. a remote tmux
// with `set -s set-clipboard on`) emits `OSC 52 ; Pc ; Pd ST` to set the host
// clipboard, where Pc selects the target buffer and Pd is base64-encoded data
// (or "?" to request a read). xterm.js does not handle OSC 52 itself.

// Returns the decoded clipboard text for a write request, or null when the
// sequence is a read request, empty, or malformed. Read requests ("?") are
// refused so a remote program cannot exfiltrate the host clipboard.
export const decodeOsc52ClipboardWrite = (data: string): string | null => {
  const separator = data.indexOf(";");
  if (separator === -1) return null;
  const payload = data.slice(separator + 1).trim();
  if (payload === "" || payload === "?") return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};
