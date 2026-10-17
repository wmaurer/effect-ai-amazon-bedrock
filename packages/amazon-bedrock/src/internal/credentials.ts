import { AwsV4Signer } from "aws4fetch"
import * as AiError from "effect/ai/AiError"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Headers from "effect/http/Headers"
import type * as HttpBody from "effect/http/HttpBody"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import type { CredentialProvider, Credentials } from "../AmazonBedrockClient.ts"

// =============================================================================
// Models
// =============================================================================

/**
 * The authentication fields of the client's options. Every field is optional
 * here, because a caller in untyped JavaScript can mix the three ways to
 * authenticate that the public `Options` type keeps apart.
 *
 * @internal
 */
export interface AuthenticationOptions<R> {
  readonly accessKeyId?: string | undefined
  readonly secretAccessKey?: Redacted.Redacted<string> | undefined
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  readonly credentialProvider?: CredentialProvider<R> | undefined
  readonly apiKey?: Redacted.Redacted<string> | undefined
}

/**
 * What one request is authenticated with.
 *
 * @internal
 */
export type RequestCredentials = Bearer | SigV4

/** @internal */
export interface Bearer {
  readonly _tag: "Bearer"
  readonly apiKey: Redacted.Redacted<string>
}

/** @internal */
export interface SigV4 {
  readonly _tag: "SigV4"
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken: Redacted.Redacted<string> | undefined
  readonly expiration: Date | undefined
}

type Authentication<R> =
  | { readonly _tag: "ApiKey"; readonly credentials: Bearer }
  | { readonly _tag: "Static"; readonly credentials: SigV4 }
  | { readonly _tag: "Provider"; readonly provider: CredentialProvider<R> }

/** @internal */
export interface Authenticator {
  /**
   * The credentials for the next request. Only a credential provider can
   * fail here.
   */
  readonly resolve: Effect.Effect<RequestCredentials, AiError.AiError | AiError.AiErrorReason>
  /**
   * Drops `rejected` from the cache if they are still the latest credentials
   * from the provider, so that the next `resolve` asks the provider again with
   * `forceRefresh`. Rejections of credentials that are no longer the latest do
   * nothing, so many rejections of one set of credentials cause one refetch.
   */
  readonly invalidate: (rejected: RequestCredentials) => Effect.Effect<void>
}

// =============================================================================
// Constructor
// =============================================================================

/** @internal */
export const make = <R = never>(options: AuthenticationOptions<R>): Effect.Effect<Authenticator, never, R> =>
  Effect.flatMap(authentication(options), (authentication): Effect.Effect<Authenticator, never, R> => {
    switch (authentication._tag) {
      case "ApiKey":
      case "Static": {
        return Effect.succeed({
          resolve: Effect.succeed(authentication.credentials),
          invalidate: () => Effect.void
        })
      }
      case "Provider": {
        return fromProvider(authentication.provider)
      }
    }
  })

const authentication = <R>(options: AuthenticationOptions<R>): Effect.Effect<Authentication<R>> => {
  const { accessKeyId, apiKey, credentialProvider, secretAccessKey, sessionToken } = options
  const staticKeys = accessKeyId !== undefined || secretAccessKey !== undefined || sessionToken !== undefined
  const ways = [staticKeys, credentialProvider !== undefined, apiKey !== undefined].filter(Boolean).length
  if (ways === 1) {
    if (apiKey !== undefined) {
      return Effect.succeed({ _tag: "ApiKey", credentials: { _tag: "Bearer", apiKey } })
    }
    if (credentialProvider !== undefined) {
      return Effect.succeed({ _tag: "Provider", provider: credentialProvider })
    }
    if (accessKeyId !== undefined && secretAccessKey !== undefined) {
      return Effect.succeed({
        _tag: "Static",
        credentials: sigV4({ accessKeyId, secretAccessKey, sessionToken, expiration: undefined })
      })
    }
  }
  return Effect.die(
    new Error(
      "AmazonBedrockClient takes exactly one of `apiKey`, `credentialProvider`, or `accessKeyId` with `secretAccessKey`"
    )
  )
}

const sigV4 = (credentials: Omit<SigV4, "_tag">): SigV4 => ({
  _tag: "SigV4",
  ...credentials,
  sessionToken: credentials.sessionToken !== undefined && Redacted.value(credentials.sessionToken) !== ""
    ? credentials.sessionToken
    : undefined
})

// =============================================================================
// Credential Provider
// =============================================================================

/** Matches the refresh window of the AWS SDK's `memoizeChain`. */
const refreshBeforeExpiration = 5 * 60 * 1000
/** Keeps a provider without a cache of its own from running on every request. */
const minimumTimeToLive = 10 * 1000
/**
 * How long the last good credentials are served while the provider fails, or
 * until they expire if that is sooner.
 */
const fallbackTimeToLive = 30 * 1000

const timeToLive = (expiration: Date | undefined, now: number): number => {
  if (expiration === undefined) {
    return Infinity
  }
  const remaining = expiration.getTime() - now
  return Math.max(0, remaining - refreshBeforeExpiration, Math.min(minimumTimeToLive, remaining))
}

const parse = (credentials: Credentials): Effect.Effect<SigV4, AiError.AuthenticationError> =>
  credentials.accessKeyId && credentials.secretAccessKey
    ? Effect.succeed(sigV4({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: Redacted.make(credentials.secretAccessKey),
      sessionToken: credentials.sessionToken !== undefined ? Redacted.make(credentials.sessionToken) : undefined,
      expiration: credentials.expiration
    }))
    : Effect.fail(
      new AiError.AuthenticationError({
        kind: "MissingKey",
        description: "The credential provider returned an empty access key ID or secret access key"
      })
    )

const fromProvider = <R>(provider: CredentialProvider<R>): Effect.Effect<Authenticator, never, R> =>
  Effect.gen(function*() {
    // As in Toolkit, the services of the request fiber win, so that its span is
    // the parent of the provider's spans. The services of the build fill in R.
    const services = yield* Effect.context<R>()
    let lastGood: SigV4 | undefined
    let forceNext = false

    const fetch = (forceRefresh: boolean): Effect.Effect<Credentials, AiError.AiError | AiError.AiErrorReason> =>
      Effect.isEffect(provider)
        ? Effect.updateContext(provider, (input: Context.Context<never>) => Context.merge(services, input))
        : Effect.tryPromise({
          try: () => forceRefresh ? provider({ forceRefresh }) : provider(),
          catch: (cause) =>
            new AiError.AuthenticationError({
              kind: "Unknown",
              description: `The credential provider failed: ${cause instanceof Error ? cause.message : String(cause)}`
            })
        })

    const load = Effect.gen(function*() {
      const forceRefresh = forceNext
      forceNext = false
      const result = yield* Effect.result(Effect.flatMap(fetch(forceRefresh), parse))
      const now = yield* Clock.currentTimeMillis
      if (Result.isSuccess(result)) {
        lastGood = result.success
        return { credentials: result.success, timeToLive: timeToLive(result.success.expiration, now) }
      }
      if (lastGood !== undefined && (lastGood.expiration === undefined || now < lastGood.expiration.getTime())) {
        return {
          credentials: lastGood,
          timeToLive: lastGood.expiration === undefined
            ? fallbackTimeToLive
            : Math.min(fallbackTimeToLive, lastGood.expiration.getTime() - now)
        }
      }
      return yield* result.failure
    })

    const [cached, clear] = yield* Effect.cachedInvalidateWithTTL(
      load,
      (exit) => Exit.isSuccess(exit) ? exit.value.timeToLive : 0
    )

    return {
      resolve: Effect.map(cached, ({ credentials }) => credentials),
      invalidate: (rejected) =>
        Effect.suspend(() => {
          if (rejected !== lastGood) {
            return Effect.void
          }
          lastGood = undefined
          forceNext = true
          return clear
        })
    }
  })

// =============================================================================
// Requests
// =============================================================================

/**
 * The credentials of the request in flight. The client resolves them before
 * `HttpClient.execute` and provides them around it, so that a resolution
 * failure is not an `HttpClientError` that a retry policy would retry, and so
 * that every retry inside `execute` signs again with them.
 *
 * @internal
 */
export const CurrentRequestCredentials = Context.Reference<RequestCredentials | undefined>(
  "@wmaurer/effect-ai-amazon-bedrock/internal/credentials/CurrentRequestCredentials",
  { defaultValue: () => undefined }
)

/**
 * Signs the request with SigV4, or sets the bearer header of an API key, from
 * {@link CurrentRequestCredentials}.
 *
 * @internal
 */
export const authenticateRequest = (region: string) =>
  Effect.fnUntraced(function*(request: HttpClientRequest.HttpClientRequest) {
    const credentials = yield* CurrentRequestCredentials
    if (credentials === undefined) {
      return yield* Effect.die(new Error("AmazonBedrockClient sent a request without resolving its credentials"))
    }
    switch (credentials._tag) {
      case "Bearer": {
        return HttpClientRequest.bearerToken(request, credentials.apiKey)
      }
      case "SigV4": {
        const signer = new AwsV4Signer({
          service: "bedrock",
          url: request.url,
          method: request.method,
          headers: Object.entries(request.headers),
          body: prepareBody(request.body),
          region,
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: Redacted.value(credentials.secretAccessKey),
          ...(credentials.sessionToken !== undefined ? { sessionToken: Redacted.value(credentials.sessionToken) } : {})
        })
        const { headers } = yield* Effect.promise(() => signer.sign())
        return HttpClientRequest.setHeaders(request, Headers.merge(request.headers, Headers.fromInput(headers)))
      }
    }
  })

/**
 * Kinds of `AuthenticationError` that say the credentials themselves were
 * rejected. `InsufficientPermissions` is not one of them, because new
 * credentials for the same role do not change its IAM policy.
 */
const rejectedKinds: ReadonlySet<AiError.AuthenticationError["kind"]> = new Set([
  "ExpiredKey",
  "InvalidKey",
  "MissingKey"
])

/**
 * Invalidates `credentials` when `error` says Bedrock rejected them.
 *
 * @internal
 */
export const invalidateIfRejected =
  (authenticator: Authenticator, credentials: RequestCredentials) => (error: AiError.AiError): Effect.Effect<void> =>
    error.reason._tag === "AuthenticationError" && rejectedKinds.has(error.reason.kind)
      ? authenticator.invalidate(credentials)
      : Effect.void

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
