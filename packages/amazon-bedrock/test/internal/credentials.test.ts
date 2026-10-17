import { assert, describe, it } from "@effect/vitest"
import type { AmazonBedrockClient } from "@wmaurer/effect-ai-amazon-bedrock"
import * as Credentials from "@wmaurer/effect-ai-amazon-bedrock/internal/credentials"
import { Clock, Context, Effect, Exit, Fiber, Option, Redacted } from "effect"
import { AiError } from "effect/ai"
import { TestClock } from "effect/testing"

const minute = 60 * 1000

class AccessKeyId extends Context.Service<AccessKeyId, string>()("AccessKeyId") {}

const accessKeyId = (credentials: Credentials.RequestCredentials) =>
  credentials._tag === "SigV4" ? credentials.accessKeyId : credentials._tag

/**
 * An `Effect` provider whose nth run returns `AKIA_<n>`, expiring `expiresIn`
 * milliseconds after the run on the fiber's clock.
 */
const countingProvider = (expiresIn: number | undefined) => {
  const state = { calls: 0, failure: undefined as AiError.AuthenticationError | undefined }
  const provider: Effect.Effect<AmazonBedrockClient.Credentials, AiError.AuthenticationError> = Effect.gen(
    function*() {
      state.calls++
      if (state.failure !== undefined) {
        return yield* Effect.fail(state.failure)
      }
      const now = yield* Clock.currentTimeMillis
      return {
        accessKeyId: `AKIA_${state.calls}`,
        secretAccessKey: "secret",
        expiration: expiresIn === undefined ? undefined : new Date(now + expiresIn)
      }
    }
  )
  return { state, provider }
}

const authenticationError = <R>(effect: Effect.Effect<unknown, AiError.AiError | AiError.AiErrorReason, R>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, AiError.AuthenticationError)
    return error
  })

const resolveKeyId = (authenticator: Credentials.Authenticator) => Effect.map(authenticator.resolve, accessKeyId)

describe("credentials", () => {
  describe("ways to authenticate", () => {
    it.effect("sends an API key as a bearer token", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({ apiKey: Redacted.make("bedrock-key") })
        const credentials = yield* authenticator.resolve
        assert.strictEqual(credentials._tag, "Bearer")
        if (credentials._tag === "Bearer") {
          assert.strictEqual(Redacted.value(credentials.apiKey), "bedrock-key")
        }
      }))

    it.effect("signs with static keys and drops an empty session token", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          accessKeyId: "AKIA_STATIC",
          secretAccessKey: Redacted.make("secret"),
          sessionToken: Redacted.make("")
        })
        const credentials = yield* authenticator.resolve
        assert.strictEqual(accessKeyId(credentials), "AKIA_STATIC")
        if (credentials._tag === "SigV4") {
          assert.strictEqual(Redacted.value(credentials.secretAccessKey), "secret")
          assert.strictEqual(credentials.sessionToken, undefined)
        }
      }))

    it.effect("dies when the options mix two ways to authenticate", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(Credentials.make({
          apiKey: Redacted.make("bedrock-key"),
          accessKeyId: "AKIA_STATIC",
          secretAccessKey: Redacted.make("secret")
        }))
        assert.isTrue(Exit.hasDies(exit))
      }))

    it.effect("dies when the options name no way to authenticate", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(Credentials.make({ accessKeyId: "AKIA_STATIC" }))
        assert.isTrue(Exit.hasDies(exit))
      }))
  })

  describe("credential provider", () => {
    it.effect("wraps the secrets in Redacted and keeps a session token", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: async () => ({
            accessKeyId: "AKIA_PROVIDED",
            secretAccessKey: "secret",
            sessionToken: "token"
          })
        })
        const credentials = yield* authenticator.resolve
        assert.strictEqual(credentials._tag, "SigV4")
        if (credentials._tag === "SigV4") {
          assert.strictEqual(credentials.accessKeyId, "AKIA_PROVIDED")
          assert.strictEqual(Redacted.value(credentials.secretAccessKey), "secret")
          assert.strictEqual(credentials.sessionToken && Redacted.value(credentials.sessionToken), "token")
        }
      }))

    it.effect("drops an empty session token", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: async () => ({
            accessKeyId: "AKIA_PROVIDED",
            secretAccessKey: "secret",
            sessionToken: ""
          })
        })
        const credentials = yield* authenticator.resolve
        assert.strictEqual(credentials._tag === "SigV4" ? credentials.sessionToken : "not SigV4", undefined)
      }))

    it.effect("fails with kind Unknown when the promise rejects", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: () => Promise.reject(new Error("Could not load credentials from any providers"))
        })
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.kind, "Unknown")
        assert.strictEqual(
          error.description,
          "The credential provider failed: Could not load credentials from any providers"
        )
      }))

    it.effect("fails with kind MissingKey when a key is empty", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: async () => ({ accessKeyId: "", secretAccessKey: "secret" })
        })
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.kind, "MissingKey")
      }))

    it.effect("fails with the error of an Effect provider", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: Effect.fail(new AiError.AuthenticationError({ kind: "InvalidKey", description: "vault" }))
        })
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.kind, "InvalidKey")
        assert.strictEqual(error.description, "vault")
      }))

    it.effect("passes a failure of an Effect provider through", () =>
      Effect.gen(function*() {
        const networkError = new AiError.NetworkError({
          reason: "TransportError",
          description: "vault unreachable",
          request: { method: "GET", url: "https://vault.example.com", urlParams: [], hash: undefined, headers: {} }
        })
        const authenticator = yield* Credentials.make({ credentialProvider: Effect.fail(networkError) })
        assert.strictEqual(yield* Effect.flip(authenticator.resolve), networkError)
      }))

    it.effect("runs an Effect provider with the services of the request before those of the build", () =>
      Effect.gen(function*() {
        const authenticator = yield* Credentials.make({
          credentialProvider: Effect.gen(function*() {
            return { accessKeyId: yield* AccessKeyId, secretAccessKey: "secret" }
          })
        }).pipe(Effect.provideService(AccessKeyId, "AKIA_BUILD"))
        const credentials = yield* authenticator.resolve.pipe(Effect.provideService(AccessKeyId, "AKIA_REQUEST"))
        assert.strictEqual(accessKeyId(credentials), "AKIA_REQUEST")
      }))

    it.effect("opens the spans of an Effect provider under the span of the request", () =>
      Effect.gen(function*() {
        const parents: Array<string> = []
        const authenticator = yield* Credentials.make({
          credentialProvider: Effect.gen(function*() {
            const span = yield* Effect.orDie(Effect.currentSpan)
            const parent = Option.getOrUndefined(span.parent)
            parents.push(parent === undefined ? "none" : parent._tag === "Span" ? parent.name : parent.spanId)
            return { accessKeyId: "AKIA_SPAN", secretAccessKey: "secret" }
          }).pipe(Effect.withSpan("provider"))
        }).pipe(Effect.withSpan("build"))
        yield* authenticator.resolve.pipe(Effect.withSpan("request"))
        assert.deepStrictEqual(parents, ["request"])
      }))

    it.effect("runs an Effect provider with the Clock of the request", () =>
      Effect.gen(function*() {
        const { provider } = countingProvider(60 * minute)
        // A second TestClock that stays at the start
        const authenticator = yield* Credentials.make({ credentialProvider: provider }).pipe(
          Effect.provide(TestClock.layer())
        )
        yield* TestClock.adjust(2 * 60 * minute)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        // Credentials stamped from the stopped clock would have expired already.
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
      }))

    it.effect("runs the provider once for concurrent requests", () =>
      Effect.gen(function*() {
        let calls = 0
        const authenticator = yield* Credentials.make({
          credentialProvider: Effect.sync(() => {
            calls++
            return { accessKeyId: `AKIA_${calls}`, secretAccessKey: "secret" }
          }).pipe(Effect.delay("1 second"))
        })
        const fiber = yield* Effect.forkChild(
          Effect.all(Array.from({ length: 5 }, () => resolveKeyId(authenticator)), { concurrency: "unbounded" })
        )
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Fiber.join(fiber), ["AKIA_1", "AKIA_1", "AKIA_1", "AKIA_1", "AKIA_1"])
        assert.strictEqual(calls, 1)
      }))

    it.effect("asks for new credentials five minutes before they expire", () =>
      Effect.gen(function*() {
        const { provider } = countingProvider(60 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        yield* TestClock.adjust(55 * minute - 1)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        yield* TestClock.adjust(1)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_2")
      }))

    it.effect("keeps credentials that expire in under five minutes for 10 seconds", () =>
      Effect.gen(function*() {
        const { provider } = countingProvider(2 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        yield* TestClock.adjust("9999 millis")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        yield* TestClock.adjust("1 milli")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_2")
      }))

    it.effect("keeps credentials without an expiration", () =>
      Effect.gen(function*() {
        const { provider } = countingProvider(undefined)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        yield* TestClock.adjust("30 days")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
      }))

    it.effect("serves the last good credentials for 30 seconds at a time while the provider fails", () =>
      Effect.gen(function*() {
        const { provider, state } = countingProvider(60 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")

        state.failure = new AiError.AuthenticationError({ kind: "Unknown", description: "STS is down" })
        yield* TestClock.adjust(55 * minute)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        assert.strictEqual(state.calls, 2)

        yield* TestClock.adjust("29 seconds")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        assert.strictEqual(state.calls, 2)

        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        assert.strictEqual(state.calls, 3)

        // At the expiration of AKIA_1
        yield* TestClock.adjust(4.5 * minute)
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.description, "STS is down")
        assert.strictEqual(state.calls, 4)
      }))

    it.effect("serves the last good credentials while the provider fails only until they expire", () =>
      Effect.gen(function*() {
        const { provider, state } = countingProvider(60 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")

        state.failure = new AiError.AuthenticationError({ kind: "Unknown", description: "STS is down" })
        yield* TestClock.adjust(60 * minute - 10 * 1000)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        assert.strictEqual(state.calls, 2)

        yield* TestClock.adjust("9999 millis")
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_1")
        assert.strictEqual(state.calls, 2)

        // At the expiration of AKIA_1
        yield* TestClock.adjust("1 milli")
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.description, "STS is down")
        assert.strictEqual(state.calls, 3)
      }))

    it.effect("does not cache a failure", () =>
      Effect.gen(function*() {
        const { provider, state } = countingProvider(60 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        state.failure = new AiError.AuthenticationError({ kind: "Unknown", description: "STS is down" })
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.description, "STS is down")

        state.failure = undefined
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_2")
      }))

    it.effect("refetches once, with forceRefresh, for many rejections of the same credentials", () =>
      Effect.gen(function*() {
        const calls: Array<unknown> = []
        const authenticator = yield* Credentials.make({
          credentialProvider: async (options) => {
            calls.push(options)
            return { accessKeyId: `AKIA_${calls.length}`, secretAccessKey: "secret" }
          }
        })
        const first = yield* authenticator.resolve
        yield* Effect.all([
          authenticator.invalidate(first),
          authenticator.invalidate(first),
          authenticator.invalidate(first)
        ], { concurrency: "unbounded" })
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_2")

        // A late rejection of the old credentials leaves the new ones in place.
        yield* authenticator.invalidate(first)
        assert.strictEqual(yield* resolveKeyId(authenticator), "AKIA_2")
        assert.deepStrictEqual(calls, [undefined, { forceRefresh: true }])
      }))

    it.effect("serves no rejected credentials while the provider fails", () =>
      Effect.gen(function*() {
        const { provider, state } = countingProvider(60 * minute)
        const authenticator = yield* Credentials.make({ credentialProvider: provider })
        const first = yield* authenticator.resolve
        yield* authenticator.invalidate(first)

        state.failure = new AiError.AuthenticationError({ kind: "Unknown", description: "STS is down" })
        const error = yield* authenticationError(authenticator.resolve)
        assert.strictEqual(error.description, "STS is down")
      }))
  })
})
