import test from "node:test";
import assert from "node:assert/strict";

import { formatClockTime, formatMessageTiming, formatTimeDelta } from "../ui/timestamps.ts";

test("formatClockTime uses compact local time with milliseconds", () => {
  const timestamp = new Date(2026, 4, 6, 7, 8, 9, 10).getTime();
  assert.equal(formatClockTime(timestamp), "07:08:09.010");
});

test("formatTimeDelta keeps subsecond precision and clock-skew sign", () => {
  assert.equal(formatTimeDelta(0), "+0ms");
  assert.equal(formatTimeDelta(42), "+42ms");
  assert.equal(formatTimeDelta(-1500), "−1.50s");
  assert.equal(formatTimeDelta(62_000), "+1m02s");
});

test("formatMessageTiming measures each stage from the prior stage", () => {
  const sentAt = new Date(2026, 4, 6, 7, 8, 9, 10).getTime();
  assert.equal(
    formatMessageTiming({ sentAt, receivedAt: sentAt + 12, readAt: sentAt + 250 }),
    `sent ${formatClockTime(sentAt)} · received ${formatClockTime(sentAt + 12)} (+12ms) · read ${formatClockTime(sentAt + 250)} (+238ms)`,
  );
});
