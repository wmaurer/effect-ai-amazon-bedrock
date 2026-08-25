/**
 * Live non-streaming checks against real Amazon Bedrock.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { assertDisjointUsage, captureRawUsage, liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

describe.skipIf(liveDisabled)("Amazon Bedrock (live)", () => {
  it.effect("generateText round-trips against the Converse API", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({ prompt: "Reply with exactly: ok" })
      assert.isAtLeast(response.text.trim().length, 1)
      assert.isAtLeast(response.usage.outputTokens.total ?? 0, 1)
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("generateObject decodes a forced tool call into the schema", () =>
    Effect.gen(function*() {
      const Finding = Schema.Struct({
        severity: Schema.Literals(["low", "medium", "high"]),
        summary: Schema.String
      })
      const response = yield* LanguageModel.generateObject({
        schema: Finding,
        objectName: "Finding",
        prompt: "A null pointer dereference crashes the server on every request. Classify it."
      })
      // Decoding already proved the shape; assert the model filled it rather than
      // returning an empty string that happens to satisfy Schema.String.
      assert.include(["low", "medium", "high"], response.value.severity)
      assert.isAtLeast(response.value.summary.length, 1)
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  describe("cachePoint", () => {
    /**
     * Sonnet 4.5 needs >= 1024 tokens per checkpoint. The nonce makes the prefix unique per
     * run so the first call is always a genuine cache write — a warm 5-minute cache from an
     * earlier run would otherwise turn it into a read and leave `cacheWriteInputTokens` at
     * zero, which is exactly the case that made the old smoke script's oracle vacuous.
     */
    const prefixFor = (nonce: string) =>
      Array.from(
        { length: 1200 },
        (_, i) => `Rule ${i} (${nonce}): prefer explicit failure over silent fallback.`
      ).join("\n")

    const cachedPrompt = (nonce: string, question: string) =>
      Prompt.fromMessages([
        Prompt.makeMessage("system", {
          content: prefixFor(nonce),
          // 5m and 1h bill cache writes at different rates ($3.75 vs $6.00 per 1M against a
          // $3.00 input rate), so the TTL is pinned rather than left to Bedrock's default.
          options: { amazonBedrock: { cachePoint: { type: "default", ttl: "5m" } } }
        }),
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: question })]
        })
      ])

    it.effect("writes then reads a cache checkpoint, and reports usage disjointly", () =>
      Effect.gen(function*() {
        const { transform, usages } = captureRawUsage()
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const layer = modelLayer(transform)

        yield* LanguageModel.generateText({ prompt: cachedPrompt(nonce, "Say A.") })
          .pipe(Effect.provide(layer))
        yield* LanguageModel.generateText({ prompt: cachedPrompt(nonce, "Say B.") })
          .pipe(Effect.provide(layer))

        assert.strictEqual(usages.length, 2)
        const [write, read] = usages as [Record<string, number>, Record<string, number>]

        assert.isAbove(write.cacheWriteInputTokens ?? 0, 0, "first call should write the cache")
        assert.isAbove(read.cacheReadInputTokens ?? 0, 0, "second call should read the cache")

        // Both sides, deliberately. The old smoke script checked only the read call, where
        // cacheWriteInputTokens was 0 — so the write term contributed nothing and the
        // equation held whether writes were disjoint or inclusive.
        assertDisjointUsage(assert, write)
        assertDisjointUsage(assert, read)
      }), TIMEOUT)
  })
})
