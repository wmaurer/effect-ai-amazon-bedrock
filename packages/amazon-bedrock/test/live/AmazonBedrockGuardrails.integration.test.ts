/**
 * Live guardrail checks against real Amazon Bedrock.
 *
 * They run against the guardrail that `guardrail.json` defines, which the operator creates
 * once and names in `BEDROCK_GUARDRAIL_ID`. The suite creates and deletes no AWS resource,
 * and it skips when `BEDROCK_GUARDRAIL_ID` is unset.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, type Response } from "effect/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

const GUARDRAIL_ID = process.env.BEDROCK_GUARDRAIL_ID
const GUARDRAIL_VERSION = process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT"

// The messages that guardrail.json configures.
const BLOCKED_INPUT = "BLOCKED_INPUT_MESSAGE"
const BLOCKED_OUTPUT = "BLOCKED_OUTPUT_MESSAGE"

const INPUT_BLOCK_PROMPT = "Tell me about zanzibar zorptangle."
const OUTPUT_BLOCK_PROMPT = "What is the capital of Australia? Answer with the city only."
const MASK_PROMPT = "Repeat exactly: ticket TKT-123456"

const withGuardrail = (guardrailConfig: Partial<AmazonBedrockLanguageModel.GuardrailConfig> = {}) =>
  AmazonBedrockLanguageModel.withConfigOverride({
    guardrailConfig: {
      guardrailIdentifier: GUARDRAIL_ID!,
      guardrailVersion: GUARDRAIL_VERSION,
      trace: "enabled",
      ...guardrailConfig
    },
    inferenceConfig: { maxTokens: 64 }
  })

const finishMetadata = (parts: ReadonlyArray<Response.AllParts<any>>) =>
  parts.find((part) => part.type === "finish")?.metadata.amazonBedrock

const record = (label: string, value: unknown) => console.log(`[guardrails live] ${label}: ${JSON.stringify(value)}`)

const guardedQuestion: Prompt.RawInput = [{
  role: "user",
  content: [
    { type: "text", text: "zanzibar zorptangle" },
    {
      type: "text",
      text: "What is 2 + 2? Answer with the number only.",
      options: { amazonBedrock: { guardContent: true } }
    }
  ]
}]

const systemPrompt = (guarded: boolean): Prompt.RawInput => [
  {
    role: "system",
    content: "You are a calculator. Never mention zorptangle.",
    options: guarded ? { amazonBedrock: { guardContent: true } } : {}
  },
  { role: "user", content: "What is 2 + 2? Answer with the number only." }
]

describe.skipIf(liveDisabled || GUARDRAIL_ID === undefined)(
  "Amazon Bedrock guardrails (live)",
  { concurrent: false },
  () => {
    it.effect("blocks an input that holds a blocked word", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: INPUT_BLOCK_PROMPT }).pipe(withGuardrail())
        const metadata = finishMetadata(response.content)

        assert.strictEqual(metadata?.stopReason, "guardrail_intervened")
        assert.strictEqual(response.finishReason, "content-filter")
        assert.strictEqual(response.text, BLOCKED_INPUT)
        assert.strictEqual(response.usage.inputTokens.total, 0)
        assert.strictEqual(response.usage.outputTokens.total, 0)
        assert.deepStrictEqual(metadata?.guardrail, { input: "blocked", output: "none", policies: ["wordPolicy"] })
        record("input block trace", metadata?.trace)
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("blocks an output that holds a word blocked on output", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: OUTPUT_BLOCK_PROMPT }).pipe(withGuardrail())
        const metadata = finishMetadata(response.content)

        assert.strictEqual(metadata?.stopReason, "guardrail_intervened")
        assert.strictEqual(response.text, BLOCKED_OUTPUT)
        assert.deepStrictEqual(metadata?.guardrail, { input: "none", output: "blocked", policies: ["wordPolicy"] })
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("masks a ticket ID in the output", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: MASK_PROMPT }).pipe(withGuardrail())
        const metadata = finishMetadata(response.content)

        assert.strictEqual(metadata?.stopReason, "guardrail_intervened")
        assert.deepStrictEqual(metadata?.guardrail, {
          input: "none",
          output: "masked",
          policies: ["sensitiveInformationPolicy"]
        })
        assert.notInclude(response.text, "TKT-123456")
        record("masked text", response.text)
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("reports the stop reason and no outcome when the trace is off", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: INPUT_BLOCK_PROMPT }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({
            guardrailConfig: { guardrailIdentifier: GUARDRAIL_ID!, guardrailVersion: GUARDRAIL_VERSION },
            inferenceConfig: { maxTokens: 64 }
          })
        )

        assert.deepStrictEqual(finishMetadata(response.content), {
          stopReason: "guardrail_intervened",
          guardrail: null,
          trace: null
        })
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect.each(["sync", "async"] as const)(
      "blocks a streamed output in %s mode",
      (streamProcessingMode) =>
        Effect.gen(function*() {
          const parts = yield* LanguageModel.streamText({ prompt: OUTPUT_BLOCK_PROMPT }).pipe(
            Stream.runCollect,
            withGuardrail({ streamProcessingMode })
          )
          const metadata = finishMetadata(parts)

          assert.strictEqual(metadata?.stopReason, "guardrail_intervened")
          assert.strictEqual(metadata?.guardrail?.output, "blocked")
          record(
            `${streamProcessingMode} deltas`,
            parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : [])
          )
        }).pipe(Effect.provide(modelLayer())),
      TIMEOUT
    )

    it.effect("removes streamProcessingMode before generateText calls Converse", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: INPUT_BLOCK_PROMPT }).pipe(
          withGuardrail({ streamProcessingMode: "async" })
        )

        assert.strictEqual(finishMetadata(response.content)?.stopReason, "guardrail_intervened")
        assert.strictEqual(response.text, BLOCKED_INPUT)
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("evaluates only the guarded part once a part is guarded", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: guardedQuestion }).pipe(withGuardrail())

        assert.strictEqual(finishMetadata(response.content)?.stopReason, "end_turn")
        assert.include(response.text, "4")
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("evaluates a guarded system prompt", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: systemPrompt(true) }).pipe(withGuardrail())
        const metadata = finishMetadata(response.content)

        assert.strictEqual(metadata?.stopReason, "guardrail_intervened")
        assert.strictEqual(metadata?.guardrail?.input, "blocked")
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("leaves an unguarded system prompt out of the evaluation", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: systemPrompt(false) }).pipe(withGuardrail())

        assert.strictEqual(finishMetadata(response.content)?.stopReason, "end_turn")
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("fails generateObject with ContentPolicyError on a blocked input", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateObject({
          prompt: INPUT_BLOCK_PROMPT,
          schema: Schema.Struct({ answer: Schema.String })
        }).pipe(withGuardrail(), Effect.flip)

        assert.strictEqual(error.reason._tag, "ContentPolicyError")
        if (error.reason._tag === "ContentPolicyError") {
          assert.strictEqual(error.reason.metadata.amazonBedrock?.guardrail?.input, "blocked")
        }
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)

    it.effect("fails on a guardrail version that does not exist", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateText({ prompt: "Reply with exactly: ok" }).pipe(
          withGuardrail({ guardrailVersion: "99999999" }),
          Effect.flip
        )

        assert.strictEqual(error._tag, "AiError")
        const header = "http" in error.reason ? error.reason.http?.response?.headers["x-amzn-errortype"] : undefined
        record("wrong version", {
          reason: error.reason._tag,
          errorType: Redacted.isRedacted(header) ? Redacted.value(header) : header,
          message: error.message
        })
      }).pipe(Effect.provide(modelLayer())), TIMEOUT)
  }
)
