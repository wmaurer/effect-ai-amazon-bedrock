/**
 * Shared setup for the live Amazon Bedrock checks.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

/**
 * Sonnet 4.5 via the EU geo inference profile. The bare foundation-model id is rejected —
 * 4.5 has no in-region support anywhere — so this is the expected path, not a fallback.
 */
export const MODEL = process.env.BEDROCK_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"

export const REGION = process.env.AWS_REGION ?? "eu-west-1"

/**
 * Second guard behind the `.integration.test.ts` filename: without credentials these suites
 * skip rather than fail, so `EFFECT_INTEGRATION_TESTS=1` on a machine with no AWS access
 * still produces a green run.
 */
export const liveDisabled = process.env.AWS_ACCESS_KEY_ID === undefined ||
  process.env.AWS_SECRET_ACCESS_KEY === undefined

const credentials = () => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: Redacted.make(process.env.AWS_SECRET_ACCESS_KEY!),
  // Temporary credentials (`aws login`, `sts assume-role`) are a triple and are rejected
  // without the session token; long-lived IAM user keys are a pair and must not carry one.
  sessionToken: process.env.AWS_SESSION_TOKEN === undefined
    ? undefined
    : Redacted.make(process.env.AWS_SESSION_TOKEN),
  region: REGION
})

/**
 * A model layer that talks to real Bedrock.
 *
 * `transformClient` is optional because the usage-capturing hook below reads the response
 * body eagerly, which would consume a streaming response before the decoder sees it.
 */
export const modelLayer = (
  transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
) =>
  AmazonBedrockLanguageModel.layer({ model: MODEL }).pipe(
    Layer.provide(AmazonBedrockClient.layer({ ...credentials(), transformClient })),
    Layer.provide(FetchHttpClient.layer)
  )

/**
 * Bedrock's own `totalTokens` is decoded and then discarded — nothing in `src/` reads it,
 * so the only way to compare it against the provider's computed total is to intercept the
 * untouched response body on the way through.
 *
 * Returns a fresh array per call: `vitest.config.ts` sets `sequence.concurrent`, so a
 * module-level accumulator would interleave between suites.
 */
export const captureRawUsage = () => {
  const usages: Array<Record<string, number>> = []
  const transform = (client: HttpClient.HttpClient) =>
    HttpClient.transformResponse(
      client,
      Effect.flatMap((response) =>
        Effect.map(response.json, (body) => {
          const usage = (body as any)?.usage
          if (usage !== undefined) usages.push(usage)
          return response
        })
      )
    )
  return { usages, transform } as const
}

/**
 * Bedrock reports `inputTokens` as *disjoint* from the cache buckets, so its own
 * `totalTokens` is the sum of all four. The provider relies on this when it computes
 * `total = inputTokens + cacheRead + cacheWrite`; if Bedrock ever switched to an inclusive
 * `inputTokens`, every cost model built on that total would double-count.
 */
export const assertDisjointUsage = (
  assert: { strictEqual: (a: unknown, b: unknown, msg?: string) => void },
  usage: Record<string, number>
) => {
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  assert.strictEqual(
    usage.totalTokens,
    usage.inputTokens + cacheRead + cacheWrite + usage.outputTokens,
    `totalTokens should be the disjoint sum, got ${JSON.stringify(usage)}`
  )
}
