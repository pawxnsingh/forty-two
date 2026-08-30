import {
  MAX_PLAN_ITEMS,
  MAX_PLAN_ITEM_TEXT_LENGTH,
  MAX_PLAN_SUMMARY_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  PLAN_ITEM_STATUSES,
  setChatSessionPlan,
  updateChatSessionPlanItem,
  type SessionPlanSnapshot,
} from "@forty-two/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toolFailure, toolSuccess } from "./json.js";

const setInput = z
  .object({
    sessionId: z.string().regex(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/),
    action: z.literal("set"),
    title: z.string().trim().min(1).max(MAX_PLAN_TITLE_LENGTH),
    items: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(MAX_PLAN_ITEM_TEXT_LENGTH),
          status: z.enum(PLAN_ITEM_STATUSES).optional(),
        }),
      )
      .min(1)
      .max(MAX_PLAN_ITEMS),
    itemIndex: z.never().optional(),
    status: z.never().optional(),
    summary: z.never().optional(),
  })
  .strict();

const updateInput = z
  .object({
    sessionId: z.string().regex(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/),
    action: z.literal("update_item"),
    itemIndex: z.number().int().nonnegative(),
    status: z.enum(PLAN_ITEM_STATUSES),
    summary: z.string().trim().max(MAX_PLAN_SUMMARY_LENGTH).optional(),
    title: z.never().optional(),
    items: z.never().optional(),
  })
  .strict();

export const PlanToolInputSchema = z.discriminatedUnion("action", [
  setInput,
  updateInput,
]);
export type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

// MCP tool inputs must be advertised as an object schema. Keep the conditional
// action contract strict in PlanToolInputSchema while exposing every field to
// tool-calling models through the SDK's object-schema conversion.
const advertisedInputSchema = z.object({
  sessionId: z
    .string()
    .regex(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/)
    .describe("Exact application session ID from session context."),
  action: z.enum(["set", "update_item"]),
  title: z.string().trim().min(1).max(MAX_PLAN_TITLE_LENGTH).nullish(),
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(MAX_PLAN_ITEM_TEXT_LENGTH),
        status: z.enum(PLAN_ITEM_STATUSES).nullish(),
      }),
    )
    .min(1)
    .max(MAX_PLAN_ITEMS)
    .nullish(),
  itemIndex: z.number().int().nonnegative().nullish(),
  status: z.enum(PLAN_ITEM_STATUSES).nullish(),
  summary: z.string().trim().max(MAX_PLAN_SUMMARY_LENGTH).nullish(),
});

export interface PlanStore {
  set(input: {
    chatSessionId: string;
    title: string;
    items: Array<{
      text: string;
      status?: (typeof PLAN_ITEM_STATUSES)[number];
    }>;
  }): Promise<SessionPlanSnapshot>;
  updateItem(input: {
    chatSessionId: string;
    itemIndex: number;
    status: (typeof PLAN_ITEM_STATUSES)[number];
    summary?: string;
  }): Promise<SessionPlanSnapshot>;
}

const defaultStore: PlanStore = {
  set: setChatSessionPlan,
  updateItem: updateChatSessionPlanItem,
};

const description = `Maintain the visible multi-step plan for the current Forty Two question.

Use this only for non-trivial work with multiple stages. Set the plan once near the start, then update each item to in_progress when work starts and completed, failed, or skipped when it finishes. Never leave finished work in_progress.

The sessionId must be the exact sess_ identifier supplied in the session context. Plans contain at most ${MAX_PLAN_ITEMS} concise, outcome-oriented items. Repeating an identical operation is safe. Every success returns the authoritative canonical plan, revision, and update timestamp.`;

export function createTodoMcpServer(
  store: PlanStore = defaultStore,
): McpServer {
  const server = new McpServer({ name: "forty-two-todo", version: "0.1.0" });

  server.registerTool(
    "plan",
    {
      title: "Update session plan",
      description,
      inputSchema: advertisedInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      try {
        const input = PlanToolInputSchema.parse(normalizeInput(rawInput));
        const snapshot =
          input.action === "set"
            ? await store.set({
                chatSessionId: input.sessionId,
                title: input.title,
                items: input.items,
              })
            : await store.updateItem({
                chatSessionId: input.sessionId,
                itemIndex: input.itemIndex,
                status: input.status,
                ...(input.summary === undefined
                  ? {}
                  : { summary: input.summary }),
              });
        return toolSuccess({
          plan: snapshot.plan,
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt?.toISOString() ?? null,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}

function normalizeInput(
  input: z.infer<typeof advertisedInputSchema>,
): Record<string, unknown> {
  if (input.action === "set") {
    if (
      input.itemIndex != null ||
      input.status != null ||
      input.summary != null
    ) {
      throw new Error("Set does not accept item update fields.");
    }
    return {
      sessionId: input.sessionId,
      action: input.action,
      title: input.title ?? undefined,
      items: input.items?.map(({ text, status }) => ({
        text,
        ...(status == null ? {} : { status }),
      })),
    };
  }
  if (input.title != null || input.items != null) {
    throw new Error("Update_item does not accept plan replacement fields.");
  }
  return {
    sessionId: input.sessionId,
    action: input.action,
    itemIndex: input.itemIndex ?? undefined,
    status: input.status ?? undefined,
    ...(input.summary == null ? {} : { summary: input.summary }),
  };
}
