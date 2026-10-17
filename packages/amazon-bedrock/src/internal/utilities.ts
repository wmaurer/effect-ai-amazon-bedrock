import type * as Response from "effect/ai/Response"
import * as Schema from "effect/Schema"
import { KnownStopReason, type StopReason } from "../AmazonBedrockSchema.ts"

const isKnownStopReason = Schema.is(KnownStopReason)

const finishReasonMap: Record<KnownStopReason, Response.FinishReason> = {
  content_filtered: "content-filter",
  end_turn: "stop",
  guardrail_intervened: "content-filter",
  malformed_model_output: "error",
  malformed_tool_use: "error",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  stop_sequence: "stop",
  tool_use: "tool-calls"
}

/** @internal */
export const resolveFinishReason = (stopReason: StopReason): Response.FinishReason =>
  isKnownStopReason(stopReason) ? finishReasonMap[stopReason] : "other"
