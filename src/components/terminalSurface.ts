import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalTheme } from "../themes";
import {
  shouldClearTerminalInputBuffer,
  shouldScheduleTerminalInputBufferCleanup,
} from "../utils/terminalInput";
import { getPastedImage } from "../utils/terminalPaste";

export interface TerminalDisposable {
  dispose: () => void;
}

export interface TerminalSize {
  rows: number;
  cols: number;
}

export interface TerminalPasteEvent {
  getImage(): Blob | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface TerminalSurface {
  readonly rows: number;
  readonly cols: number;
  readonly element: HTMLElement | undefined;

  open(container: HTMLElement): void;
  attachTo(container: HTMLElement): void;
  fit(): void;
  focus(): void;
  containsActiveElement(activeElement: Element | null): boolean;
  write(data: string): void;
  paste(data: string): void;
  getSelection(): string;
  clearSelection(): void;
  onData(callback: (data: string) => void): TerminalDisposable;
  onResize(callback: (size: TerminalSize) => void): TerminalDisposable;
  onPaste(callback: (event: TerminalPasteEvent) => void): TerminalDisposable;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  clearStaleInputBufferAfterTextInput(data: string): void;
  setFont(fontSize: number, fontFamily: string): void;
  setTheme(theme: TerminalTheme): void;
  setWebglRenderer(enabled: boolean): void;
  dispose(): void;
}

export interface CreateTerminalSurfaceOptions {
  fontSize: number;
  fontFamily: string;
  theme: TerminalTheme;
  enableWebglRenderer: boolean;
  clearStaleInputBufferAfterTextInput: boolean;
  openLink: (uri: string) => void;
}

export const createTerminalSurface = (options: CreateTerminalSurfaceOptions): TerminalSurface =>
  new XtermTerminalSurface(options);

class XtermTerminalSurface implements TerminalSurface {
  private readonly term: XTerm;
  private readonly fitAddon = new FitAddon();
  private webglAddon?: WebglAddon;
  private webglEnabled: boolean;
  private readonly shouldClearStaleInputBufferAfterTextInput: boolean;
  private inputCleanupTimer: number | undefined;
  private textareaEventController: AbortController | undefined;
  private isComposing = false;

  constructor(options: CreateTerminalSurfaceOptions) {
    this.webglEnabled = options.enableWebglRenderer;
    this.shouldClearStaleInputBufferAfterTextInput = options.clearStaleInputBufferAfterTextInput;
    this.term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      theme: toXtermTheme(options.theme),
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.ctrlKey) options.openLink(uri);
    }));
  }

  get rows() {
    return this.term.rows;
  }

  get cols() {
    return this.term.cols;
  }

  get element() {
    return this.term.element;
  }

  open(container: HTMLElement) {
    this.term.open(container);
    this.attachTextareaEventGuards();
    if (this.webglEnabled) this.loadWebglAddon();
  }

  attachTo(container: HTMLElement) {
    if (!this.term.element) {
      this.open(container);
      return;
    }
    if (this.term.element.parentElement !== container) {
      container.appendChild(this.term.element);
    }
  }

  fit() {
    this.fitAddon.fit();
  }

  focus() {
    this.term.focus();
  }

  containsActiveElement(activeElement: Element | null) {
    return !!this.term.element && !!activeElement && this.term.element.contains(activeElement);
  }

  write(data: string) {
    this.term.write(data);
  }

  paste(data: string) {
    this.term.paste(data);
  }

  getSelection() {
    return this.term.getSelection();
  }

  clearSelection() {
    this.term.clearSelection();
  }

  onData(callback: (data: string) => void) {
    return this.term.onData(callback);
  }

  onResize(callback: (size: TerminalSize) => void) {
    return this.term.onResize(callback);
  }

  onPaste(callback: (event: TerminalPasteEvent) => void) {
    const target = this.term.element ?? this.term.textarea;
    if (!target) return { dispose: () => {} };
    const listener = (event: ClipboardEvent) => {
      callback({
        getImage: () => getPastedImage(event.clipboardData),
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => {
          event.stopPropagation();
          event.stopImmediatePropagation();
        },
      });
    };
    target.addEventListener("paste", listener, { capture: true });
    return { dispose: () => target.removeEventListener("paste", listener, { capture: true }) };
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.term.attachCustomKeyEventHandler(handler);
  }

  clearStaleInputBufferAfterTextInput(data: string) {
    const textarea = this.term.textarea;
    if (!textarea || !shouldScheduleTerminalInputBufferCleanup({
      enabled: this.shouldClearStaleInputBufferAfterTextInput,
      data,
      textareaValue: textarea.value,
    })) {
      return;
    }

    if (this.inputCleanupTimer !== undefined) {
      window.clearTimeout(this.inputCleanupTimer);
    }

    this.inputCleanupTimer = window.setTimeout(() => {
      this.inputCleanupTimer = undefined;
      const textarea = this.term.textarea;
      if (!textarea || !shouldClearTerminalInputBuffer({
        isComposing: this.isComposing,
        textareaValue: textarea.value,
      })) {
        return;
      }
      // xterm reads this textarea asynchronously for IME composition. Clearing
      // only after onData avoids losing composed text while preventing WebKitGTK
      // from re-sending accumulated standalone jamo.
      textarea.value = "";
    }, 0);
  }

  setFont(fontSize: number, fontFamily: string) {
    this.term.options.fontSize = fontSize;
    this.term.options.fontFamily = fontFamily;
  }

  setTheme(theme: TerminalTheme) {
    this.term.options.theme = toXtermTheme(theme);
  }

  setWebglRenderer(enabled: boolean) {
    this.webglEnabled = enabled;
    if (enabled) {
      if (!this.webglAddon && this.term.element) this.loadWebglAddon();
      return;
    }

    if (!this.webglAddon) return;
    try {
      this.webglAddon.dispose();
    } catch {}
    this.webglAddon = undefined;
    if (this.term.rows > 0) this.term.refresh(0, this.term.rows - 1);
  }

  dispose() {
    if (this.inputCleanupTimer !== undefined) {
      window.clearTimeout(this.inputCleanupTimer);
      this.inputCleanupTimer = undefined;
    }
    this.textareaEventController?.abort();
    this.webglAddon?.dispose();
    this.term.dispose();
  }

  private attachTextareaEventGuards() {
    if (this.textareaEventController || !this.term.textarea) return;

    this.textareaEventController = new AbortController();
    const { signal } = this.textareaEventController;
    this.term.textarea.addEventListener("compositionstart", () => {
      this.isComposing = true;
      if (this.inputCleanupTimer !== undefined) {
        window.clearTimeout(this.inputCleanupTimer);
        this.inputCleanupTimer = undefined;
      }
    }, { signal });
    this.term.textarea.addEventListener("compositionend", () => {
      this.isComposing = false;
    }, { signal });
  }

  private loadWebglAddon() {
    try {
      const addon = new WebglAddon();
      this.term.loadAddon(addon);
      this.webglAddon = addon;
    } catch {
      this.webglAddon = undefined;
    }
  }
}

const toXtermTheme = (theme: TerminalTheme): ITheme => theme;
