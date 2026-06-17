/**
 * The `AmazonBedrockLanguageModel` module maps the Effect AI `LanguageModel`
 * abstraction onto Amazon Bedrock's Converse API.
 *
 * **Scope**
 *
 * Non-streaming requests support text, tool calling, tool-result messages, and
 * structured output (the latter via forced tool use, since Converse has no
 * native json_schema mode). Streaming is text-only. Images, documents, and
 * reasoning are not supported yet — requests that use them fail loudly with
 * `AiError.InvalidUserInputError` rather than silently dropping content.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Stream from "effect/Stream"
import type { Mutable, Simplify } from "effect/Types"
import * as AiError from "effect/unstable/ai/AiError"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import type * as IdGenerator from "effect/unstable/ai/IdGenerator"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import * as Tool from "effect/unstable/ai/Tool"
import { AmazonBedrockClient } from "./AmazonBedrockClient.ts"
import type {
  ContentBlock,
  ConverseRequest,
  ConverseResponse,
  ConverseResponseStreamEvent,
  Message,
  SystemContentBlock,
  ToolChoice,
  ToolConfiguration
} from "./AmazonBedrockSchema.ts"
import * as InternalUtilities from "./internal/utilities.ts"

/**
 * A Bedrock model identifier or cross-region inference profile id (e.g.
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0`).
 *
 * @category models
 * @since 4.0.0
 */
export type Model = string & {}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Per-request configuration for the Amazon Bedrock language model.
 *
 * @category configuration
 * @since 4.0.0
 */
export class Config extends Context.Service<
  Config,
  Simplify<
    Partial<
      Omit<
        typeof ConverseRequest.Encoded,
        "messages" | "system"
      >
    >
  >
>()("@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel/Config") {}

// =============================================================================
// Language Model
// =============================================================================

/**
 * Creates an Amazon Bedrock model descriptor that can be provided with
 * `Effect.provide`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const model = (
  model: (string & {}) | Model,
  config?: Omit<typeof Config.Service, "modelId">
): AiModel.Model<"amazon-bedrock", LanguageModel.LanguageModel, AmazonBedrockClient> =>
  AiModel.make("amazon-bedrock", model, layer({ model, config }))

/**
 * Creates an Amazon Bedrock `LanguageModel` service from a model identifier and
 * optional request defaults.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*({ config: providerConfig, model }: {
  readonly model: (string & {}) | Model
  readonly config?: Omit<typeof Config.Service, "modelId"> | undefined
}): Effect.fn.Return<LanguageModel.Service, never, AmazonBedrockClient> {
  const client = yield* AmazonBedrockClient

  const makeRequest = Effect.fnUntraced(
    function*(
      options: LanguageModel.ProviderOptions
    ): Effect.fn.Return<{
      readonly request: typeof ConverseRequest.Encoded
      readonly nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>>
    }, AiError.AiError> {
      const services = yield* Effect.context<never>()
      const config = { modelId: model, ...providerConfig, ...services.mapUnsafe.get(Config.key) }
      const { messages, system } = yield* prepareMessages(options)
      const { nameMapper, toolConfig } = yield* prepareTools(options)
      const responseFormat = options.responseFormat

      let jsonToolConfig: typeof ToolConfiguration.Encoded | undefined = undefined
      if (responseFormat.type === "json") {
        const json = yield* tryJsonSchema(responseFormat.schema, "makeRequest")
        jsonToolConfig = {
          tools: [{
            toolSpec: {
              name: responseFormat.objectName,
              description: SchemaAST.resolveDescription(responseFormat.schema.ast) ?? "Respond with a JSON object",
              inputSchema: { json: json as Record<string, unknown> }
            }
          }],
          toolChoice: { tool: { name: responseFormat.objectName } }
        }
      }

      const request: typeof ConverseRequest.Encoded = {
        ...config,
        modelId: config.modelId!,
        system,
        messages,
        ...(Predicate.isNotUndefined(jsonToolConfig)
          ? { toolConfig: jsonToolConfig }
          : Predicate.isNotUndefined(toolConfig)
          ? { toolConfig }
          : {})
      }
      return { request, nameMapper }
    }
  )

  return yield* LanguageModel.make({
    codecTransformer: toCodecAnthropic,
    generateText: Effect.fnUntraced(function*(options) {
      const { nameMapper, request } = yield* makeRequest(options)
      const rawResponse = yield* client.converse({ payload: request })
      return yield* makeResponse(request, rawResponse, options, nameMapper)
    }),
    streamText: Effect.fnUntraced(function*(options) {
      if (options.tools.length > 0 || options.responseFormat.type !== "text") {
        return yield* AiError.make({
          module: "AmazonBedrockLanguageModel",
          method: "streamText",
          reason: new AiError.InvalidUserInputError({
            description: "Streaming tool calls and structured output are not supported yet; use generateText"
          })
        })
      }
      const request = (yield* makeRequest(options)).request
      const stream = client.converseStream({ payload: request })
      return yield* makeStreamResponse(request, stream)
    }, (effect, _options) => effect.pipe(Stream.unwrap))
  })
})

/**
 * Creates a layer for the Amazon Bedrock language model.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly model: (string & {}) | Model
  readonly config?: Omit<typeof Config.Service, "modelId"> | undefined
}): Layer.Layer<LanguageModel.LanguageModel, never, AmazonBedrockClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))

/**
 * Provides config overrides for Amazon Bedrock language model operations.
 *
 * @category configuration
 * @since 4.0.0
 */
export const withConfigOverride: {
  (overrides: typeof Config.Service): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service): Effect.Effect<A, E, Exclude<R, Config>>
} = dual<
  (
    overrides: typeof Config.Service
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>,
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service) => Effect.Effect<A, E, Exclude<R, Config>>
>(2, (self, overrides) =>
  Effect.flatMap(
    Effect.serviceOption(Config),
    (config) =>
      Effect.provideService(self, Config, {
        ...(config._tag === "Some" ? config.value : {}),
        ...overrides
      })
  ))

// =============================================================================
// Prompt Conversion
// =============================================================================

const prepareMessages: (options: LanguageModel.ProviderOptions) => Effect.Effect<{
  readonly system: ReadonlyArray<typeof SystemContentBlock.Encoded>
  readonly messages: ReadonlyArray<typeof Message.Encoded>
}, AiError.AiError> = Effect.fnUntraced(
  function*(options) {
    const groups = groupMessages(options.prompt)

    const system: Array<typeof SystemContentBlock.Encoded> = []
    const messages: Array<typeof Message.Encoded> = []

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!
      const isLastGroup = i === groups.length - 1

      switch (group.type) {
        case "system": {
          if (messages.length > 0) {
            return yield* AiError.make({
              module: "AmazonBedrockLanguageModel",
              method: "prepareMessages",
              reason: new AiError.InvalidUserInputError({
                description: "Multiple system messages separated by user / assistant messages"
              })
            })
          }
          for (const message of group.messages) {
            system.push({ text: message.content })
          }
          break
        }

        case "user": {
          const content: Array<typeof ContentBlock.Encoded> = []

          for (const message of group.messages) {
            switch (message.role) {
              case "user": {
                for (const part of message.content) {
                  if (part.type === "text") {
                    content.push({ text: part.text })
                  } else {
                    return yield* AiError.make({
                      module: "AmazonBedrockLanguageModel",
                      method: "prepareMessages",
                      reason: new AiError.InvalidUserInputError({
                        description: `Unsupported user content part of type '${part.type}' - this provider is text-only`
                      })
                    })
                  }
                }
                break
              }

              case "tool": {
                for (const part of message.content) {
                  // Only tool-result parts map to Converse blocks; other tool
                  // message parts (e.g. tool-approval responses) are skipped.
                  if (part.type !== "tool-result") continue
                  content.push({
                    toolResult: {
                      toolUseId: part.id,
                      // Serialize the result with JSON.stringify to mirror the
                      // Anthropic provider's tool-result handling, so object
                      // results round-trip consistently across providers. (A
                      // string result is therefore JSON-quoted, matching that
                      // provider's behavior.)
                      content: [{ text: JSON.stringify(part.result) }]
                    }
                  })
                }
                break
              }
            }
          }

          messages.push({ role: "user", content })
          break
        }

        case "assistant": {
          const content: Array<typeof ContentBlock.Encoded> = []

          for (let j = 0; j < group.messages.length; j++) {
            const message = group.messages[j]!
            const isLastMessage = j === group.messages.length - 1

            for (let k = 0; k < message.content.length; k++) {
              const part = message.content[k]!
              const isLastPart = k === message.content.length - 1

              if (part.type === "text") {
                // Skip empty text blocks
                if (part.text.trim().length === 0) {
                  continue
                }
                content.push({
                  // Amazon Bedrock does not allow trailing whitespace in
                  // assistant content blocks
                  text: trimIfLast(isLastGroup, isLastMessage, isLastPart, part.text)
                })
              } else if (part.type === "tool-call") {
                content.push({
                  toolUse: {
                    toolUseId: part.id,
                    name: part.name,
                    input: part.params
                  }
                })
              } else {
                return yield* AiError.make({
                  module: "AmazonBedrockLanguageModel",
                  method: "prepareMessages",
                  reason: new AiError.InvalidUserInputError({
                    description:
                      `Unsupported assistant content part of type '${part.type}' - this provider is text-only`
                  })
                })
              }
            }
          }

          messages.push({ role: "assistant", content })
          break
        }
      }
    }

    return { system, messages }
  }
)

// =============================================================================
// Schema Helpers
// =============================================================================

const unsupportedSchemaError = (error: unknown, method: string): AiError.AiError =>
  AiError.make({
    module: "AmazonBedrockLanguageModel",
    method,
    reason: new AiError.UnsupportedSchemaError({
      description: error instanceof Error ? error.message : String(error)
    })
  })

const tryToolJsonSchema = (tool: Tool.Any, method: string) =>
  Effect.try({
    try: () => Tool.getJsonSchema(tool, { transformer: toCodecAnthropic }),
    catch: (error) => unsupportedSchemaError(error, method)
  })

const tryJsonSchema = (schema: Schema.Top, method: string) =>
  Effect.try({
    try: () => Tool.getJsonSchemaFromSchema(schema, { transformer: toCodecAnthropic }),
    catch: (error) => unsupportedSchemaError(error, method)
  })

// =============================================================================
// Tool Conversion
// =============================================================================

const prepareTools: (
  options: LanguageModel.ProviderOptions
) => Effect.Effect<{
  readonly toolConfig: typeof ToolConfiguration.Encoded | undefined
  readonly nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>>
}, AiError.AiError> = Effect.fnUntraced(function*(options) {
  const nameMapper = new Tool.NameMapper(options.tools)

  if (options.tools.length === 0 || options.toolChoice === "none") {
    return { toolConfig: undefined, nameMapper }
  }

  const tools: Array<(typeof ToolConfiguration.Encoded)["tools"][number]> = []
  for (const tool of options.tools) {
    if (!Tool.isUserDefined(tool)) {
      const toolName = (tool as { name: string }).name
      return yield* AiError.make({
        module: "AmazonBedrockLanguageModel",
        method: "prepareTools",
        reason: new AiError.InvalidUserInputError({
          description: `Unsupported tool '${toolName}' - this provider supports user-defined tools only`
        })
      })
    }
    const description = Tool.getDescription(tool)
    const json = yield* tryToolJsonSchema(tool, "prepareTools")
    tools.push({
      toolSpec: {
        name: tool.name,
        ...(Predicate.isNotUndefined(description) ? { description } : undefined),
        inputSchema: { json: json as Record<string, unknown> }
      }
    })
  }

  let toolChoice: typeof ToolChoice.Encoded | undefined = undefined
  const choice = options.toolChoice
  if (choice === "auto") {
    toolChoice = { auto: {} }
  } else if (choice === "required") {
    toolChoice = { any: {} }
  } else if ("tool" in choice) {
    toolChoice = { tool: { name: choice.tool } }
  } else {
    const allowed = new Set(choice.oneOf)
    const filtered = tools.filter((t) => allowed.has(t.toolSpec.name))
    tools.length = 0
    tools.push(...filtered)
    toolChoice = choice.mode === "required" ? { any: {} } : { auto: {} }
  }

  // Bedrock's Converse API rejects an empty `tools` array alongside a
  // `toolChoice`, so when tool selection filters everything out (e.g. an
  // `oneOf` that matches no tools) we omit `toolConfig` entirely.
  const toolConfig: typeof ToolConfiguration.Encoded | undefined = tools.length > 0
    ? { tools, ...(Predicate.isNotUndefined(toolChoice) ? { toolChoice } : undefined) }
    : undefined

  return { toolConfig, nameMapper }
})

// =============================================================================
// Response Conversion
// =============================================================================

const makeResponse: (
  request: typeof ConverseRequest.Encoded,
  response: ConverseResponse,
  options: LanguageModel.ProviderOptions,
  nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>>
) => Effect.Effect<
  Array<Response.PartEncoded>,
  never,
  IdGenerator.IdGenerator
> = Effect.fnUntraced(function*(request, response, options, nameMapper) {
  const parts: Array<Response.PartEncoded> = []

  parts.push({
    type: "response-metadata",
    // Bedrock's Converse API does not return a response identifier, and the
    // raw HTTP request is not surfaced by the client service. The keys must
    // still be present: `Response.ResponseMetadataPart` models them with
    // `Schema.UndefinedOr`, which requires the key.
    id: undefined,
    modelId: request.modelId,
    timestamp: DateTime.formatIso(yield* DateTime.now),
    request: undefined
  })

  for (const part of response.output.message.content) {
    if (Predicate.isNotUndefined(part.text)) {
      // Suppress plain text while in structured-output mode (the object arrives
      // as a forced tool-use block below).
      if (options.responseFormat.type === "text") {
        parts.push({
          type: "text",
          text: part.text
        })
      }
    } else if (Predicate.isNotUndefined(part.toolUse)) {
      if (options.responseFormat.type === "json") {
        // Structured output: re-emit the tool input as text for the LanguageModel
        // layer to validate against the schema.
        parts.push({
          type: "text",
          text: JSON.stringify(part.toolUse.input)
        })
      } else {
        parts.push({
          type: "tool-call",
          id: part.toolUse.toolUseId,
          name: nameMapper.getCustomName(part.toolUse.name),
          params: part.toolUse.input,
          providerExecuted: false
        })
      }
    }
    // Other non-text blocks (reasoningContent, etc.) decode with these fields
    // undefined and are ignored by this provider.
  }

  const finishReason = InternalUtilities.resolveFinishReason(response.stopReason)
  const cacheReadTokens = response.usage.cacheReadInputTokens ?? 0
  const cacheWriteTokens = response.usage.cacheWriteInputTokens ?? 0

  parts.push({
    type: "finish",
    reason: finishReason,
    usage: {
      inputTokens: {
        uncached: response.usage.inputTokens,
        total: response.usage.inputTokens + cacheReadTokens + cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens
      },
      outputTokens: {
        total: response.usage.outputTokens,
        text: undefined,
        reasoning: undefined
      }
    },
    // `Response.FinishPart` models `response` with `Schema.UndefinedOr`, which
    // requires the key; HTTP response details are not surfaced by the client.
    response: undefined
  })

  return parts
})

const makeStreamResponse: (
  request: typeof ConverseRequest.Encoded,
  stream: Stream.Stream<ConverseResponseStreamEvent, AiError.AiError>
) => Effect.Effect<
  Stream.Stream<Response.StreamPartEncoded, AiError.AiError>,
  never,
  IdGenerator.IdGenerator
> = Effect.fnUntraced(
  function*(request, stream) {
    // Tracks whether a text block at a given content-block index has been
    // started (text blocks are lazily started on first delta).
    const startedBlocks = new Set<number>()

    const usage: Mutable<{
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheWriteInputTokens: number
    }> = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0
    }

    // Captured at `messageStop`; the `finish` part is emitted at `metadata`
    // (which AWS sends AFTER messageStop and which carries the usage), so finish
    // reports the real token counts rather than the pre-metadata zeros.
    let finishReason: Response.FinishReason = "unknown"

    return stream.pipe(
      Stream.mapEffect(Effect.fnUntraced(function*(event) {
        const parts: Array<Response.StreamPartEncoded> = []

        switch (event.type) {
          case "messageStart": {
            parts.push({
              type: "response-metadata",
              // See `makeResponse`: keys are required (`Schema.UndefinedOr`),
              // values are unavailable from the Converse stream.
              id: undefined,
              modelId: request.modelId,
              timestamp: DateTime.formatIso(yield* DateTime.now),
              request: undefined
            })
            break
          }

          case "contentBlockStart": {
            // Tool-use blocks announce themselves here; text blocks start
            // directly with deltas. This text-only provider ignores the event
            // and synthesizes `text-start` on the first text delta instead.
            break
          }

          case "contentBlockDelta": {
            // Non-text deltas (the AWS ContentBlockDelta union: toolUse,
            // reasoningContent, ...) decode with `text` undefined and are
            // skipped by this text-only provider.
            const text = event.contentBlockDelta.delta.text
            if (Predicate.isUndefined(text)) {
              break
            }
            const index = event.contentBlockDelta.contentBlockIndex
            if (!startedBlocks.has(index)) {
              startedBlocks.add(index)
              parts.push({
                type: "text-start",
                id: index.toString()
              })
            }
            parts.push({
              type: "text-delta",
              id: index.toString(),
              delta: text
            })
            break
          }

          case "contentBlockStop": {
            const index = event.contentBlockStop.contentBlockIndex
            if (startedBlocks.has(index)) {
              startedBlocks.delete(index)
              parts.push({
                type: "text-end",
                id: index.toString()
              })
            }
            break
          }

          case "messageStop": {
            // Defer the `finish` part to the trailing `metadata` event (usage
            // is still zero here — metadata has not arrived yet).
            finishReason = InternalUtilities.resolveFinishReason(event.messageStop.stopReason)
            break
          }

          case "metadata": {
            usage.inputTokens = event.metadata.usage.inputTokens
            usage.outputTokens = event.metadata.usage.outputTokens
            usage.cacheReadInputTokens = event.metadata.usage.cacheReadInputTokens ?? 0
            if (Predicate.isNotUndefined(event.metadata.usage.cacheWriteInputTokens)) {
              usage.cacheWriteInputTokens = event.metadata.usage.cacheWriteInputTokens
            }
            // Terminal success event: usage is now populated — emit `finish`.
            parts.push({
              type: "finish",
              reason: finishReason,
              usage: {
                inputTokens: {
                  uncached: usage.inputTokens,
                  total: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens,
                  cacheRead: usage.cacheReadInputTokens,
                  cacheWrite: usage.cacheWriteInputTokens
                },
                outputTokens: {
                  total: usage.outputTokens,
                  text: undefined,
                  reasoning: undefined
                }
              },
              // See `makeResponse`: the key is required (`Schema.UndefinedOr`).
              response: undefined
            })
            break
          }

          case "internalServerException": {
            parts.push({ type: "error", error: event.internalServerException })
            break
          }

          case "modelStreamErrorException": {
            parts.push({ type: "error", error: event.modelStreamErrorException })
            break
          }

          case "serviceUnavailableException": {
            parts.push({ type: "error", error: event.serviceUnavailableException })
            break
          }

          case "throttlingException": {
            parts.push({ type: "error", error: event.throttlingException })
            break
          }

          case "validationException": {
            parts.push({ type: "error", error: event.validationException })
            break
          }
        }

        return parts
      })),
      Stream.flattenIterable
    )
  }
)

// =============================================================================
// Utilities
// =============================================================================

type ContentGroup = SystemMessageGroup | AssistantMessageGroup | UserMessageGroup

interface SystemMessageGroup {
  readonly type: "system"
  readonly messages: Array<Prompt.SystemMessage>
}

interface AssistantMessageGroup {
  readonly type: "assistant"
  readonly messages: Array<Prompt.AssistantMessage>
}

interface UserMessageGroup {
  readonly type: "user"
  readonly messages: Array<Prompt.ToolMessage | Prompt.UserMessage>
}

const groupMessages = (prompt: Prompt.Prompt): Array<ContentGroup> => {
  const messages: Array<ContentGroup> = []
  let current: ContentGroup | undefined = undefined
  for (const message of prompt.content) {
    switch (message.role) {
      case "system": {
        if (current?.type !== "system") {
          current = { type: "system", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
      case "assistant": {
        if (current?.type !== "assistant") {
          current = { type: "assistant", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
      case "tool":
      case "user": {
        if (current?.type !== "user") {
          current = { type: "user", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
    }
  }
  return messages
}

/**
 * Amazon Bedrock does not allow trailing whitespace in pre-filled assistant
 * responses, so we trim the final text part here if it's the last message in
 * the group.
 */
const trimIfLast = (
  isLastGroup: boolean,
  isLastMessage: boolean,
  isLastPart: boolean,
  text: string
) => isLastGroup && isLastMessage && isLastPart ? text.trim() : text
