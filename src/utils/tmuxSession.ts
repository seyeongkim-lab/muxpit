/**
 * Sanitise a tmux session name to `[A-Za-z0-9_-]`.
 *
 * Mirrors `pty.rs::spawn_tmux_cc` (src-tauri/src/pty.rs:79-82) so the frontend
 * stores the same string the remote tmux server actually sees. Without this,
 * `wmux-192.168.0.7` on the frontend would diverge from `wmux-192_168_0_7` on
 * the server, breaking wrapper-session matching in the Sidebar list.
 */
export const sanitizeTmuxSessionName = (name: string): string =>
  name.replace(/[^A-Za-z0-9_-]/g, "_");
