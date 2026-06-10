/**
 * The `AmazonBedrockClient` module defines the low-level Effect service used to
 * call Amazon Bedrock's Converse API. It wraps an `HttpClient` with SigV4
 * request signing (via `aws4fetch`), request defaults, response decoding, and
 * error mapping to the unified `AiError` type.
 *
 * **Mental model**
 *
 * `HttpClient.HttpClient` provides the transport. {@link make} turns explicit
 * {@link Options} into an {@link AmazonBedrockClient} service, while
 * {@link layer} and {@link layerConfig} provide that service as a layer. The
 * service exposes handwritten helpers for the `converse` (non-streaming) and
 * `converse-stream` (streaming) endpoints.
 *
 * @since 4.0.0
 */
import { AwsV4Signer } from "aws4fetch"
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AmazonBedrockConfig } from "./AmazonBedrockConfig.ts"
import * as EventStream from "./AmazonBedrockEventStream.ts"
import type { ConverseRequest } from "./AmazonBedrockSchema.ts"
import { ConverseResponse, ConverseResponseStreamEvent } from "./AmazonBedrockSchema.ts"
import * as Errors from "./internal/errors.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Represents the Amazon Bedrock client service with methods for the Converse
 * API, including regular and streaming message creation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * Creates a message using the Bedrock Converse API and maps all errors to the
   * unified `AiError` type.
   */
  readonly converse: (options: {
    readonly payload: typeof ConverseRequest.Encoded
  }) => Effect.Effect<ConverseResponse, AiError.AiError>

  /**
   * Creates a streaming message using the Bedrock `converse-stream` API and maps
   * all errors to the unified `AiError` type.
   */
  readonly converseStream: (options: {
    readonly payload: typeof ConverseRequest.Encoded
  }) => Stream.Stream<ConverseResponseStreamEvent, AiError.AiError>
}

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service tag for the Amazon Bedrock client.
 *
 * @category services
 * @since 4.0.0
 */
export class AmazonBedrockClient extends Context.Service<AmazonBedrockClient, Service>()(
  "@effect/ai-amazon-bedrock/AmazonBedrockClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * Configuration for creating an Amazon Bedrock client.
 *
 * @category options
 * @since 4.0.0
 */
export type Options = {
  /**
   * The base URL for the Bedrock runtime API. Override to use a proxy or a
   * different endpoint.
   *
   * @default `https://bedrock-runtime.${region}.amazonaws.com`
   */
  readonly apiUrl?: string | undefined
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  /**
   * The AWS region.
   *
   * @default "us-east-1"
   */
  readonly region?: string | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

const RedactedAmazonBedrockHeaders = {
  AmzSecurityToken: "X-Amz-Security-Token"
}

/**
 * Creates an Amazon Bedrock client service with the given options.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const region = options.region ?? "us-east-1"

    const baseClient = yield* HttpClient.HttpClient

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`),
          HttpClientRequest.acceptJson
        )
      ),
      HttpClient.mapRequestEffect(Effect.fnUntraced(function*(request) {
        const originalHeaders = request.headers
        const signer = new AwsV4Signer({
          service: "bedrock",
          url: request.url,
          method: request.method,
          headers: Object.entries(originalHeaders),
          body: prepareBody(request.body),
          region,
          accessKeyId: options.accessKeyId,
          secretAccessKey: Redacted.value(options.secretAccessKey),
          ...(options.sessionToken ? { sessionToken: Redacted.value(options.sessionToken) } : {})
        })
        const { headers: signedHeaders } = yield* Effect.promise(() => signer.sign())
        const headers = Headers.merge(originalHeaders, Headers.fromInput(signedHeaders))
        return HttpClientRequest.setHeaders(request, headers)
      })),
      options.transformClient ? options.transformClient : identity
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const withConfigClient = Effect.fnUntraced(function*() {
      const config = yield* AmazonBedrockConfig.getOrUndefined
      return config?.transformClient ? config.transformClient(httpClientOk) : httpClientOk
    })

    const converse: Service["converse"] = ({ payload: { modelId, ...body } }) =>
      Effect.flatMap(withConfigClient(), (client) => {
        const request = HttpClientRequest.post(`/model/${modelId}/converse`, {
          body: HttpBody.jsonUnsafe(body)
        })
        return client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ConverseResponse)),
          Effect.catchTags({
            HttpClientError: (error) => Errors.mapHttpClientError(error, "converse"),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "converse"))
          })
        )
      })

    const converseStream: Service["converseStream"] = ({ payload: { modelId, ...body } }) => {
      const request = HttpClientRequest.post(`/model/${modelId}/converse-stream`, {
        body: HttpBody.jsonUnsafe(body)
      })
      return Stream.unwrap(
        Effect.map(withConfigClient(), (client) =>
          client.execute(request).pipe(
            Effect.map((response) => response.stream),
            Stream.unwrap,
            Stream.pipeThroughChannel(EventStream.makeChannel(ConverseResponseStreamEvent)),
            Stream.catchTags({
              HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "converseStream")),
              SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "converseStream")),
              EventStreamError: (error) => Stream.fail(Errors.mapEventStreamError(error, "converseStream"))
            })
          ))
      )
    }

    return AmazonBedrockClient.of({
      converse,
      converseStream
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedAmazonBedrockHeaders))
  )
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the Amazon Bedrock client with the given options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: Options): Layer.Layer<AmazonBedrockClient, never, HttpClient.HttpClient> =>
  Layer.effect(AmazonBedrockClient, make(options))

/**
 * Creates a layer for the Amazon Bedrock client, loading credentials and other
 * settings via Effect's `Config` module.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (options: {
  readonly apiUrl?: Config.Config<string> | undefined
  readonly accessKeyId: Config.Config<string>
  readonly secretAccessKey: Config.Config<Redacted.Redacted<string>>
  readonly sessionToken?: Config.Config<Redacted.Redacted<string>> | undefined
  readonly region?: Config.Config<string> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<AmazonBedrockClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    AmazonBedrockClient,
    Effect.gen(function*() {
      const apiUrl = Predicate.isNotUndefined(options.apiUrl)
        ? yield* options.apiUrl :
        undefined
      const accessKeyId = yield* options.accessKeyId
      const secretAccessKey = yield* options.secretAccessKey
      const sessionToken = Predicate.isNotUndefined(options.sessionToken)
        ? yield* options.sessionToken :
        undefined
      const region = Predicate.isNotUndefined(options.region)
        ? yield* options.region :
        undefined
      return yield* make({
        apiUrl,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
        transformClient: options.transformClient
      })
    })
  )

// =============================================================================
// Utilities
// =============================================================================

const prepareBody = (body: HttpBody.HttpBody): string => {
  switch (body._tag) {
    case "Empty": {
      return ""
    }
    case "Raw":
    case "Uint8Array": {
      if (typeof body.body === "string") {
        return body.body
      }
      if (body.body instanceof Uint8Array) {
        return new TextDecoder().decode(body.body)
      }
      if (body.body instanceof ArrayBuffer) {
        return new TextDecoder().decode(body.body)
      }
      return JSON.stringify(body.body)
    }
  }
  throw new Error("Unsupported HttpBody: " + body._tag)
}
