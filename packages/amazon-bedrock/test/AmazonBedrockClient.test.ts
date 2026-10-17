import { assert, describe, it } from "@effect/vitest"
import { AmazonBedrockClient, AmazonBedrockConfig } from "@wmaurer/effect-ai-amazon-bedrock"
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Stream } from "effect"
import { AiError } from "effect/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { happyPathFrames } from "./utils.ts"

const payload = {
  modelId: "us.test.model-v1:0",
  messages: [{ role: "user" as const, content: [{ text: "Hello" }] }]
}

const converseBody = {
  output: { message: { role: "assistant", content: [{ text: "Hi there" }] } },
  usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  stopReason: "end_turn",
  metrics: { latencyMs: 42 }
}

type Reply = {
  readonly status: number
  readonly body?: unknown
  readonly errorType?: string
  readonly stream?: boolean
}

/**
 * An `HttpClient` that answers the nth request with `replies[n]`, repeating
 * the last reply, and keeps every request it receives.
 */
const stubHttpClient = (replies: ReadonlyArray<Reply>) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      requests.push(request)
      const reply = replies[Math.min(requests.length, replies.length) - 1]!
      const headers: Record<string, string> = reply.errorType === undefined
        ? {}
        : { "x-amzn-errortype": `${reply.errorType}:http://internal.amazon.com/coral/com.amazon.bedrock/` }
      if (reply.stream === true) {
        const bytes = new Uint8Array(happyPathFrames.flatMap((frame) => [...frame]))
        return HttpClientResponse.fromWeb(
          request,
          new Response(bytes, {
            status: reply.status,
            headers: { "content-type": "application/vnd.amazon.eventstream" }
          })
        )
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body ?? converseBody), {
          status: reply.status,
          headers: { "content-type": "application/json", ...headers }
        })
      )
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const ok: Reply = { status: 200 }
const expiredToken: Reply = {
  status: 403,
  body: { message: "The security token included in the request is expired" },
  errorType: "ExpiredTokenException"
}
const accessDenied: Reply = {
  status: 403,
  body: { message: "You don't have access to the model with the specified model ID." },
  errorType: "AccessDeniedException"
}

/** The access key ID in a SigV4 `authorization` header. */
const signedWith = (request: HttpClientRequest.HttpClientRequest) =>
  /Credential=([^/]+)\//.exec(request.headers["authorization"] ?? "")?.[1]

/** A provider whose nth call returns `AKIA_<n>`, recording the options of each call. */
const countingProvider = () => {
  const calls: Array<{ readonly forceRefresh?: boolean } | undefined> = []
  const provider = async (options?: { readonly forceRefresh?: boolean }) => {
    calls.push(options)
    return { accessKeyId: `AKIA_${calls.length}`, secretAccessKey: "secret", sessionToken: "provider-token" }
  }
  return { calls, provider }
}

const converse = Effect.gen(function*() {
  const client = yield* AmazonBedrockClient.AmazonBedrockClient
  return yield* client.converse({ payload })
})

const converseStream = Stream.unwrap(Effect.gen(function*() {
  const client = yield* AmazonBedrockClient.AmazonBedrockClient
  return client.converseStream({ payload })
}))

const reasonOf = (error: AiError.AiError) => error.reason

describe("AmazonBedrockClient", () => {
  describe("apiKey", () => {
    it.effect("sends the key as a bearer token instead of a SigV4 signature", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const response = yield* converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({ apiKey: Redacted.make("bedrock-api-key") }).pipe(Layer.provide(http.layer))
          )
        )
        assert.strictEqual(response.stopReason, "end_turn")
        assert.strictEqual(http.requests[0]?.headers["authorization"], "Bearer bedrock-api-key")
        assert.strictEqual(http.requests[0]?.headers["x-amz-date"], undefined)
      }))

    it.effect("reads the key from a Config in layerConfig", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        yield* converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layerConfig({
              region: Config.String("AWS_REGION"),
              apiKey: Config.Redacted("AWS_BEARER_TOKEN_BEDROCK")
            }).pipe(
              Layer.provide(http.layer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
                AWS_REGION: "eu-west-1",
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key"
              })))
            )
          )
        )
        assert.strictEqual(http.requests[0]?.headers["authorization"], "Bearer bedrock-api-key")
        assert.strictEqual(
          http.requests[0]?.url,
          "https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.test.model-v1:0/converse"
        )
      }))

    it.effect("is redacted in the request headers of an AiError", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([accessDenied])
        const error = yield* Effect.flip(converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({ apiKey: Redacted.make("bedrock-api-key") }).pipe(Layer.provide(http.layer))
          )
        ))
        const reason = reasonOf(error)
        assert.strictEqual(reason._tag, "AuthenticationError")
        if (reason._tag === "AuthenticationError") {
          assert.strictEqual(String(reason.http?.request.headers["authorization"]), "<redacted>")
        }
      }))
  })

  describe("static keys", () => {
    it.effect("reads the keys from Configs in layerConfig", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        yield* converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layerConfig({
              accessKeyId: Config.String("AWS_ACCESS_KEY_ID"),
              secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY"),
              sessionToken: Config.Redacted("AWS_SESSION_TOKEN")
            }).pipe(
              Layer.provide(http.layer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
                AWS_ACCESS_KEY_ID: "AKIA_CONFIG",
                AWS_SECRET_ACCESS_KEY: "secret",
                AWS_SESSION_TOKEN: "config-token"
              })))
            )
          )
        )
        assert.strictEqual(signedWith(http.requests[0]!), "AKIA_CONFIG")
        assert.strictEqual(http.requests[0]?.headers["x-amz-security-token"], "config-token")
      }))
  })

  describe("credentialProvider", () => {
    it.effect("signs with the credentials of the provider", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const { provider } = countingProvider()
        yield* converse.pipe(
          Effect.provide(AmazonBedrockClient.layer({ credentialProvider: provider }).pipe(Layer.provide(http.layer)))
        )
        assert.strictEqual(signedWith(http.requests[0]!), "AKIA_1")
        assert.strictEqual(http.requests[0]?.headers["x-amz-security-token"], "provider-token")
      }))

    it.effect("fails with an AuthenticationError of kind Unknown when the promise rejects", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const error = yield* Effect.flip(converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({
              credentialProvider: () => Promise.reject(new Error("Could not load credentials from any providers"))
            }).pipe(Layer.provide(http.layer))
          )
        ))
        assert.strictEqual(error.module, "AmazonBedrockClient")
        assert.strictEqual(error.method, "converse")
        const reason = reasonOf(error)
        assert.instanceOf(reason, AiError.AuthenticationError)
        assert.strictEqual(reason.kind, "Unknown")
        assert.strictEqual(
          reason.description,
          "The credential provider failed: Could not load credentials from any providers"
        )
        assert.strictEqual(http.requests.length, 0)
      }))

    it.effect("fails with an AuthenticationError of kind MissingKey when the keys are empty", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const error = yield* Effect.flip(converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({
              credentialProvider: async () => ({ accessKeyId: "AKIA_EMPTY", secretAccessKey: "" })
            }).pipe(Layer.provide(http.layer))
          )
        ))
        const reason = reasonOf(error)
        assert.instanceOf(reason, AiError.AuthenticationError)
        assert.strictEqual(reason.kind, "MissingKey")
        assert.strictEqual(http.requests.length, 0)
      }))

    it.effect("wraps an AiError reason from an Effect provider in an AiError", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const networkError = new AiError.NetworkError({
          reason: "TransportError",
          description: "vault unreachable",
          request: { method: "GET", url: "https://vault.example.com", urlParams: [], hash: undefined, headers: {} }
        })
        const error = yield* Effect.flip(converseStream.pipe(
          Stream.runDrain,
          Effect.provide(
            AmazonBedrockClient.layer({ credentialProvider: Effect.fail(networkError) }).pipe(Layer.provide(http.layer))
          )
        ))
        assert.strictEqual(error.module, "AmazonBedrockClient")
        assert.strictEqual(error.method, "converseStream")
        assert.strictEqual(error.reason, networkError)
      }))

    it.effect("passes an AiError from an Effect provider through", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        const vaultError = AiError.make({
          module: "Vault",
          method: "load",
          reason: new AiError.AuthenticationError({ kind: "InvalidKey", description: "vault token revoked" })
        })
        const error = yield* Effect.flip(converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({ credentialProvider: Effect.fail(vaultError) }).pipe(Layer.provide(http.layer))
          )
        ))
        assert.strictEqual(error, vaultError)
      }))

    it.effect("runs an Effect provider with the services given to the layer", () =>
      Effect.gen(function*() {
        class Vault extends Context.Service<Vault, { readonly accessKeyId: string }>()("Vault") {}
        const http = stubHttpClient([ok])
        const layer = AmazonBedrockClient.layer({
          credentialProvider: Effect.gen(function*() {
            const vault = yield* Vault
            return { accessKeyId: vault.accessKeyId, secretAccessKey: "secret" }
          })
        }).pipe(Layer.provide(http.layer), Layer.provide(Layer.succeed(Vault, { accessKeyId: "AKIA_VAULT" })))
        // The provider first runs during the request, whose fiber has no Vault.
        yield* converse.pipe(Effect.provide(layer))
        assert.strictEqual(signedWith(http.requests[0]!), "AKIA_VAULT")
      }))

    it.effect("refetches with forceRefresh after Bedrock rejects the credentials as expired", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([expiredToken, ok])
        const { calls, provider } = countingProvider()
        yield* Effect.gen(function*() {
          const error = yield* Effect.flip(converse)
          const reason = reasonOf(error)
          assert.instanceOf(reason, AiError.AuthenticationError)
          assert.strictEqual(reason.kind, "ExpiredKey")
          yield* converse
        }).pipe(
          Effect.provide(AmazonBedrockClient.layer({ credentialProvider: provider }).pipe(Layer.provide(http.layer)))
        )
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_2"])
        assert.deepStrictEqual(calls, [undefined, { forceRefresh: true }])
      }))

    it.effect("refetches after a streamed request is rejected as expired", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([expiredToken, { status: 200, stream: true }])
        const { calls, provider } = countingProvider()
        yield* Effect.gen(function*() {
          yield* Effect.flip(Stream.runDrain(converseStream))
          yield* Stream.runDrain(converseStream)
        }).pipe(
          Effect.provide(AmazonBedrockClient.layer({ credentialProvider: provider }).pipe(Layer.provide(http.layer)))
        )
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_2"])
        assert.deepStrictEqual(calls, [undefined, { forceRefresh: true }])
      }))

    it.effect("keeps the credentials after an AccessDeniedException", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([accessDenied, ok])
        const { calls, provider } = countingProvider()
        yield* Effect.gen(function*() {
          yield* Effect.flip(converse)
          yield* converse
        }).pipe(
          Effect.provide(AmazonBedrockClient.layer({ credentialProvider: provider }).pipe(Layer.provide(http.layer)))
        )
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_1"])
        assert.deepStrictEqual(calls, [undefined])
      }))
  })

  describe("a retry policy", () => {
    const retry = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
      HttpClient.retryTransient(client, { times: 2, retryOn: "errors-and-responses" })

    it.effect("in transformClient signs each attempt with the provider's credentials", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([{ status: 503, body: { message: "unavailable" } }, ok])
        const { calls, provider } = countingProvider()
        const response = yield* converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({ credentialProvider: provider, transformClient: retry }).pipe(
              Layer.provide(http.layer)
            )
          )
        )
        assert.strictEqual(response.stopReason, "end_turn")
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_1"])
        assert.strictEqual(calls.length, 1)
      }))

    it.effect("in transformClient signs each attempt of a stream with the provider's credentials", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([{ status: 503, body: { message: "unavailable" } }, { status: 200, stream: true }])
        const { provider } = countingProvider()
        const events = yield* Stream.runCollect(converseStream).pipe(
          Effect.provide(
            AmazonBedrockClient.layer({ credentialProvider: provider, transformClient: retry }).pipe(
              Layer.provide(http.layer)
            )
          )
        )
        assert.strictEqual(events.length, 6)
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_1"])
      }))

    it.effect("in AmazonBedrockConfig.withClientTransform signs each attempt with the provider's credentials", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([{ status: 503, body: { message: "unavailable" } }, ok])
        const { provider } = countingProvider()
        yield* converse.pipe(
          AmazonBedrockConfig.withClientTransform(HttpClient.retryTransient({ times: 2 })),
          Effect.provide(AmazonBedrockClient.layer({ credentialProvider: provider }).pipe(Layer.provide(http.layer)))
        )
        assert.deepStrictEqual(http.requests.map(signedWith), ["AKIA_1", "AKIA_1"])
      }))

    it.effect("does not retry a failing provider", () =>
      Effect.gen(function*() {
        const http = stubHttpClient([ok])
        let calls = 0
        yield* Effect.flip(converse.pipe(
          Effect.provide(
            AmazonBedrockClient.layer({
              credentialProvider: () => {
                calls++
                return Promise.reject(new Error("no credentials"))
              },
              transformClient: retry
            }).pipe(Layer.provide(http.layer))
          )
        ))
        assert.strictEqual(calls, 1)
        assert.strictEqual(http.requests.length, 0)
      }))
  })
})
