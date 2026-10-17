# Credential provider and Bedrock API keys (0.2.0)

Status: designed, not implemented. 0.1.0 is on npm. This record is the starting point for the 0.2.0 work.

## Problem

`AmazonBedrockClient` 0.1.0 takes one fixed access key ID, secret access key, and optional session token. It reads them once, when the layer is built. That leaves three gaps, which `docs/TODO.md` ("Credentials") records:

- No AWS credential chain. Profiles, IAM Identity Center, ECS and EKS container credentials, and EC2 instance metadata do not reach the client unless the caller copies them in.
- No refresh. A long-running process with temporary credentials fails with `ExpiredKey` when the session ends.
- No Bedrock API keys, which are sent as `Authorization: Bearer <key>` instead of a SigV4 signature.

Constraints:

- No new runtime dependency. The package may become a PR to `effect-ts/effect`, and Effect will not take the AWS SDK.
- Every 0.1.0 call of `layer` and `layerConfig` must still compile.
- Service methods fail only with `AiError`.

## Usage

```ts
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"

// The AWS default chain: environment, ~/.aws, IAM Identity Center, ECS, EKS, EC2.
AmazonBedrockClient.layer({ region: "eu-west-1", credentialProvider: fromNodeProviderChain() })

// An Effect that loads credentials, for example from a secrets service.
AmazonBedrockClient.layer({ region: "eu-west-1", credentialProvider: loadCredentials })

// A Bedrock API key.
AmazonBedrockClient.layerConfig({
  region: Config.String("AWS_REGION"),
  apiKey: Config.Redacted("AWS_BEARER_TOKEN_BEDROCK")
})

// 0.1.0 callers, unchanged.
AmazonBedrockClient.layerConfig({
  accessKeyId: Config.String("AWS_ACCESS_KEY_ID"),
  secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY")
})
```

## Public types

New exports are `Credentials`, `CredentialProvider`, and `ConfigOptions`. `Options` changes shape. `make`, `layer`, and `Service` keep their signatures. `layerConfig` takes `ConfigOptions`.

```ts
/** Structurally the AWS SDK's `AwsCredentialIdentity`, so SDK providers fit without an adapter. */
export interface Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string | undefined
  readonly expiration?: Date | undefined
}

export type CredentialProvider =
  | ((options?: { readonly forceRefresh?: boolean }) => PromiseLike<Credentials>)
  | Effect.Effect<Credentials, AiError.AuthenticationError>

interface CommonOptions {
  readonly apiUrl?: string | undefined
  readonly region?: string | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

interface StaticKeys { // the 0.1.0 fields
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  readonly credentialProvider?: never
  readonly apiKey?: never
}

interface ProvidedKeys {
  readonly credentialProvider: CredentialProvider
  readonly accessKeyId?: never
  readonly secretAccessKey?: never
  readonly sessionToken?: never
  readonly apiKey?: never
}

interface ApiKey {
  readonly apiKey: Redacted.Redacted<string>
  readonly accessKeyId?: never
  readonly secretAccessKey?: never
  readonly sessionToken?: never
  readonly credentialProvider?: never
}

export type Options = CommonOptions & (StaticKeys | ProvidedKeys | ApiKey)

// The same three arms with Config values. credentialProvider and transformClient stay plain.
export type ConfigOptions = /* see the sketch */
```

The `forceRefresh?: boolean` field has no `| undefined`. With `exactOptionalPropertyTypes`, adding it stops the SDK's provider type from assigning.

A type-checked sketch of this surface, with usage and misuse cases, was checked on 2026-10-17 with `tsc` under the package's compiler options. It accepts `fromNodeProviderChain()`'s type unchanged, an `Effect` that fails with `AuthenticationError`, and every 0.1.0 shape. It rejects two auth arms mixed, no auth arm, a plain-string `apiKey`, and an `Effect` with an unrelated error type. Rebuild that check when you implement. Write `test/AmazonBedrockClient.types.ts` or equivalent `@ts-expect-error` cases.

## Behaviour

Internally, one function discriminates the `Options` union into an `Authentication` value (`ApiKey`, `Static`, or `Provider`). It dies on a mix that only untyped JavaScript can produce. Nothing else branches on the auth arm.

### Requests

1. Before `execute`, the client resolves the credentials for the request. Only the `Provider` arm can fail here. The failure is an `AiError` whose reason is an `AuthenticationError`, with kind `Unknown` for a rejected promise and kind `MissingKey` for empty keys. An `Effect` provider chooses its own `AuthenticationError`.
2. Signing stays inside the `HttpClient` pipeline, in a `mapRequestEffect` that cannot fail. It reads the resolved credentials from a request-scoped service provided around `client.execute`, then signs with `aws4fetch` or sets the bearer header. A retry in `transformClient` re-runs this step, so it signs again with a fresh date, as 0.1.0 does.
3. After a 401 or 403 whose kind is `ExpiredKey`, `InvalidKey`, or `MissingKey`, the client calls `invalidate` with the credentials that the request used. The rejected request fails and is not retried. `InsufficientPermissions` does not invalidate, because new credentials from the same role do not fix an IAM policy.

The bearer header needs no new redaction code. `authorization` is in the default `Headers.CurrentRedactedNames` (`effect/src/http/Headers.ts:764`).

### Cache

One cache per client, built with `Effect.cachedInvalidateWithTTL`.

```
load:
  force = forceNext; forceNext = false; now = Clock.currentTimeMillis
  credentials = run the provider (function: called with { forceRefresh: true } when force)
                parse: non-empty keys, secrets into Redacted, empty sessionToken dropped
  lastGood = credentials
  ttl = no expiration ? infinity
                      : max(expiration - now - 5 min, min(10 s, expiration - now))
  on failure: lastGood still before its expiration ? serve lastGood with ttl 30 s : fail

[get, clear] = Effect.cachedInvalidateWithTTL(load, exit => success ? ttl : zero)

invalidate(rejected) = rejected === lastGood ? (lastGood = undefined; forceNext = true; clear) : nothing
```

- Five minutes matches the AWS SDK's `memoizeChain` window, so both caches agree on when credentials are stale.
- The 10-second floor stops a provider without its own cache from being called on every request.
- Failures are never cached.
- `invalidate` compares by identity, so many rejections of one set of credentials cause one refetch.
- Compute the TTL inside `load` with the fiber's `Clock`, so `TestClock` drives expiry in tests.

## Facts checked on 2026-10-17

- `fromNodeProviderChain()` memoizes already. It uses `memoizeChain` with a 300000 ms window, and `forceRefresh` bypasses the cache. The single providers, such as `fromTemporaryCredentials`, `fromContainerMetadata`, and `fromSSO`, do not memoize. Source: `.repos/refs/aws-sdk-js-v3`.
- `Effect.cachedInvalidateWithTTL` in Effect 4.0.5 is single-flight. Concurrent callers join one run. A run is interrupted only when every caller has left, and an interrupted run is not cached. The run executes in the context of the first caller. `invalidate` clears the cached value and does not cancel a run in flight. Source: `makeCachedUnsafe` in `effect/src/Effect.ts`.
- `HttpClient.retryTransient` retries every `TransportError` (`effect/src/http/HttpClient.ts:2456`). Tunnelling a provider failure through `HttpClientError` would make a retry policy in `transformClient` retry a broken provider. That is why the design resolves credentials before `execute`.
- `HttpClient.transformResponse` re-runs the request preprocessing, so a retry built on it re-signs. `HttpClient.transform` does not.
- `aws4fetch` at the pinned version adds `X-Amz-Security-Token` only for a non-empty token (`.repos/deps/aws4fetch/src/main.js:182`). The README's `Redacted.make("")` default sends no token.
- Prior art: the AI SDK's Bedrock provider takes `apiKey`, falling back to `AWS_BEARER_TOKEN_BEDROCK`, and `credentialProvider` (`.repos/refs/vercel-ai/packages/amazon-bedrock/src/amazon-bedrock-provider.ts`).
- Effect accepts a value or an `Effect` in its own APIs, for example `Toolkit.toLayer`'s `build: Handlers | Effect.Effect<Handlers, EX, RX>` (`effect/src/ai/Toolkit.ts:95`).

## How the design was chosen

Two independent sketches (Opus and Sonnet) and a third model judging them all converged on the same core design. That design has three exclusive auth arms, a provider type with the SDK's shape, `cachedInvalidateWithTTL`, a five-minute window, use of the last good credentials while the provider fails, and no reading of environment variables.

- The base is the Opus sketch. It resolves credentials before `execute`, uses one `Authenticator`, and invalidates by identity.
- From the Sonnet sketch: the names `credentialProvider` and `?: never`, one plain `Credentials` type, the 10-second floor, and the runtime guard against mixed auth arms.
- The `Effect` arm of `CredentialProvider` came from the Opus sketch. It was dropped in synthesis and then restored after review, because Effect APIs accept a value or an `Effect`, and because code written in Effect should not need `Effect.runPromise` inside a provider.

Rejected:

- Reporting provider failures as `TransportError` inside `HttpClientError`. Retry middleware would treat them as transient.
- Signing before `transformClient`. A retry would resend a stale signature.
- Retrying a request rejected with `ExpiredTokenException`. Refreshing five minutes early makes that case rare, and a retry must drain the rejected response, which is untested.
- Reading `AWS_BEARER_TOKEN_BEDROCK` implicitly. Every other setting goes through `Config`.
- Depending on `@aws-sdk/credential-providers`.
- A separate credentials service or layer. It would be a second way to set credentials beside the 0.1.0 fields.

## Open questions

- Should the `Effect` arm accept any error and wrap it in an `AuthenticationError` of kind `Unknown`? The design takes only `AuthenticationError`.
- Should the `Effect` arm allow requirements (`R`) to flow into the layer? The design uses `R = never`, so the caller provides services first.
- Does the request-scoped service from Behaviour step 2 reach a `mapRequestEffect` inside a client that `transformClient` wrapped with a retry? Prototype this first.

## Implementation plan

Each step ends in a check. Work on a branch and commit each step.

1. Prototype step 2 of Behaviour. Show with a stubbed `HttpClient` that a retry in `transformClient` signs the request again from the resolved credentials.
2. Write the public types and the `@ts-expect-error` cases, with `not implemented` bodies. Run `pnpm check`.
3. Write `src/internal/credentials.ts`: the `Authentication` discrimination, the parse, the cache, and `invalidate`. Test it with `TestClock`: single flight under concurrency, refresh five minutes before expiry, the 10-second floor, the last good credentials while the provider fails, no caching of failures, and one refetch for many rejections.
4. Wire `make` and `layerConfig`. Add stubbed-`HttpClient` tests for the bearer header, its redaction in `AiError`, provider failure as `AuthenticationError`, and invalidation after a 403 with `ExpiredTokenException`.
5. Run a live check. Pass a provider built from the STS credentials that the live suites use. Run one request with a Bedrock API key, if the account can issue one.
6. Update the docs. The README "Configure the client" section gets the three ways to authenticate, and loses the workarounds that 0.1.0 needed. Add a 0.2.0 entry to the CHANGELOG. Update the TODO "Credentials" section.
7. Run the four checks in `AGENTS.md` ("Before you claim work is done"), then the release steps.

New exports and options get `@since 0.2.0`. `scripts/upstream-check.sh` rewrites every `@since` to the Effect version.
