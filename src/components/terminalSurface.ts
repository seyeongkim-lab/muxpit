import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalTheme } from "../themes";

export interface TerminalDisposable {
  dispose: () => void;
}

export interface TerminalSize {
  rows: number;
  cols: number;
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
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  clearInputBufferAfterPrintableCommit(data: string): void;
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
  clearInputTextareaAfterCommit: boolean;
  openLink: (uri: string) => void;
}

export const createTerminalSurface = (options: CreateTerminalSurfaceOptions): TerminalSurface =>
  new XtermTerminalSurface(options);

const isPrintableInput = (data: string) => data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);

class XtermTerminalSurface implements TerminalSurface {
  private readonly term: XTerm;
  private readonly fitAddon = new FitAddon();
  private readonly clearInputTextareaAfterCommit: boolean;
  private webglAddon?: WebglAddon;
  private webglEnabled: boolean;

  constructor(options: CreateTerminalSurfaceOptions) {
    this.clearInputTextareaAfterCommit = options.clearInputTextareaAfterCommit;
    this.webglEnabled = options.enableWebglRenderer;
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

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.term.attachCustomKeyEventHandler(handler);
  }

  clearInputBufferAfterPrintableCommit(data: string) {
    const textarea = this.term.textarea;
    if (
      !this.clearInputTextareaAfterCommit ||
      !textarea ||
      !isPrintableInput(data) ||
      textarea.value.length === 0
    ) {
      return;
    }

    // WebKitGTK Korean IMEs can leave committed jamo in xterm's helper textarea.
    // If it remains there, the next standalone jamo is appended to it and xterm
    // sends the whole accumulated value.
    textarea.value = "";
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
    this.webglAddon?.dispose();
    this.term.dispose();
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
