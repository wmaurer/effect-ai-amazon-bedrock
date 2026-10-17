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
 * @stability unstable
 * @since 0.1.0
 */
import type * as AiError from "effect/ai/AiError"
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Headers from "effect/http/Headers"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import { AmazonBedrockConfig } from "./AmazonBedrockConfig.ts"
import * as EventStream from "./AmazonBedrockEventStream.ts"
import type { ConverseRequest } from "./AmazonBedrockSchema.ts"
import { ConverseResponse, ConverseResponseStreamEvent } from "./AmazonBedrockSchema.ts"
import * as Authentication from "./internal/credentials.ts"
import * as Errors from "./internal/errors.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Represents the Amazon Bedrock client service with methods for the Converse
 * API, including regular and streaming message creation.
 *
 * @stability unstable
 * @category models
 * @since 0.1.0
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
 * @stability unstable
 * @category services
 * @since 0.1.0
 */
export class AmazonBedrockClient extends Context.Service<AmazonBedrockClient, Service>()(
  "@wmaurer/effect-ai-amazon-bedrock/AmazonBedrockClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * SigV4 credentials as a {@link CredentialProvider} returns them. The shape is
 * the AWS SDK's `AwsCredentialIdentity`, so the SDK's providers fit without an
 * adapter.
 *
 * @stability unstable
 * @category options
 * @since 0.2.0
 */
export interface Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** An empty token is sent as no token. */
  readonly sessionToken?: string | undefined
  /** The client asks the provider for new credentials five minutes before this time. */
  readonly expiration?: Date | undefined
}

/**
 * Supplies SigV4 credentials that can change while the program runs.
 *
 * **Details**
 *
 * A provider is one of these:
 *
 * - A function in the shape of the AWS SDK's credential providers, such as
 *   `fromNodeProviderChain()` from `@aws-sdk/credential-providers`. A rejected
 *   promise fails the request with an `AuthenticationError` of kind
 *   `"Unknown"`. After Bedrock rejects the credentials, the client calls the
 *   function with `{ forceRefresh: true }`.
 * - An `Effect`. It can fail with an `AiError`, which the request fails with
 *   unchanged, or with an `AiError` reason, such as an `AuthenticationError`,
 *   which the client wraps in an `AiError`. The services that it requires
 *   become requirements of the layer. It runs with the services of the
 *   request first, and the services that the layer was built with fill in the
 *   rest.
 *
 * The client runs the provider at most once at a time, and keeps the
 * credentials until five minutes before their `expiration`. Credentials with
 * no `expiration` are kept until Bedrock rejects them. Keys that are empty fail
 * the request with an `AuthenticationError` of kind `"MissingKey"`.
 *
 * @stability unstable
 * @category options
 * @since 0.2.0
 */
export type CredentialProvider<R = never> =
  // `forceRefresh` has no `| undefined`: with `exactOptionalPropertyTypes`, the
  // AWS SDK's provider types would not assign to it.
  | ((options?: { readonly forceRefresh?: boolean }) => PromiseLike<Credentials>)
  | Effect.Effect<Credentials, AiError.AiError | AiError.AiErrorReason, R>

interface CommonOptions {
  /**
   * The base URL for the Bedrock runtime API. Override to use a proxy or a
   * different endpoint.
   *
   * @default `https://bedrock-runtime.${region}.amazonaws.com`
   */
  readonly apiUrl?: string | undefined
  /**
   * The AWS region.
   *
   * @default "us-east-1"
   */
  readonly region?: string | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

interface StaticKeys {
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  readonly credentialProvider?: never
  readonly apiKey?: never
}

interface ProvidedKeys<R> {
  readonly credentialProvider: CredentialProvider<R>
  readonly accessKeyId?: never
  readonly secretAccessKey?: never
  readonly sessionToken?: never
  readonly apiKey?: never
}

interface ApiKey {
  /** A Bedrock API key, sent as `Authorization: Bearer <key>` in place of a SigV4 signature. */
  readonly apiKey: Redacted.Redacted<string>
  readonly accessKeyId?: never
  readonly secretAccessKey?: never
  readonly sessionToken?: never
  readonly credentialProvider?: never
}

/**
 * Configuration for creating an Amazon Bedrock client.
 *
 * **Details**
 *
 * The options take exactly one way to authenticate:
 *
 * - `accessKeyId` and `secretAccessKey`, and an optional `sessionToken`.
 * - `credentialProvider`, a {@link CredentialProvider}.
 * - `apiKey`, a Bedrock API key.
 *
 * @stability unstable
 * @category options
 * @since 0.1.0
 */
export type Options<R = never> = CommonOptions & (StaticKeys | ProvidedKeys<R> | ApiKey)

/**
 * The {@link Options} of {@link layerConfig}, with a `Config` for each value.
 * `credentialProvider` and `transformClient` are not configuration, so they
 * take the same values as in {@link Options}.
 *
 * @stability unstable
 * @category options
 * @since 0.2.0
 */
export type ConfigOptions<R = never> =
  & {
    readonly apiUrl?: Config.Config<string> | undefined
    readonly region?: Config.Config<string> | undefined
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
  }
  & (
    | {
      readonly accessKeyId: Config.Config<string>
      readonly secretAccessKey: Config.Config<Redacted.Redacted<string>>
      readonly sessionToken?: Config.Config<Redacted.Redacted<string>> | undefined
      readonly credentialProvider?: never
      readonly apiKey?: never
    }
    | ProvidedKeys<R>
    | {
      readonly apiKey: Config.Config<Redacted.Redacted<string>>
      readonly accessKeyId?: never
      readonly secretAccessKey?: never
      readonly sessionToken?: never
      readonly credentialProvider?: never
    }
  )

// =============================================================================
// Constructor
// =============================================================================

const RedactedAmazonBedrockHeaders = {
  AmzSecurityToken: "X-Amz-Security-Token"
}

const appendRedactedHeaders = Array.appendAll(Object.values(RedactedAmazonBedrockHeaders))

const withRedactedHeaders = Effect.updateService(Headers.CurrentRedactedNames, appendRedactedHeaders)

/**
 * Creates an Amazon Bedrock client service with the given options.
 *
 * @stability unstable
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: Options<R>): Effect.Effect<Service, never, HttpClient.HttpClient | R> =>
  makeUnsafe(options)

// Takes each authentication field as optional, as `layerConfig` reads them.
// `Authentication.make` dies on a mix of the ways to authenticate.
const makeUnsafe = <R>(
  options: CommonOptions & Authentication.AuthenticationOptions<R>
): Effect.Effect<Service, never, HttpClient.HttpClient | R> =>
  Effect.gen(function*() {
    const region = options.region ?? "us-east-1"
    const authenticator = yield* Authentication.make(options)

    const baseClient = yield* HttpClient.HttpClient

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`),
          HttpClientRequest.acceptJson
        )
      ),
      HttpClient.mapRequestEffect(Authentication.authenticateRequest(region)),
      options.transformClient ? options.transformClient : identity
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const withConfigClient = Effect.fnUntraced(function*() {
      const config = yield* AmazonBedrockConfig.getOrUndefined
      return config?.transformClient ? config.transformClient(httpClientOk) : httpClientOk
    })

    const resolveCredentials = (method: string) =>
      Effect.mapError(authenticator.resolve, Errors.mapCredentialProviderError(method))

    const converse: Service["converse"] = ({ payload: { modelId, ...body } }) =>
      Effect.gen(function*() {
        const client = yield* withConfigClient()
        const credentials = yield* resolveCredentials("converse")
        const request = HttpClientRequest.post(`/model/${modelId}/converse`, {
          body: HttpBody.jsonUnsafe(body)
        })
        return yield* client.execute(request).pipe(
          Effect.provideService(Authentication.CurrentRequestCredentials, credentials),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ConverseResponse)),
          Effect.catchTags({
            HttpClientError: (error) =>
              Errors.mapHttpClientError(error, "converse").pipe(
                Effect.tapError(Authentication.invalidateIfRejected(authenticator, credentials))
              ),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "converse"))
          }),
          withRedactedHeaders
        )
      })

    const converseStream: Service["converseStream"] = ({ payload: { modelId, ...body } }) => {
      const request = HttpClientRequest.post(`/model/${modelId}/converse-stream`, {
        body: HttpBody.jsonUnsafe(body)
      })
      return Stream.unwrap(
        Effect.gen(function*() {
          const client = yield* withConfigClient()
          const credentials = yield* resolveCredentials("converseStream")
          return client.execute(request).pipe(
            Effect.provideService(Authentication.CurrentRequestCredentials, credentials),
            Effect.map((response) => response.stream),
            Stream.unwrap,
            Stream.pipeThroughChannel(EventStream.makeChannel(ConverseResponseStreamEvent)),
            Stream.catchTags({
              HttpClientError: (error) =>
                Stream.fromEffect(
                  Errors.mapHttpClientError(error, "converseStream").pipe(
                    Effect.tapError(Authentication.invalidateIfRejected(authenticator, credentials))
                  )
                ),
              SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "converseStream")),
              EventStreamError: (error) => Stream.fail(Errors.mapEventStreamError(error, "converseStream"))
            }),
            Stream.updateService(Headers.CurrentRedactedNames, appendRedactedHeaders)
          )
        })
      )
    }

    return AmazonBedrockClient.of({
      converse,
      converseStream
    })
  }).pipe(withRedactedHeaders)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the Amazon Bedrock client with the given options.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layer = <R = never>(
  options: Options<R>
): Layer.Layer<AmazonBedrockClient, never, HttpClient.HttpClient | R> =>
  Layer.effect(AmazonBedrockClient, make(options))

/**
 * Creates a layer for the Amazon Bedrock client, loading credentials and other
 * settings via Effect's `Config` module.
 *
 * @stability unstable
 * @category layers
 * @since 0.1.0
 */
export const layerConfig = <R = never>(
  options: ConfigOptions<R>
): Layer.Layer<AmazonBedrockClient, Config.ConfigError, HttpClient.HttpClient | R> =>
  Layer.effect(
    AmazonBedrockClient,
    Effect.gen(function*() {
      return yield* makeUnsafe({
        apiUrl: yield* readOptional(options.apiUrl),
        region: yield* readOptional(options.region),
        accessKeyId: yield* readOptional(options.accessKeyId),
        secretAccessKey: yield* readOptional(options.secretAccessKey),
        sessionToken: yield* readOptional(options.sessionToken),
        apiKey: yield* readOptional(options.apiKey),
        credentialProvider: options.credentialProvider,
        transformClient: options.transformClient
      })
    })
  )

const readOptional = <A>(config: Config.Config<A> | undefined): Effect.Effect<A | undefined, Config.ConfigError> =>
  config === undefined ? Effect.undefined : config
