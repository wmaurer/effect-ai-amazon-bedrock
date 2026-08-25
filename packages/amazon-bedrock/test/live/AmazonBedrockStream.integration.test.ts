/**
 * Live streaming checks against real Amazon Bedrock.
 *
 * These are the reason this directory exists. `AmazonBedrockEventStream.ts` hand-rolls the
 * `vnd.amazon.eventstream` framing, and `test/utils.ts` hand-builds the frames the unit
 * tests decode — both from the same reading of the AWS spec, so a shared misreading passes
 * both. These decode bytes AWS actually produced.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

/** No usage-capturing hook here: it reads the body eagerly and would consume the stream. */
const collect = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.runCollect, Effect.map((chunk) => globalThis.Array.from(chunk)))

describe.skipIf(liveDisabled)("Amazon Bedrock streaming (live)", () => {
  it.effect("decodes real event-stream frames into incremental text parts", () =>
    Effect.gen(function*() {
      const parts = yield* collect(
        // Long enough that AWS splits the answer over several frames — a single-token reply
        // would decode even if the framing loop mishandled multi-frame payloads.
        LanguageModel.streamText({ prompt: "Count from 1 to 20, separated by spaces." })
      )

      const types = parts.map((part) => part.type)
      assert.include(types, "response-metadata")
      assert.include(types, "text-start")
      assert.include(types, "text-end")
      assert.include(types, "finish")

      const deltas = parts.filter((part) => part.type === "text-delta")
      assert.isAtLeast(deltas.length, 2, "expected the response to arrive over several frames")

      const text = deltas.map((part) => (part as { delta: string }).delta).join("")
      assert.include(text, "20")

      const finish = parts[parts.length - 1]!
      assert.strictEqual(finish.type, "finish")
      if (finish.type === "finish") {
        assert.strictEqual(finish.reason, "stop")
        // The `metadata` frame is the last one AWS sends; usage arriving proves the decoder
        // consumed the stream to the end rather than stopping at `messageStop`.
        assert.isAtLeast(finish.usage.outputTokens.total ?? 0, 1)
      }
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("accumulates a streamed tool call across frames", () =>
    Effect.gen(function*() {
      const GlobTool = Tool.make("GlobTool", {
        description: "Search for files matching a glob pattern",
        parameters: Schema.Struct({ pattern: Schema.String }),
        success: Schema.String
      })
      const toolkit = Toolkit.make(GlobTool)

      const parts = yield* collect(
        LanguageModel.streamText({
          prompt: "Use GlobTool to find every TypeScript file. The pattern is **/*.ts",
          toolkit,
          // Inspect the emitted parts rather than letting the handler swallow them.
          disableToolCallResolution: true
        })
      ).pipe(Effect.provide(toolkit.toLayer({ GlobTool: () => Effect.succeed("found.ts") })))

      const types = parts.map((part) => part.type)
      assert.include(types, "tool-params-start")
      assert.include(types, "tool-params-end")

      // AWS splits the tool input JSON across an arbitrary number of `contentBlockDelta`
      // frames, at positions that need not fall on token or syntax boundaries. This is the
      // accumulation the unit tests can only simulate.
      const toolCall = parts.find((part) => part.type === "tool-call")
      assert.isDefined(toolCall, "the model should have called GlobTool")
      if (toolCall?.type === "tool-call") {
        assert.strictEqual(toolCall.name, "GlobTool")
        assert.isString((toolCall.params as { pattern: string }).pattern)
      }
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)
})
