export interface PtyEventRef {
  id: number;
}

export const consumePtyEventsForId = <T extends PtyEventRef>(
  events: T[],
  id: number,
): T[] => {
  const matched = events.filter((event) => event.id === id);
  events.length = 0;
  return matched;
};

export const describePtyExit = (code: number | null | undefined): string =>
  code === null || code === undefined
    ? "reconnected PTY exited immediately"
    : `reconnected PTY exited immediately with code ${code}`;
