/**
 * Live checks that a tool call can be answered and sent back to Converse.
 *
 * The streaming suite proves Bedrock *emits* a tool call; nothing until now closed the
 * loop. The encode side — a `toolResult` block carrying a `toolUseId` that Converse
 * matches against the preceding `toolUse` — was covered only by stubs, and Converse
 * validates that pairing itself: a `toolResult` whose id, position or surrounding
 * `toolConfig` is wrong is a `ValidationException`, which no stubbed test can see.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

describe.skipIf(liveDisabled)("Amazon Bedrock tool results (live)", { sequential: true }, () => {
  it.effect("sends a tool result back and gets an answer built from it", () =>
    Effect.gen(function*() {
      const GetTemperature = Tool.make("get_temperature", {
        description: "Look up the current temperature in a city, in degrees celsius",
        parameters: Schema.Struct({ city: Schema.String }),
        success: Schema.Struct({ celsius: Schema.Number })
      })
      const toolkit = Toolkit.make(GetTemperature)
      // A value the model cannot plausibly invent for Zurich, so the second answer can
      // only come from the tool result actually reaching Converse.
      const handlers = toolkit.toLayer({ get_temperature: () => Effect.succeed({ celsius: 41 }) })

      const question = "What is the temperature in Zurich right now? Use get_temperature."

      const first = yield* LanguageModel.generateText({ prompt: question, toolkit })
        .pipe(Effect.provide(handlers))

      // Pins the non-streaming `tool_use` stop reason as well: every live call so far
      // ended in `end_turn`, so this is the second of the nine mapped reasons observed.
      assert.strictEqual(first.finishReason, "tool-calls")
      const call = first.content.find((part) => part.type === "tool-call")
      assert.isDefined(call, "the model should have called get_temperature")

      const second = yield* LanguageModel.generateText({
        // `fromResponseParts` turns the response into an assistant message holding the
        // `toolUse` and a tool message holding the result. The toolkit is passed again
        // because Converse rejects a conversation containing tool blocks unless the
        // request also carries `toolConfig`.
        prompt: Prompt.concat(Prompt.make(question), Prompt.fromResponseParts(first.content)),
        toolkit
      }).pipe(Effect.provide(handlers))

      assert.include(second.text, "41")
    }).pipe(
      Effect.provide(modelLayer())
    ), TIMEOUT)
})
