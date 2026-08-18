/**
 * The `AmazonBedrockSchema` module defines the text and tool-calling subset of
 * the Amazon Bedrock Converse API request, response, and streaming event
 * schemas used by this provider.
 *
 * **Scope**
 *
 * This models text and tool use (tool-use / tool-result content blocks and tool
 * configuration). Images and documents are not modelled here yet,
 * but the content block and delta unions tolerate (and ignore) non-text members
 * so decoding never fails on them.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"

const prefix = "@effect/ai-amazon-bedrock"

const makeIdentifier = (name: string) => `${prefix}/${name}`

/**
 * A non-negative integer, used for token counts and content block indices.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IntZeroOrGreater = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The reason the model stopped generating a response.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StopReason = Schema.Literals([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "guardrail_intervened",
  "content_filtered",
  "malformed_model_output",
  "malformed_tool_use",
  "model_context_window_exceeded"
])

/**
 * The type of {@link StopReason}.
 *
 * @category schemas
 * @since 4.0.0
 */
export type StopReason = typeof StopReason.Type

/**
 * Token usage statistics returned by the Converse API.
 *
 * @category schemas
 * @since 4.0.0
 */
export class TokenUsage extends Schema.Class<TokenUsage>(makeIdentifier("TokenUsage"))({
  inputTokens: IntZeroOrGreater,
  outputTokens: IntZeroOrGreater,
  totalTokens: IntZeroOrGreater,
  cacheReadInputTokens: Schema.optional(IntZeroOrGreater),
  cacheWriteInputTokens: Schema.optional(IntZeroOrGreater)
}) {}

// =============================================================================
// Request
// =============================================================================

/**
 * A tool-use content block: the model's request to invoke a tool.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ToolUseBlock extends Schema.Class<ToolUseBlock>(makeIdentifier("ToolUseBlock"))({
  toolUseId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
}) {}

/**
 * A tool-result content block: the outcome of a tool invocation fed back to the
 * model. Content is text-only in this provider.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ToolResultBlock extends Schema.Class<ToolResultBlock>(makeIdentifier("ToolResultBlock"))({
  toolUseId: Schema.String,
  content: Schema.Array(Schema.Struct({ text: Schema.String }))
}) {}

/**
 * The reasoning text produced by a model, with the token that verifies the
 * model generated it.
 *
 * **Details**
 *
 * `signature` must be echoed back unmodified alongside the text when the block
 * is sent in a later turn, or Bedrock rejects the request.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ReasoningTextBlock extends Schema.Class<ReasoningTextBlock>(makeIdentifier("ReasoningTextBlock"))({
  text: Schema.String,
  signature: Schema.optional(Schema.String)
}) {}

/**
 * A reasoning content block.
 *
 * **Details**
 *
 * AWS models `ReasoningContentBlock` as a UNION of `reasoningText` and
 * `redactedContent`, so both members are optional here. `redactedContent` is a
 * Smithy blob, which the JSON protocol carries as a base64 string; it is kept
 * as that string so it round-trips untouched.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReasoningContentBlock = Schema.Struct({
  reasoningText: Schema.optional(ReasoningTextBlock),
  redactedContent: Schema.optional(Schema.String)
})

/**
 * A text content block within a Converse message.
 *
 * **Details**
 *
 * AWS models `ContentBlock` as a UNION whose members (`text`, `toolUse`,
 * `reasoningContent`, ...) are all optional. Every member is optional here so
 * a block this provider does not model (e.g. `citationsContent`) decodes (as
 * `{ type: "text" }` with no `text`) instead of failing the whole response;
 * the language model ignores such blocks.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlock = Schema.Struct({
  type: Schema.tagDefaultOmit("text"),
  text: Schema.optional(Schema.String),
  toolUse: Schema.optional(ToolUseBlock),
  toolResult: Schema.optional(ToolResultBlock),
  reasoningContent: Schema.optional(ReasoningContentBlock)
})

/**
 * A message within a Converse conversation.
 *
 * @category schemas
 * @since 4.0.0
 */
export class Message extends Schema.Class<Message>(makeIdentifier("Message"))({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Array(ContentBlock)
}) {}

/**
 * A system content block (text only).
 *
 * @category schemas
 * @since 4.0.0
 */
export const SystemContentBlock = Schema.Struct({
  text: Schema.String
})

/**
 * Base inference parameters to pass to a model in a Converse call.
 *
 * @category schemas
 * @since 4.0.0
 */
export class InferenceConfiguration extends Schema.Class<InferenceConfiguration>(
  makeIdentifier("InferenceConfiguration")
)({
  maxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  stopSequences: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number)
}) {}

/**
 * The JSON Schema specification of a tool the model may call.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ToolSpecification extends Schema.Class<ToolSpecification>(makeIdentifier("ToolSpecification"))({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.Struct({
    json: Schema.Record(Schema.String, Schema.Unknown)
  })
}) {}

/**
 * A tool entry within a {@link ToolConfiguration}.
 *
 * @category schemas
 * @since 4.0.0
 */
export class Tool extends Schema.Class<Tool>(makeIdentifier("Tool"))({
  toolSpec: ToolSpecification
}) {}

/**
 * Controls how the model selects a tool: let it decide (`auto`), force any tool
 * (`any`), or force a specific tool (`tool`).
 *
 * @category schemas
 * @since 4.0.0
 */
export const ToolChoice = Schema.Union([
  Schema.Struct({ auto: Schema.Struct({}) }),
  Schema.Struct({ any: Schema.Struct({}) }),
  Schema.Struct({ tool: Schema.Struct({ name: Schema.String }) })
])

/**
 * The type of {@link ToolChoice}.
 *
 * @category schemas
 * @since 4.0.0
 */
export type ToolChoice = typeof ToolChoice.Type

/**
 * The tool configuration for a Converse request.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ToolConfiguration extends Schema.Class<ToolConfiguration>(makeIdentifier("ToolConfiguration"))({
  tools: Schema.Array(Tool),
  toolChoice: Schema.optionalKey(ToolChoice)
}) {}

/**
 * The request payload for the Converse and ConverseStream operations.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ConverseRequest extends Schema.Class<ConverseRequest>(makeIdentifier("ConverseRequest"))({
  modelId: Schema.String,
  messages: Schema.Array(Message),
  system: Schema.optional(Schema.Array(SystemContentBlock)),
  toolConfig: Schema.optionalKey(ToolConfiguration),
  inferenceConfig: Schema.optional(InferenceConfiguration)
}) {}

// =============================================================================
// Response
// =============================================================================

/**
 * The output containing the message generated by the model.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ConverseOutput extends Schema.Class<ConverseOutput>(makeIdentifier("ConverseOutput"))({
  message: Message
}) {}

/**
 * Metrics about a Converse call.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ConverseMetrics extends Schema.Class<ConverseMetrics>(makeIdentifier("ConverseMetrics"))({
  latencyMs: Schema.Number
}) {}

/**
 * The response from a successful Converse call.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ConverseResponse extends Schema.Class<ConverseResponse>(makeIdentifier("ConverseResponse"))({
  output: ConverseOutput,
  usage: TokenUsage,
  stopReason: StopReason,
  metrics: Schema.optional(ConverseMetrics)
}) {}

// =============================================================================
// Converse Stream Events
// =============================================================================

/**
 * The start of a streamed message.
 *
 * @category schemas
 * @since 4.0.0
 */
export class MessageStartEvent extends Schema.Class<MessageStartEvent>(
  makeIdentifier("MessageStartEvent")
)({
  role: Schema.Literals(["user", "assistant"])
}) {}

/**
 * The tool-use member of a streaming content-block delta. Bedrock streams tool
 * arguments as a partial JSON string that the consumer accumulates across
 * deltas and parses once the block stops.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ToolUseBlockDelta = Schema.Struct({
  input: Schema.String
})

/**
 * The reasoning-content member of a streaming content-block delta.
 *
 * **Details**
 *
 * AWS models `ReasoningContentBlockDelta` as a UNION of `text`, `signature`,
 * and `redactedContent`, so every member is optional. The signature arrives in
 * its own delta after the text deltas, once the model has finished reasoning.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReasoningContentBlockDelta = Schema.Struct({
  text: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  redactedContent: Schema.optional(Schema.String)
})

/**
 * A delta within a streaming content block.
 *
 * **Details**
 *
 * AWS models `ContentBlockDelta` as a UNION whose members (`text`, `toolUse`,
 * `reasoningContent`, `citation`, ...) are all optional. Every member is
 * optional here so a delta this provider does not model (e.g. a citation) does
 * not fail the union decode and truncate the stream; the language model skips
 * such deltas.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockDelta = Schema.Struct({
  text: Schema.optional(Schema.String),
  toolUse: Schema.optional(ToolUseBlockDelta),
  reasoningContent: Schema.optional(ReasoningContentBlockDelta)
})

/**
 * A streamed delta event for a content block.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ContentBlockDeltaEvent extends Schema.Class<ContentBlockDeltaEvent>(
  makeIdentifier("ContentBlockDeltaEvent")
)({
  contentBlockIndex: IntZeroOrGreater,
  delta: ContentBlockDelta
}) {}

/**
 * A streamed stop event for a content block.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ContentBlockStopEvent extends Schema.Class<ContentBlockStopEvent>(
  makeIdentifier("ContentBlockStopEvent")
)({
  contentBlockIndex: IntZeroOrGreater
}) {}

/**
 * The tool-use member of a streaming content-block start. Carries the call id
 * and tool name; the arguments arrive as `toolUse` deltas.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ToolUseBlockStart = Schema.Struct({
  toolUseId: Schema.String,
  name: Schema.String
})

/**
 * The start of a streaming content block.
 *
 * **Details**
 *
 * Like `ContentBlockDelta`, AWS models this as a union of optional members.
 * Members this provider does not model decode with their keys undefined rather
 * than failing the union decode and truncating the stream.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockStart = Schema.Struct({
  toolUse: Schema.optional(ToolUseBlockStart)
})

/**
 * AWS may emit a `contentBlockStart` frame before a block's deltas (it always
 * does for tool-use blocks, where `start` carries `toolUse`; text blocks
 * typically start directly with deltas). The union must accept it or the whole
 * stream fails to decode.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ContentBlockStartEvent extends Schema.Class<ContentBlockStartEvent>(
  makeIdentifier("ContentBlockStartEvent")
)({
  contentBlockIndex: IntZeroOrGreater,
  start: Schema.optional(ContentBlockStart)
}) {}

/**
 * The stop event for a streamed message.
 *
 * @category schemas
 * @since 4.0.0
 */
export class MessageStopEvent extends Schema.Class<MessageStopEvent>(
  makeIdentifier("MessageStopEvent")
)({
  stopReason: StopReason
}) {}

/**
 * The trailing metadata event for a Converse stream, carrying usage and metrics.
 *
 * @category schemas
 * @since 4.0.0
 */
export class ConverseStreamMetadataEvent extends Schema.Class<ConverseStreamMetadataEvent>(
  makeIdentifier("ConverseStreamMetadataEvent")
)({
  usage: TokenUsage,
  metrics: Schema.optional(ConverseMetrics)
}) {}

const ExceptionBody = Schema.Struct({
  message: Schema.optional(Schema.String)
})

/**
 * The Converse stream event union.
 *
 * **Details**
 *
 * Each member is keyed by the AWS event-stream `:event-type` wrapper (e.g.
 * `{ messageStart: ... }`). A synthetic `type` discriminator is filled on decode
 * (and omitted on encode) so downstream code can branch on `event.type`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ConverseResponseStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.tagDefaultOmit("messageStart"),
    messageStart: MessageStartEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("contentBlockStart"),
    contentBlockStart: ContentBlockStartEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("contentBlockDelta"),
    contentBlockDelta: ContentBlockDeltaEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("contentBlockStop"),
    contentBlockStop: ContentBlockStopEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("messageStop"),
    messageStop: MessageStopEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("metadata"),
    metadata: ConverseStreamMetadataEvent
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("internalServerException"),
    internalServerException: ExceptionBody
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("modelStreamErrorException"),
    modelStreamErrorException: ExceptionBody
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("serviceUnavailableException"),
    serviceUnavailableException: ExceptionBody
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("throttlingException"),
    throttlingException: ExceptionBody
  }),
  Schema.Struct({
    type: Schema.tagDefaultOmit("validationException"),
    validationException: ExceptionBody
  })
])

/**
 * The type of {@link ConverseResponseStreamEvent}.
 *
 * @category schemas
 * @since 4.0.0
 */
export type ConverseResponseStreamEvent = typeof ConverseResponseStreamEvent.Type
