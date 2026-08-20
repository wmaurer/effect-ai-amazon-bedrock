/**
 * The `AmazonBedrockLanguageModel` module maps the Effect AI `LanguageModel`
 * abstraction onto Amazon Bedrock's Converse API.
 *
 * **Scope**
 *
 * Text, tool calling, and tool-result messages are supported in both the
 * streaming and non-streaming paths. Structured output is supported for
 * non-streaming requests via forced tool use, since Converse has no native
 * json_schema mode. Reasoning is surfaced on both paths, and reasoning blocks
 * round-trip into later turns when they carry the Bedrock signature. Image and
 * document file parts are converted into Converse `image` / `document` blocks;
 * a media type Converse does not accept fails loudly with
 * `AiError.InvalidUserInputError` rather than silently dropping content. Prompt
 * caching is opt-in per message or per part via provider options. Citations
 * are opt-in per document, and the citation blocks and deltas Converse returns
 * are surfaced as document source parts.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Stream from "effect/Stream"
import type { Mutable, Simplify } from "effect/Types"
import * as AiError from "effect/unstable/ai/AiError"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import * as IdGenerator from "effect/unstable/ai/IdGenerator"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import * as Tool from "effect/unstable/ai/Tool"
import { AmazonBedrockClient } from "./AmazonBedrockClient.ts"
import type {
  CachePointBlock,
  Citation,
  CitationsConfig,
  ContentBlock,
  ConverseRequest,
  ConverseResponse,
  ConverseResponseStreamEvent,
  DocumentBlock,
  DocumentSource,
  ImageBlock,
  MediaSource,
  Message,
  SystemContentBlock,
  Tool as BedrockTool,
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
// Prompt Caching
// =============================================================================

/**
 * A request to cache everything preceding a message or part.
 *
 * **Details**
 *
 * Converse caches a prefix of the request rather than an individual block, so
 * this becomes a `cachePoint` block appended after the content it covers.
 * Omitting `ttl` leaves the cache lifetime to Bedrock.
 *
 * @category models
 * @since 4.0.0
 */
export type CachePoint = typeof CachePointBlock.Encoded

/**
 * Marks a tool as the end of the cacheable prefix of the tool list.
 *
 * **Details**
 *
 * Converse caches everything preceding a cache point, so annotating a tool
 * caches that tool and every tool declared before it. Annotate the last tool to
 * cache the whole list, or the last stable one and declare volatile tools after
 * it. Omitting `ttl` leaves the cache lifetime to Bedrock. Bedrock also limits
 * how many cache checkpoints a single request may carry across `system`,
 * `messages`, and `tools` combined, so annotate the tool at the end of the
 * cacheable prefix rather than every tool in the toolkit.
 *
 * **Example**
 *
 * ```ts
 * import { AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
 * import { Schema } from "effect"
 * import { Tool } from "effect/unstable/ai"
 *
 * const search = Tool.make("search", {
 *   parameters: Schema.Struct({ query: Schema.String })
 * }).annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
 * ```
 *
 * @category services
 * @since 4.0.0
 */
export const ToolCachePoint = Context.Reference<CachePoint | undefined>(
  "@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel/ToolCachePoint",
  { defaultValue: () => undefined }
)

/**
 * Reads the cache point a tool requests, if any.
 */
const getToolCachePoint = (tool: Tool.Any): CachePoint | undefined => Context.get(tool.annotations, ToolCachePoint)

/**
 * The provider options through which a cache point is requested.
 */
interface CachePointOptions {
  readonly amazonBedrock?: {
    /**
     * Marks the end of the reusable prefix of the request. The cache point is
     * emitted after the content this is attached to.
     */
    readonly cachePoint?: CachePoint | null
  } | null
}

declare module "effect/unstable/ai/Prompt" {
  /**
   * Amazon Bedrock options for system messages.
   *
   * @category models
   * @since 4.0.0
   */
  export interface SystemMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for user messages.
   *
   * @category models
   * @since 4.0.0
   */
  export interface UserMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for assistant messages.
   *
   * @category models
   * @since 4.0.0
   */
  export interface AssistantMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool messages.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ToolMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for text prompt parts.
   *
   * @category models
   * @since 4.0.0
   */
  export interface TextPartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool call prompt parts.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ToolCallPartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool result prompt parts.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ToolResultPartOptions extends CachePointOptions {}
}

/**
 * Reads the cache point a message or part requests, if any.
 */
const getCachePoint = (carrier: { readonly options: CachePointOptions }): CachePoint | null =>
  carrier.options.amazonBedrock?.cachePoint ?? null

/**
 * Appends the cache point a message or part requests, if any, after the blocks
 * already emitted for it.
 */
const pushCachePoint = (
  content: Array<typeof ContentBlock.Encoded>,
  carrier: { readonly options: CachePointOptions }
): void => {
  const cachePoint = getCachePoint(carrier)
  if (Predicate.isNotNull(cachePoint)) {
    content.push({ cachePoint })
  }
}

// =============================================================================
// Citations
// =============================================================================

/**
 * Requests that a document be citable.
 *
 * @category models
 * @since 4.0.0
 */
export type Citations = typeof CitationsConfig.Encoded

/**
 * The provider options carried by a file prompt part.
 *
 * **Details**
 *
 * File parts are the only prompt parts that map onto a document block, so they
 * carry the cache point every part accepts plus the two document-level knobs:
 * the citations config and the interpretation context.
 */
interface FileOptions {
  readonly amazonBedrock?: {
    /**
     * Marks the end of the reusable prefix of the request. The cache point is
     * emitted after the block this is attached to.
     */
    readonly cachePoint?: CachePoint | null
    /**
     * Guidance the model reads when interpreting the document, such as what
     * the document is or which parts of it matter. Sent whenever it is set,
     * independently of `citations`. Ignored for image file parts, which do not
     * become document blocks.
     */
    readonly context?: string | null
    /**
     * Opts the document into citations. Ignored for image file parts, which
     * Converse cannot cite.
     */
    readonly citations?: Citations | null
  } | null
}

declare module "effect/unstable/ai/Prompt" {
  /**
   * Amazon Bedrock options for file prompt parts.
   *
   * @category models
   * @since 4.0.0
   */
  export interface FilePartOptions extends FileOptions {}
}

declare module "effect/unstable/ai/Response" {
  /**
   * Amazon Bedrock metadata for a document citation.
   *
   * **Details**
   *
   * `location` names the unit `start` and `end` are counted in, and
   * `citedText` is the source text Converse reported for the cited span.
   *
   * @category models
   * @since 4.0.0
   */
  export interface DocumentSourcePartMetadata extends ProviderMetadata {
    readonly amazonBedrock?: {
      readonly location: "documentChar" | "documentPage" | "documentChunk"
      readonly citedText: string
      readonly start: number | null
      readonly end: number | null
      readonly source: string | null
    } | null
  }
}

/**
 * A document sent in the request.
 *
 * **Details**
 *
 * Citation locations carry a `documentIndex` into the documents of the request
 * in the order they were sent, so the list is built while encoding the prompt
 * and used to resolve the cited document.
 */
interface CitedDocument {
  readonly name: string
  readonly mediaType: string
  readonly fileName: string | undefined
}

/** The `CitationLocation` members this provider models, in the order tried. */
const citationLocations = ["documentChar", "documentPage", "documentChunk"] as const

/**
 * Converts a citation into a document source part.
 *
 * **Details**
 *
 * Returns `undefined` for a citation that cannot be attributed to a document
 * this request sent: `web` and `searchResultLocation` citations accompany
 * search results the provider cannot send, and an out-of-range `documentIndex`
 * has no document to name. Both are dropped rather than reported against the
 * wrong file. `CitationsDelta` repeats the fields of `Citation`, so the
 * streaming path shares this conversion.
 */
const citationSource: (
  citation: typeof Citation.Encoded,
  documents: ReadonlyArray<CitedDocument>,
  idGenerator: IdGenerator.Service
) => Effect.Effect<
  Response.DocumentSourcePartEncoded | undefined
> = Effect.fnUntraced(function*(citation, documents, idGenerator) {
  const location = citation.location
  if (Predicate.isUndefined(location)) {
    return undefined
  }
  for (const kind of citationLocations) {
    const span = location[kind]
    if (Predicate.isUndefined(span)) {
      continue
    }
    const document = Predicate.isUndefined(span.documentIndex) ? undefined : documents[span.documentIndex]
    if (Predicate.isUndefined(document)) {
      return undefined
    }
    const id = yield* idGenerator.generateId()
    return {
      type: "source",
      sourceType: "document",
      id,
      mediaType: document.mediaType,
      // The document block name is the only title Converse was given, so it is
      // the fallback when the citation does not repeat one.
      title: citation.title ?? document.name,
      ...(Predicate.isUndefined(document.fileName) ? {} : { fileName: document.fileName }),
      metadata: {
        amazonBedrock: {
          location: kind,
          citedText: (citation.sourceContent ?? []).map((content) => content.text ?? "").join(""),
          start: span.start ?? null,
          end: span.end ?? null,
          source: citation.source ?? null
        }
      }
    }
  }
  return undefined
})

// =============================================================================
// Reasoning
// =============================================================================

/**
 * The Bedrock-side identity of a reasoning block.
 *
 * **Details**
 *
 * Converse returns reasoning either as text plus a `signature` that proves the
 * model produced it, or as an opaque `redactedContent` blob (base64) when the
 * provider's safety systems encrypted it. Either way the payload must be echoed
 * back unmodified for the block to be accepted in a later turn, so it is
 * carried on the part's provider metadata rather than reconstructed.
 *
 * @category models
 * @since 4.0.0
 */
export type ReasoningInfo = {
  readonly type: "reasoningText"
  /**
   * A token verifying that the reasoning text was generated by the model, or
   * `null` when the model did not supply one.
   */
  readonly signature: string | null
} | {
  readonly type: "redactedContent"
  /**
   * Reasoning encrypted by the model provider, as the base64 string Bedrock
   * uses to carry the underlying blob over JSON.
   */
  readonly redactedContent: string
}

declare module "effect/unstable/ai/Prompt" {
  /**
   * Amazon Bedrock options for reasoning prompt parts.
   *
   * **Details**
   *
   * Preserves the Bedrock reasoning payload so the block can be sent back in a
   * later turn. A reasoning part without these options is dropped rather than
   * sent, since Bedrock rejects a reasoning block it cannot verify.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningPartOptions extends ProviderOptions {
    readonly amazonBedrock?: {
      readonly info?: ReasoningInfo | null
    } | null
  }
}

declare module "effect/unstable/ai/Response" {
  /**
   * Amazon Bedrock metadata attached to completed reasoning parts.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningPartMetadata extends ProviderMetadata {
    readonly amazonBedrock?: {
      readonly info?: ReasoningInfo | null
    } | null
  }

  /**
   * Amazon Bedrock metadata attached to streaming reasoning deltas.
   *
   * **Details**
   *
   * Converse streams the signature (or the redacted payload) as its own delta
   * after the reasoning text, so it arrives as metadata on a delta with no
   * text of its own.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningDeltaPartMetadata extends ProviderMetadata {
    readonly amazonBedrock?: {
      readonly info?: ReasoningInfo | null
    } | null
  }
}

/**
 * Builds the provider metadata carrying a reasoning block's Bedrock identity.
 */
const reasoningMetadata = (info: ReasoningInfo) => ({ amazonBedrock: { info } })

/**
 * Reads a `reasoningText` block's Bedrock identity.
 */
const reasoningTextInfo = (signature: string | undefined): ReasoningInfo => ({
  type: "reasoningText",
  signature: signature ?? null
})

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
      readonly documents: ReadonlyArray<CitedDocument>
    }, AiError.AiError> {
      const services = yield* Effect.context<never>()
      const config = { modelId: model, ...providerConfig, ...services.mapUnsafe.get(Config.key) }
      const { documents, messages, system } = yield* prepareMessages(options)
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
      return { request, nameMapper, documents }
    }
  )

  return yield* LanguageModel.make({
    codecTransformer: toCodecAnthropic,
    generateText: Effect.fnUntraced(function*(options) {
      const { documents, nameMapper, request } = yield* makeRequest(options)
      const rawResponse = yield* client.converse({ payload: request })
      return yield* makeResponse(request, rawResponse, options, nameMapper, documents)
    }),
    streamText: Effect.fnUntraced(function*(options) {
      const { documents, nameMapper, request } = yield* makeRequest(options)
      const stream = client.converseStream({ payload: request })
      return yield* makeStreamResponse(request, stream, nameMapper, documents)
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

/**
 * Converse takes a format enum rather than a media type, so only the media
 * types it has a format for can be sent. `image/*` is resolved to jpeg, which
 * mirrors the other providers in this repo.
 */
const imageFormats: Record<string, typeof ImageBlock.Encoded["format"]> = {
  "image/*": "jpeg",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp"
}

const documentFormats: Record<string, typeof DocumentBlock.Encoded["format"]> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md"
}

/** Matches any absolute url, so a non-s3 one is rejected instead of being treated as base64 data. */
const urlPattern = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Resolves file part data into a Converse media source.
 *
 * **Details**
 *
 * String data is already base64 per `Prompt.FilePart`, so it is passed through
 * untouched. The only remote source Converse accepts is an S3 location.
 */
const fileSource: (
  data: typeof Prompt.FilePart.Type["data"]
) => Effect.Effect<typeof MediaSource.Encoded, AiError.AiError> = Effect.fnUntraced(function*(data) {
  if (data instanceof URL || (typeof data === "string" && urlPattern.test(data))) {
    const url = data instanceof URL ? data : new URL(data)
    if (url.protocol !== "s3:") {
      return yield* AiError.make({
        module: "AmazonBedrockLanguageModel",
        method: "prepareMessages",
        reason: new AiError.InvalidUserInputError({
          description: `Unsupported file url '${url.toString()}' - this provider only accepts s3:// locations`
        })
      })
    }
    return { s3Location: { uri: url.toString() } }
  }
  return { bytes: typeof data === "string" ? data : Encoding.encodeBase64(data) }
})

/**
 * Resolves file part data into a Converse document source.
 *
 * **Details**
 *
 * A textual document travels as `text` rather than base64 `bytes`: base64
 * inflates the payload by about a third, and Converse accepts the plain
 * string. That applies only to inline data - an s3 location stays a reference,
 * and a binary format like pdf stays base64. `Prompt.FilePart` string data is
 * base64, so it is decoded rather than forwarded; invalid base64 fails here
 * instead of drawing an opaque 400 from Bedrock. Decoding assumes UTF-8; text
 * with a different encoding becomes U+FFFD replacement characters rather than
 * an error.
 */
const documentSource: (
  mediaType: string,
  name: string,
  data: typeof Prompt.FilePart.Type["data"]
) => Effect.Effect<typeof DocumentSource.Encoded, AiError.AiError> = Effect.fnUntraced(
  function*(mediaType, name, data) {
    const source = yield* fileSource(data)
    // `bytes` is undefined for an s3 location, which stays a reference.
    if (!mediaType.startsWith("text/") || Predicate.isUndefined(source.bytes)) {
      return source
    }
    if (data instanceof Uint8Array) {
      return { text: new TextDecoder().decode(data) }
    }
    const decoded = Encoding.decodeBase64String(data as string)
    if (Result.isFailure(decoded)) {
      return yield* AiError.make({
        module: "AmazonBedrockLanguageModel",
        method: "prepareMessages",
        reason: new AiError.InvalidUserInputError({
          description:
            `Invalid base64 data for document '${name}' of media type '${mediaType}' - string file part data must be base64`
        })
      })
    }
    return { text: decoded.success }
  }
)

/**
 * Bedrock only accepts alphanumerics, single runs of whitespace, hyphens,
 * parentheses and square brackets in a document name, so anything else is
 * folded into a space. The file extension is dropped because the format is
 * already carried separately.
 */
const documentName = (fileName: string | undefined, position: number): string => {
  if (Predicate.isNotUndefined(fileName)) {
    const name = fileName.replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9\s\-()[\]]/g, " ").replace(/\s+/g, " ").trim()
    if (name.length > 0) {
      return name
    }
  }
  return `document ${position}`
}

const prepareMessages: (options: LanguageModel.ProviderOptions) => Effect.Effect<{
  readonly system: ReadonlyArray<typeof SystemContentBlock.Encoded>
  readonly messages: ReadonlyArray<typeof Message.Encoded>
  readonly documents: ReadonlyArray<CitedDocument>
}, AiError.AiError> = Effect.fnUntraced(
  function*(options) {
    const groups = groupMessages(options.prompt)

    const system: Array<typeof SystemContentBlock.Encoded> = []
    const messages: Array<typeof Message.Encoded> = []
    // Document names must be present and distinct within a request, so unnamed
    // documents are numbered across the whole conversation. The documents are
    // also collected in order, because citations index into them.
    const documents: Array<CitedDocument> = []

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
            const cachePoint = getCachePoint(message)
            if (Predicate.isNotNull(cachePoint)) {
              system.push({ cachePoint })
            }
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
                    pushCachePoint(content, part)
                  } else if (part.type === "file") {
                    const imageFormat = imageFormats[part.mediaType]
                    if (Predicate.isNotUndefined(imageFormat)) {
                      content.push({ image: { format: imageFormat, source: yield* fileSource(part.data) } })
                      pushCachePoint(content, part)
                      continue
                    }
                    const documentFormat = documentFormats[part.mediaType]
                    if (Predicate.isNotUndefined(documentFormat)) {
                      const name = documentName(part.fileName, documents.length + 1)
                      const context = part.options.amazonBedrock?.context
                      const citations = part.options.amazonBedrock?.citations
                      documents.push({ name, mediaType: part.mediaType, fileName: part.fileName })
                      content.push({
                        document: {
                          format: documentFormat,
                          name,
                          source: yield* documentSource(part.mediaType, name, part.data),
                          ...(Predicate.isNullish(context) ? {} : { context }),
                          ...(Predicate.isNullish(citations) ? {} : { citations })
                        }
                      })
                      pushCachePoint(content, part)
                      continue
                    }
                    return yield* AiError.make({
                      module: "AmazonBedrockLanguageModel",
                      method: "prepareMessages",
                      reason: new AiError.InvalidUserInputError({
                        description:
                          `Unsupported media type '${part.mediaType}' for file part - this provider supports images and documents Converse has a format for`
                      })
                    })
                  } else {
                    // `UserMessagePart` is text | file today, so `part` is
                    // `never` here; the branch keeps a part type added later
                    // from being dropped silently.
                    const unhandled: { readonly type: string } = part
                    return yield* AiError.make({
                      module: "AmazonBedrockLanguageModel",
                      method: "prepareMessages",
                      reason: new AiError.InvalidUserInputError({
                        description:
                          `Unsupported user content part of type '${unhandled.type}' - this provider supports text and file parts`
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
                  pushCachePoint(content, part)
                }
                break
              }
            }
            pushCachePoint(content, message)
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
                pushCachePoint(content, part)
              } else if (part.type === "reasoning") {
                // Bedrock verifies the payload that accompanies a reasoning
                // block, so a reasoning part that did not come from this
                // provider carries nothing it would accept and is dropped
                // rather than sent and rejected.
                const info = part.options.amazonBedrock?.info
                if (Predicate.isNullish(info)) {
                  continue
                }
                content.push({
                  reasoningContent: info.type === "reasoningText"
                    ? {
                      reasoningText: {
                        text: part.text,
                        ...(Predicate.isNull(info.signature) ? {} : { signature: info.signature })
                      }
                    }
                    : { redactedContent: info.redactedContent }
                })
              } else if (part.type === "tool-call") {
                content.push({
                  toolUse: {
                    toolUseId: part.id,
                    name: part.name,
                    input: part.params
                  }
                })
                pushCachePoint(content, part)
              } else {
                return yield* AiError.make({
                  module: "AmazonBedrockLanguageModel",
                  method: "prepareMessages",
                  reason: new AiError.InvalidUserInputError({
                    description:
                      `Unsupported assistant content part of type '${part.type}' - this provider supports text, reasoning, and tool calls`
                  })
                })
              }
            }
            pushCachePoint(content, message)
          }

          messages.push({ role: "assistant", content })
          break
        }
      }
    }

    return { system, messages, documents }
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

  const entries: Array<{
    readonly toolSpec: NonNullable<(typeof BedrockTool.Encoded)["toolSpec"]>
    readonly cachePoint: CachePoint | undefined
  }> = []
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
    entries.push({
      toolSpec: {
        name: tool.name,
        ...(Predicate.isNotUndefined(description) ? { description } : undefined),
        inputSchema: { json: json as Record<string, unknown> }
      },
      cachePoint: getToolCachePoint(tool)
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
    // `generateText` and `streamText` in `effect/unstable/ai/LanguageModel`
    // already filter the toolkit by `toolChoice.oneOf` before a provider sees
    // it, so on that path this is a no-op. It's defence for `prepareTools`'
    // own contract: it keeps each tool's cache point with the tool it
    // follows.
    const allowed = new Set(choice.oneOf)
    const filtered = entries.filter((e) => allowed.has(e.toolSpec.name))
    entries.length = 0
    entries.push(...filtered)
    toolChoice = choice.mode === "required" ? { any: {} } : { auto: {} }
  }

  // Converse models the tool list as a union of `toolSpec` and `cachePoint`
  // entries, and caches everything preceding a cache point, so a tool's cache
  // point is emitted as its own entry directly after it.
  const tools: Array<typeof BedrockTool.Encoded> = []
  for (const entry of entries) {
    tools.push({ toolSpec: entry.toolSpec })
    if (Predicate.isNotUndefined(entry.cachePoint)) {
      tools.push({ cachePoint: entry.cachePoint })
    }
  }

  // Bedrock's Converse API rejects an empty `tools` array alongside a
  // `toolChoice`, and a lone cache point covers nothing, so when tool selection
  // filters every tool out (e.g. an `oneOf` that matches no tools) we omit
  // `toolConfig` entirely.
  const toolConfig: typeof ToolConfiguration.Encoded | undefined = entries.length > 0
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
  nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>>,
  documents: ReadonlyArray<CitedDocument>
) => Effect.Effect<
  Array<Response.PartEncoded>,
  never,
  IdGenerator.IdGenerator
> = Effect.fnUntraced(function*(request, response, options, nameMapper, documents) {
  const idGenerator = yield* IdGenerator.IdGenerator
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
    } else if (Predicate.isNotUndefined(part.reasoningContent)) {
      const reasoningText = part.reasoningContent.reasoningText
      if (Predicate.isNotUndefined(reasoningText)) {
        parts.push({
          type: "reasoning",
          text: reasoningText.text,
          metadata: reasoningMetadata(reasoningTextInfo(reasoningText.signature))
        })
      } else if (Predicate.isNotUndefined(part.reasoningContent.redactedContent)) {
        // Redacted reasoning has no readable text; the encrypted payload rides
        // along in the metadata so the block can be sent back later.
        parts.push({
          type: "reasoning",
          text: "",
          metadata: reasoningMetadata({
            type: "redactedContent",
            redactedContent: part.reasoningContent.redactedContent
          })
        })
      }
    } else if (Predicate.isNotUndefined(part.citationsContent)) {
      // Once a document has citations enabled the answer text arrives inside
      // this block instead of a plain `text` block, so it is emitted here too.
      if (options.responseFormat.type === "text") {
        for (const generated of part.citationsContent.content ?? []) {
          if (Predicate.isNotUndefined(generated.text)) {
            parts.push({ type: "text", text: generated.text })
          }
        }
      }
      for (const citation of part.citationsContent.citations ?? []) {
        const source = yield* citationSource(citation, documents, idGenerator)
        if (Predicate.isNotUndefined(source)) {
          parts.push(source)
        }
      }
    }
    // Blocks this provider does not model (`audio`, `searchResult`, ...) decode
    // with every field undefined and are ignored.
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
  stream: Stream.Stream<ConverseResponseStreamEvent, AiError.AiError>,
  nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>>,
  documents: ReadonlyArray<CitedDocument>
) => Effect.Effect<
  Stream.Stream<Response.StreamPartEncoded, AiError.AiError>,
  never,
  IdGenerator.IdGenerator
> = Effect.fnUntraced(
  function*(request, stream, nameMapper, documents) {
    // Acquired up front: the stream itself must not carry the requirement.
    const idGenerator = yield* IdGenerator.IdGenerator

    // Tracks whether a text block at a given content-block index has been
    // started (text blocks are lazily started on first delta).
    const startedBlocks = new Set<number>()

    // Tracks whether a reasoning block at a given content-block index has been
    // started. Like text, reasoning has no `contentBlockStart` event and is
    // started lazily on its first delta.
    const startedReasoningBlocks = new Set<number>()

    // Tool-use blocks in flight, keyed by content-block index. Bedrock streams
    // tool arguments as partial JSON, so the fragments are accumulated here and
    // parsed once the block stops.
    const toolBlocks = new Map<number, { readonly id: string; readonly name: string; params: string }>()

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
            // directly with deltas, so `text-start` is synthesized on the first
            // text delta instead.
            const start = event.contentBlockStart.start?.toolUse
            if (Predicate.isUndefined(start)) {
              break
            }
            const name = nameMapper.getCustomName(start.name)
            toolBlocks.set(event.contentBlockStart.contentBlockIndex, {
              id: start.toolUseId,
              name,
              params: ""
            })
            parts.push({
              type: "tool-params-start",
              id: start.toolUseId,
              name
            })
            break
          }

          case "contentBlockDelta": {
            const index = event.contentBlockDelta.contentBlockIndex
            const toolUse = event.contentBlockDelta.delta.toolUse
            if (Predicate.isNotUndefined(toolUse)) {
              const block = toolBlocks.get(index)
              // A toolUse delta without a preceding `contentBlockStart` has no
              // call id to attribute it to, so it is dropped.
              if (Predicate.isNotUndefined(block)) {
                block.params += toolUse.input
                parts.push({
                  type: "tool-params-delta",
                  id: block.id,
                  delta: toolUse.input
                })
              }
              break
            }
            const reasoning = event.contentBlockDelta.delta.reasoningContent
            if (Predicate.isNotUndefined(reasoning)) {
              // Converse splits a reasoning block across three delta shapes:
              // the text itself, then a trailing signature, or a single
              // redacted payload in place of both. The latter two carry no
              // text, so they ride along as metadata on an empty delta.
              const reasoningDelta: {
                readonly delta: string
                readonly metadata?: Response.ReasoningDeltaPartMetadata
              } | undefined = Predicate.isNotUndefined(reasoning.text)
                ? { delta: reasoning.text }
                : Predicate.isNotUndefined(reasoning.signature)
                ? { delta: "", metadata: reasoningMetadata(reasoningTextInfo(reasoning.signature)) }
                : Predicate.isNotUndefined(reasoning.redactedContent)
                ? {
                  delta: "",
                  metadata: reasoningMetadata({
                    type: "redactedContent",
                    redactedContent: reasoning.redactedContent
                  })
                }
                : undefined
              if (Predicate.isUndefined(reasoningDelta)) {
                break
              }
              if (!startedReasoningBlocks.has(index)) {
                startedReasoningBlocks.add(index)
                parts.push({
                  type: "reasoning-start",
                  id: index.toString()
                })
              }
              parts.push({
                type: "reasoning-delta",
                id: index.toString(),
                ...reasoningDelta
              })
              break
            }
            const citation = event.contentBlockDelta.delta.citation
            if (Predicate.isNotUndefined(citation)) {
              const source = yield* citationSource(citation, documents, idGenerator)
              // A citation that cannot be attributed to a document of this
              // request emits nothing; see `citationSource`.
              if (Predicate.isNotUndefined(source)) {
                parts.push(source)
              }
              break
            }
            // Deltas this provider does not model (image, ...) decode with
            // every key undefined and are skipped.
            const text = event.contentBlockDelta.delta.text
            if (Predicate.isUndefined(text)) {
              break
            }
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
            if (startedReasoningBlocks.has(index)) {
              startedReasoningBlocks.delete(index)
              parts.push({
                type: "reasoning-end",
                id: index.toString()
              })
            }
            const block = toolBlocks.get(index)
            if (Predicate.isNotUndefined(block)) {
              toolBlocks.delete(index)
              parts.push({
                type: "tool-params-end",
                id: block.id
              })
              parts.push({
                type: "tool-call",
                id: block.id,
                name: block.name,
                // A tool taking no arguments streams no deltas at all.
                params: Tool.unsafeSecureJsonParse(block.params.length === 0 ? "{}" : block.params),
                providerExecuted: false
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
