import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const intercomOutputSchema = Type.Object({
  ok: Type.Boolean(),
  text: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
});

type ToolResult = Awaited<ReturnType<ToolDefinition<any, any>["execute"]>>;

/** Keep model/TUI content unchanged while giving codemode callers JSON data. */
export function structuredIntercomResult(result: ToolResult): ToolResult {
  const details = result.details ?? {};
  const isError = result.isError === true || details.error === true || details.delivered === false;
  return {
    ...result,
    details,
    isError,
    structuredContent: {
      ok: !isError,
      text: result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
      data: JSON.parse(JSON.stringify(details)),
    },
  };
}
