import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { InlineMessageComponent } from "../ui/inline-message.ts";
import { formatClockTime } from "../ui/timestamps.ts";
import type { Message, SessionInfo } from "../types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
};

const from: SessionInfo = {
  id: "session-12345678",
  name: "sender",
  cwd: "/tmp/project",
  model: "model",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

const message: Message = {
  id: "message-1",
  timestamp: 0,
  content: {
    text: "This is a long message that should use the available terminal width instead of a narrow fixed card.",
  },
};

test("inline intercom messages render at the available terminal width", () => {
  const component = new InlineMessageComponent(from, message, theme as any);

  const lines = component.render(120);

  assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("expanded inline intercom messages show the full body without collapse controls", () => {
  const component = new InlineMessageComponent(from, message, theme as any, "intercom({ action: \"reply\", message: \"...\" })");

  const rendered = component.render(100).join("\n");

  assert.match(rendered, /available terminal width/);
  assert.match(rendered, /narrow fixed/);
  assert.match(rendered, /card/);
  assert.match(rendered, /To reply: intercom/);
  assert.doesNotMatch(rendered, /Ctrl\+O/);
});

test("inline intercom messages show sent, received, read, and elapsed timings", () => {
  const sentAt = new Date(2026, 0, 2, 3, 4, 5, 100).getTime();
  const receivedAt = sentAt + 25;
  const readAt = receivedAt + 375;
  const component = new InlineMessageComponent(
    from,
    { ...message, timestamp: sentAt },
    theme as any,
    undefined,
    undefined,
    false,
    receivedAt,
    readAt,
  );

  const rendered = component.render(140).join("\n");

  assert.match(rendered, new RegExp(`sent ${formatClockTime(sentAt).replaceAll(".", "\\.")}`));
  assert.match(rendered, new RegExp(`received ${formatClockTime(receivedAt).replaceAll(".", "\\.")} \\(\\+25ms\\)`));
  assert.match(rendered, new RegExp(`read ${formatClockTime(readAt).replaceAll(".", "\\.")} \\(\\+375ms\\)`));
});

test("collapsed inline intercom messages keep preview, reply hint, and expand key visible", () => {
  const component = new InlineMessageComponent(
    from,
    {
      ...message,
      content: {
        text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. This tail should only appear when expanded because the collapsed preview is intentionally brief.",
        attachments: [{ type: "snippet", name: "note.txt", content: "important details" }],
      },
    },
    theme as any,
    "intercom({ action: \"reply\", message: \"...\" })",
    undefined,
    true,
  );

  const lines = component.render(120);
  const rendered = lines.join("\n");

  assert.equal(lines.length, 4);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
  assert.match(rendered, /Alpha beta gamma/);
  assert.doesNotMatch(rendered, /intentionally brief/);
  assert.match(rendered, /To reply: intercom/);
  assert.match(rendered, /Ctrl\+O/);
  assert.match(rendered, /1 attachment/);
});
