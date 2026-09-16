/**
 * Live extended-thinking checks against real Amazon Bedrock.
 *
 * These exist to close the three reasoning gaps recorded under "Verification gaps" in the
 * repo-root TODO.md. Every reasoning path in this package was stub-only, because enabling
 * extended thinking on an Anthropic model needs `additionalModelRequestFields`, which
 * `ConverseRequest` did not model. With the field in place these run for real: the
 * `reasoningContent` decode, the `signature` that accompanies it, the signed send-back in a
 * later turn, and reasoning deltas over the event stream.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

/**
 * The payload that switches extended thinking on for an Anthropic model behind Converse.
 *
 * The spelling is the point of this suite. TODO.md recorded `reasoning_config` with
 * `{ type, budget_tokens }` from the AWS documentation; the AI SDK's own Bedrock provider
 * sends `thinking`, the direct Anthropic API spelling. Only Bedrock settles it, and these
 * tests are what asked.
 *
 * `budget_tokens` must be at least 1024, and `inferenceConfig.maxTokens` must exceed it —
 * the budget is drawn from the same ceiling as the visible answer, so a maxTokens at or
 * below the budget leaves no room to reply and Converse rejects the request.
 */
const THINKING_BUDGET = 1024
const MAX_TOKENS = 4096

const reasoningConfig = {
  additionalModelRequestFields: {
    thinking: { type: "enabled", budget_tokens: THINKING_BUDGET }
  },
  inferenceConfig: { maxTokens: MAX_TOKENS }
} as const

/** A question the model cannot answer without working through it first. */
const PROMPT = "A rope burns unevenly end to end in exactly 60 minutes. " +
  "Using two such ropes, how do you measure 45 minutes? Think it through, then answer."

describe.skipIf(liveDisabled)("Amazon Bedrock reasoning (live)", { sequential: true }, () => {
  it.effect("returns a signed reasoning part when extended thinking is enabled", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({ prompt: PROMPT }).pipe(
        AmazonBedrockLanguageModel.withConfigOverride(reasoningConfig)
      )

      const reasoning = response.content.filter((part) => part.type === "reasoning")
      assert.isAtLeast(reasoning.length, 1, "expected at least one reasoning part")

      const first = reasoning[0]!
      assert.isAtLeast(first.text.trim().length, 1, "expected reasoning text")

      // The signature is what lets the block be sent back in a later turn. A stub can
      // assert its shape; only Bedrock proves one actually arrives.
      const info = first.metadata?.amazonBedrock?.info
      assert.isDefined(info, "expected amazonBedrock reasoning metadata")
      assert.strictEqual(info!.type, "reasoningText")
      assert.isString((info as { signature: string | null }).signature)
      assert.isAtLeast((info as { signature: string }).signature.length, 1)

      // Thinking tokens are billed as output tokens.
      assert.isAtLeast(response.usage.outputTokens.total ?? 0, THINKING_BUDGET / 2)
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("accepts a signed reasoning block sent back in a later turn", () =>
    Effect.gen(function*() {
      const first = yield* LanguageModel.generateText({ prompt: PROMPT }).pipe(
        AmazonBedrockLanguageModel.withConfigOverride(reasoningConfig)
      )

      const reasoning = first.content.find((part) => part.type === "reasoning")
      assert.isDefined(reasoning, "expected a reasoning part to send back")
      const text = first.content.find((part) => part.type === "text")
      assert.isDefined(text, "expected an answer to send back")

      const info = reasoning!.metadata?.amazonBedrock?.info
      assert.isDefined(info, "expected the reasoning part to carry its Bedrock identity")

      // Rebuild the assistant turn exactly as it came back, signature and all, and continue
      // the conversation. Converse validates the signature server-side, so a request it
      // accepts is proof the round-trip is faithful — the pairing no stub can check.
      const prompt = Prompt.fromMessages([
        Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: PROMPT })] }),
        Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("reasoning", {
              text: reasoning!.text,
              options: { amazonBedrock: { info: info! } }
            }),
            Prompt.makePart("text", { text: text!.text })
          ]
        }),
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "In one sentence, how confident are you?" })]
        })
      ])

      const second = yield* LanguageModel.generateText({ prompt }).pipe(
        AmazonBedrockLanguageModel.withConfigOverride(reasoningConfig)
      )
      assert.isAtLeast(second.text.trim().length, 1)
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("streams reasoning deltas and a signature over the event stream", () =>
    Effect.gen(function*() {
      const parts = yield* LanguageModel.streamText({ prompt: PROMPT }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => globalThis.Array.from(chunk)),
        AmazonBedrockLanguageModel.withConfigOverride(reasoningConfig)
      )

      const deltas = parts.filter((part) => part.type === "reasoning-delta")
      assert.isAtLeast(deltas.length, 1, "expected reasoning deltas over the stream")

      const reasoningText = deltas.map((part) => part.delta).join("")
      assert.isAtLeast(reasoningText.trim().length, 1)

      // Converse streams the signature as its own delta after the reasoning text, so it
      // arrives as metadata on a delta carrying no text of its own.
      const signed = deltas.find((part) => {
        const info = part.metadata?.amazonBedrock?.info
        return info?.type === "reasoningText" && typeof info.signature === "string"
      })
      assert.isDefined(signed, "expected a delta carrying the reasoning signature")

      // Reasoning must still be followed by a visible answer and a normal finish.
      assert.isTrue(parts.some((part) => part.type === "text-delta"))
      const finish = parts[parts.length - 1]!
      assert.strictEqual(finish.type, "finish")
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)
})
