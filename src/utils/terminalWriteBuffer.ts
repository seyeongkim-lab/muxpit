export interface WriteScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

export interface TerminalWriteBuffer {
  write(data: string): void;
  flush(): void;
  dispose(): void;
}

const createDefaultScheduler = (): WriteScheduler => {
  if (typeof window !== "undefined" && window.requestAnimationFrame && window.cancelAnimationFrame) {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (id) => window.cancelAnimationFrame(id),
    };
  }
  return {
    request: (callback) => setTimeout(callback, 0) as unknown as number,
    cancel: (id) => clearTimeout(id),
  };
};

export const createTerminalWriteBuffer = (
  writeNow: (data: string) => void,
  scheduler: WriteScheduler = createDefaultScheduler(),
  maxBufferedChars = 128 * 1024,
): TerminalWriteBuffer => {
  let chunks: string[] = [];
  let bufferedChars = 0;
  let scheduledId: number | null = null;
  let disposed = false;

  const flushChunks = () => {
    if (chunks.length === 0) return;
    const data = chunks.length === 1 ? chunks[0] : chunks.join("");
    chunks = [];
    bufferedChars = 0;
    writeNow(data);
  };

  const scheduledFlush = () => {
    scheduledId = null;
    if (!disposed) flushChunks();
  };

  const cancelScheduledFlush = () => {
    if (scheduledId === null) return;
    scheduler.cancel(scheduledId);
    scheduledId = null;
  };

  return {
    write(data) {
      if (disposed || data.length === 0) return;
      chunks.push(data);
      bufferedChars += data.length;

      if (bufferedChars >= maxBufferedChars) {
        cancelScheduledFlush();
        flushChunks();
        return;
      }

      if (scheduledId === null) {
        scheduledId = scheduler.request(scheduledFlush);
      }
    },

    flush() {
      if (disposed) return;
      cancelScheduledFlush();
      flushChunks();
    },

    dispose() {
      cancelScheduledFlush();
      chunks = [];
      bufferedChars = 0;
      disposed = true;
    },
  };
};
