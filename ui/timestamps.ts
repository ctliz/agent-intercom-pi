export interface MessageTiming {
  sentAt?: number;
  receivedAt?: number;
  readAt?: number;
  deliveredAt?: number;
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Format a timestamp in the user's local timezone for compact TUI rows. */
export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Format a signed elapsed duration without hiding clock skew. */
export function formatTimeDelta(durationMs: number): string {
  const sign = durationMs < 0 ? "−" : "+";
  const absolute = Math.abs(durationMs);
  if (absolute < 1000) return `${sign}${Math.round(absolute)}ms`;
  if (absolute < 60_000) return `${sign}${(absolute / 1000).toFixed(absolute < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(absolute / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1000);
  return `${sign}${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Build compact message timing text. Each parenthesized delta is measured from
 * the immediately preceding timestamp.
 */
export function formatMessageTiming(timing: MessageTiming): string {
  const parts: string[] = [];
  let previous: number | undefined;

  const add = (label: string, timestamp: number | undefined) => {
    if (!validTimestamp(timestamp)) return;
    const delta = previous === undefined ? "" : ` (${formatTimeDelta(timestamp - previous)})`;
    parts.push(`${label} ${formatClockTime(timestamp)}${delta}`);
    previous = timestamp;
  };

  add("sent", timing.sentAt);
  add("received", timing.receivedAt);
  add("delivered", timing.deliveredAt);
  add("read", timing.readAt);
  return parts.join(" · ");
}
