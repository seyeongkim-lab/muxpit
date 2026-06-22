import type { PtyBackend } from "./ptyBackend";
import { browserPtyBackend } from "./browserPtyBackend.ts";
import { isTauriRuntime } from "./runtime.ts";
import { tauriPtyBackend } from "./tauriPtyBackend.ts";

export const getPtyBackend = (): PtyBackend =>
  isTauriRuntime() ? tauriPtyBackend : browserPtyBackend;
