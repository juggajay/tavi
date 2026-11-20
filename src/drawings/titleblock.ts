// When code can't read a title block (unlabelled fields, outlined or scanned sheets), Claude looks at it.
import { readFile } from "node:fs/promises";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type TitleBlockRead = { is_title_block: boolean; sheet_no: string; title: string; revision: string; confidence: "high" | "medium" | "low" };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_title_block", "sheet_no", "title", "revision", "confidence"],
  properties: {
    is_title_block: {
      type: "boolean",
      description: "false if this isn't part of a construction drawing at all (a brochure, report, spec or spreadsheet page)",
    },
    sheet_no: { type: "string", description: "Drawing/sheet number exactly as printed, e.g. A-2000, CC.04, S-101. Empty if not visible." },
    title: { type: "string", description: "Sheet title exactly as printed. Empty if not visible." },
    revision: { type: "string", description: "The sheet's CURRENT revision: the revision box, or the latest row of the revision table. Empty if not visible." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

export async function readTitleBlock(pngPath: string, hints: Record<string, unknown>): Promise<TitleBlockRead> {
  // Fixture building and tests index sheets from their text alone (no model call).
  if (process.env.LH_NO_VISION === "1") throw new Error("vision reading is off");
  const data = (await readFile(pngPath)).toString("base64");
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
          {
            type: "text",
            text:
              "This should be the title-block area of one construction drawing sheet. Read the drawing number, the sheet title and the " +
              "current revision. Copy each exactly as printed (keep dots, dashes and spaces). Numbers can be split over two lines, " +
              "e.g. 'CC.' above '04' is 'CC.04'. A large single letter or number in its own box next to the drawing number is usually " +
              "the revision. The title is what the sheet shows (e.g. 'GROUND FLOOR PLAN'), not an issue status like 'FOR COORDINATION' " +
              "and not the project name or address. Ignore standard references like AS 1428.1 and postcodes. " +
              "If something isn't visible, return an empty string. Never guess.\n" +
              `Partial hints from the PDF text (may be incomplete or wrong): ${JSON.stringify(hints)}`,
          },
        ],
      },
    } as SDKUserMessage;
  }
  // A stuck read must not stall the whole indexing queue.
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120_000);
  const q = query({
    prompt: prompt(),
    options: {
      abortController,
      model: process.env.VISION_MODEL || "claude-haiku-5-5",
      effort: "low",
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
      maxTurns: 3,
      persistSession: false,
      systemPrompt: "You read construction drawing title blocks precisely and never guess.",
      outputFormat: { type: "json_schema", schema: SCHEMA },
    },
  });
  try {
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success" || !m.structured_output) throw new Error(`title block read failed: ${m.subtype}`);
        return m.structured_output as TitleBlockRead;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) throw new Error("title block read timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  throw new Error("title block read ended without a result");
}
