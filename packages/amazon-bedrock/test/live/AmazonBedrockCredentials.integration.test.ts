/**
 * Live checks of the two ways to authenticate that 0.2.0 added: a credential provider and a
 * Bedrock API key.
 *
 * The unit tests prove what the client sends. Only AWS can say whether it accepts it: a SigV4
 * signature from credentials that a provider returned, a refetch after AWS rejected the first
 * credentials, and a bearer token in place of a signature.
 *
 * The API key is a short-term key that the test makes from the same STS credentials, the way
 * `@aws/bedrock-token-generator` does, so the run needs no key from the console. The
 * credentials need `bedrock:CallWithBearerToken` on top of the permissions in ./README.md.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { AwsV4Signer } from "aws4fetch"
import { Effect, Layer, Redacted, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { liveDisabled, MODEL, REGION } from "./helpers.ts"

const TIMEOUT = 60_000

const environmentCredentials = (): AmazonBedrockClient.Credentials => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  expiration: process.env.AWS_CREDENTIAL_EXPIRATION === undefined
    ? undefined
    : new Date(process.env.AWS_CREDENTIAL_EXPIRATION)
})

const providerLayer = <R = never>(credentialProvider: AmazonBedrockClient.CredentialProvider<R>) =>
  AmazonBedrockLanguageModel.layer({ model: MODEL }).pipe(
    Layer.provide(AmazonBedrockClient.layer({ region: REGION, credentialProvider })),
    Layer.provide(FetchHttpClient.layer)
  )

const apiKeyLayer = (apiKey: string) =>
  AmazonBedrockLanguageModel.layer({ model: MODEL }).pipe(
    Layer.provide(AmazonBedrockClient.layer({ region: REGION, apiKey: Redacted.make(apiKey) })),
    Layer.provide(FetchHttpClient.layer)
  )

/**
 * A short-term Bedrock API key: a SigV4-presigned `CallWithBearerToken` URL without its
 * scheme, with `&Version=1` appended, in base64 behind the `bedrock-api-key-` prefix. This is
 * `createToken` of `@aws/bedrock-token-generator` 1.1.0, with aws4fetch as the signer.
 */
const shortTermApiKey = Effect.promise(async () => {
  const credentials = environmentCredentials()
  const signer = new AwsV4Signer({
    service: "bedrock",
    region: REGION,
    method: "POST",
    url: "https://bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Expires=900",
    body: "",
    signQuery: true,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {})
  })
  const { url } = await signer.sign()
  const token = `${url.toString().replace("https://", "")}&Version=1`
  return `bedrock-api-key-${Buffer.from(token, "utf-8").toString("base64")}`
})

const reply = LanguageModel.generateText({ prompt: "Reply with exactly: ok" })

describe.skipIf(liveDisabled)("Amazon Bedrock credentials (live)", { concurrent: false }, () => {
  it.effect("signs with the credentials of a function provider and keeps them", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly forceRefresh?: boolean } | undefined> = []
      const layer = providerLayer(async (options?: { readonly forceRefresh?: boolean }) => {
        calls.push(options)
        return environmentCredentials()
      })

      const [first, second] = yield* Effect.all([reply, reply]).pipe(Effect.provide(layer))

      assert.match(first.text, /ok/i)
      assert.match(second.text, /ok/i)
      assert.deepStrictEqual(calls, [undefined])
    }), TIMEOUT)

  it.effect("signs a stream with the credentials of an Effect provider", () =>
    Effect.gen(function*() {
      const parts = yield* LanguageModel.streamText({ prompt: "Reply with exactly: ok" }).pipe(
        Stream.runCollect,
        Effect.provide(providerLayer(Effect.sync(environmentCredentials)))
      )

      const text = parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []).join("")
      assert.match(text, /ok/i)
    }), TIMEOUT)

  it.effect(
    "asks the provider again with forceRefresh after AWS rejects its credentials",
    () =>
      Effect.gen(function*() {
        const calls: Array<{ readonly forceRefresh?: boolean } | undefined> = []
        const layer = providerLayer(async (options?: { readonly forceRefresh?: boolean }) => {
          calls.push(options)
          return calls.length === 1
            // A real key id with the wrong secret, which AWS rejects at the signature check.
            ? { ...environmentCredentials(), secretAccessKey: "wJalrXUtnFEMIbadK7MDENGbPxRfiCYEXAMPLEKEY" }
            : environmentCredentials()
        })

        const [rejected, accepted] = yield* Effect.gen(function*() {
          return [yield* Effect.flip(reply), yield* reply] as const
        }).pipe(Effect.provide(layer))

        assert.instanceOf(rejected, AiError.AiError)
        assert.strictEqual(rejected.reason._tag, "AuthenticationError")
        assert.strictEqual((rejected.reason as typeof AiError.AuthenticationError.Type).kind, "InvalidKey")
        assert.match(accepted.text, /ok/i)
        assert.deepStrictEqual(calls, [undefined, { forceRefresh: true }])
      }),
    TIMEOUT
  )

  it.effect("authenticates with a short-term Bedrock API key", () =>
    Effect.gen(function*() {
      const apiKey = yield* shortTermApiKey

      const response = yield* reply.pipe(Effect.provide(apiKeyLayer(apiKey)))

      assert.match(response.text, /ok/i)
    }), TIMEOUT)

  it.effect("classifies an API key that AWS does not accept", () =>
    Effect.gen(function*() {
      const apiKey = yield* shortTermApiKey
      // The signature is the last query parameter of the URL in the key, so changing its last
      // hex digit before `&Version=1` keeps the key well formed.
      const decoded = Buffer.from(apiKey.slice("bedrock-api-key-".length), "base64").toString("utf-8")
      const tampered = decoded.replace(/([0-9a-f])&Version=1$/, (_, digit) => `${digit === "0" ? "1" : "0"}&Version=1`)
      assert.notStrictEqual(tampered, decoded)

      const error = yield* Effect.flip(
        reply.pipe(
          Effect.provide(apiKeyLayer(`bedrock-api-key-${Buffer.from(tampered, "utf-8").toString("base64")}`))
        )
      )

      assert.instanceOf(error, AiError.AiError)
      assert.strictEqual(error.reason._tag, "AuthenticationError")
      const reason = error.reason as typeof AiError.AuthenticationError.Type
      assert.isTrue(Redacted.isRedacted(reason.http?.request.headers["authorization"]))
      // AWS answers a key it does not accept as it answers a missing IAM permission, so the
      // client cannot tell the two apart. Observed on 2026-10-17 in eu-west-1.
      assert.strictEqual(reason.kind, "InsufficientPermissions")
      const errorType = reason.http?.response?.headers["x-amzn-errortype"]
      assert.strictEqual(
        (Redacted.isRedacted(errorType) ? Redacted.value(errorType) : errorType)?.split(":")[0],
        "AccessDeniedException"
      )
    }), TIMEOUT)
})
