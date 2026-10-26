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
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

describe.skipIf(liveDisabled)("Amazon Bedrock tool results (live)", { concurrent: false }, () => {
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

  // A prompt with tool history needs `toolConfig`, and Converse has no "none" tool choice. When
  // no tools go out, `generateText` fails before sending and `generateObject` falls back to the
  // object tool. Passing the toolkit with "auto" is the workaround the error names; this checks
  // that Converse accepts it next to native structured output, where the object tool does not
  // supply the `toolConfig`.
  it.effect("generateObject accepts tool history when the toolkit goes out with 'auto'", () =>
    Effect.gen(function*() {
      const ReadFile = Tool.make("readFile", {
        description: "Read a file",
        parameters: Schema.Struct({ path: Schema.String }),
        success: Schema.Struct({ content: Schema.String })
      })
      const toolkit = Toolkit.make(ReadFile)
      const prompt = Prompt.fromMessages([
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "Read a.txt and report whether it says ok." })]
        }),
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("tool-call", {
            id: "toolu_01",
            name: "readFile",
            params: { path: "a.txt" },
            providerExecuted: false
          })]
        }),
        Prompt.makeMessage("tool", {
          content: [Prompt.makePart("tool-result", {
            id: "toolu_01",
            name: "readFile",
            isFailure: false,
            result: { content: "ok" },
            providerExecuted: false
          })]
        }),
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "Answer now, without calling a tool." })]
        })
      ])

      const response = yield* LanguageModel.generateObject({
        prompt,
        objectName: "result",
        schema: Schema.Struct({ ok: Schema.Boolean }),
        toolkit,
        toolChoice: "auto"
      }).pipe(Effect.provide(toolkit.toLayer({ readFile: () => Effect.succeed({ content: "ok" }) })))

      assert.deepStrictEqual(response.value, { ok: true })
    }).pipe(
      Effect.provide(modelLayer())
    ), TIMEOUT)

  // Bedrock is sent the codec's schema, in which `units` is required and nullable and `tags` is a
  // list of key-value pairs. The handler only runs if the provider turns the model's params back
  // into the tool's own shape.
  it.effect("hands the tool handler params in the tool's own shape", () =>
    Effect.gen(function*() {
      const RecordReading = Tool.make("record_reading", {
        description: "Record readings for a city",
        parameters: Schema.Struct({
          city: Schema.String,
          units: Schema.optional(Schema.String),
          tags: Schema.Record(Schema.String, Schema.Number)
        }),
        success: Schema.String
      })
      const toolkit = Toolkit.make(RecordReading)
      const calls: Array<typeof RecordReading.parametersSchema.Type> = []
      const handlers = toolkit.toLayer({
        record_reading: (params) => {
          calls.push(params)
          return Effect.succeed("recorded")
        }
      })

      yield* LanguageModel.generateText({
        prompt: "Call record_reading once for Zurich with the tags population 420000 and altitude 408. " +
          "Give no units.",
        toolkit,
        toolChoice: "required"
      }).pipe(Effect.provide(handlers))

      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0]!.city, "Zurich")
      assert.deepStrictEqual(calls[0]!.tags, { population: 420000, altitude: 408 })
    }).pipe(
      Effect.provide(modelLayer())
    ), TIMEOUT)
})
