import type { PtyBackend } from "./ptyBackend";
import { browserPtyBackend } from "./browserPtyBackend";
import { isTauriRuntime } from "./runtime";
import { tauriPtyBackend } from "./tauriPtyBackend";

export const getPtyBackend = (): PtyBackend =>
  isTauriRuntime() ? tauriPtyBackend : browserPtyBackend;

