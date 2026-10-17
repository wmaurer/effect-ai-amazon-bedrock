/**
 * Probes which calls each Bedrock model accepts through this provider, and prints one row per
 * model and call. It makes real Bedrock calls, five per model, so it costs money.
 *
 * Run it from the repository root with the model IDs as arguments:
 *
 *   node packages/amazon-bedrock/test/live/probe-models.ts eu.amazon.nova-pro-v1:0 mistral.mistral-large-2402-v1:0
 *
 * The calls are the ones `docs/TODO.md` names for models from other providers: `text` is a
 * plain `generateText`, `stream-tool` is a `streamText` that should call a tool, and the three
 * `object-*` rows are `generateObject` on each path `getModelCapabilities` can pick: `native`
 * sends `outputConfig.textFormat`, `forced` sends an object tool with `toolChoice.tool`, and
 * `unforced` sends it with `toolChoice.auto`.
 */
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Cause, Duration, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"

const region = process.env.AWS_REGION ?? "eu-west-1"
const models = process.argv.slice(2)
if (models.length === 0) {
  console.error("usage: node probe-models.ts <model id>...")
  process.exit(2)
}

const client = AmazonBedrockClient.layer({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: Redacted.make(process.env.AWS_SECRET_ACCESS_KEY!),
  sessionToken: process.env.AWS_SESSION_TOKEN === undefined ? undefined : Redacted.make(process.env.AWS_SESSION_TOKEN),
  region
}).pipe(Layer.provide(FetchHttpClient.layer))

const GetTemperature = Tool.make("get_temperature", {
  description: "Look up the current temperature in a city, in degrees celsius",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ celsius: Schema.Number })
})
const toolkit = Toolkit.make(GetTemperature)
const handlers = toolkit.toLayer({ get_temperature: () => Effect.succeed({ celsius: 41 }) })

const Answer = Schema.Struct({ city: Schema.String, sunny: Schema.Boolean })
const objectPrompt = "Zurich is sunny today. Answer with the city and whether it is sunny."

const count = (types: ReadonlyArray<string>) => {
  const counts = new Map<string, number>()
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
  return [...counts].map(([type, n]) => `${type}:${n}`).join(" ")
}

const calls: Record<string, Effect.Effect<string, unknown, LanguageModel.LanguageModel>> = {
  "text": Effect.map(
    LanguageModel.generateText({ prompt: "Reply with the single word: hello" }),
    (r) => `${r.finishReason} ${JSON.stringify(r.text.slice(0, 60))} [${count(r.content.map((p) => p.type))}]`
  ),
  "stream-tool": LanguageModel.streamText({
    prompt: "What is the temperature in Zurich right now? Use get_temperature.",
    toolkit
  }).pipe(
    Stream.runCollect,
    Effect.map((parts) => {
      const finish = parts.find((p) => p.type === "finish")
      const call = parts.find((p) => p.type === "tool-call")
      return `${finish?.reason} ${call === undefined ? "no tool call" : JSON.stringify(call.params)} [${
        count(parts.map((p) => p.type))
      }]`
    }),
    Effect.provide(handlers)
  ),
  "tool-any": LanguageModel.generateText({
    prompt: "What is the temperature in Zurich right now?",
    toolkit,
    toolChoice: "required"
  }).pipe(
    Effect.map((r) => {
      const call = r.content.find((p) => p.type === "tool-call")
      return `${r.finishReason} ${call === undefined ? "no tool call" : JSON.stringify(call.params)}`
    }),
    Effect.provide(handlers)
  ),
  "object-native": LanguageModel.generateObject({ prompt: objectPrompt, schema: Answer }).pipe(
    Effect.map((r) => `${r.finishReason} ${JSON.stringify(r.value)}`),
    AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: true })
  ),
  "object-forced": LanguageModel.generateObject({ prompt: objectPrompt, schema: Answer }).pipe(
    Effect.map((r) => `${r.finishReason} ${JSON.stringify(r.value)}`),
    AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false, forcedToolChoice: true })
  ),
  "object-unforced": LanguageModel.generateObject({ prompt: objectPrompt, schema: Answer }).pipe(
    Effect.map((r) => `${r.finishReason} ${JSON.stringify(r.value)}`),
    AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false, forcedToolChoice: false })
  )
}

const describe = (error: unknown): string => {
  const e = error as { _tag?: string; reason?: { _tag?: string; description?: string }; message?: string }
  const text = e.reason?.description ?? e.message ?? String(error)
  return `${e.reason?._tag ?? e._tag ?? "Error"}: ${text.replace(/\s+/g, " ").slice(0, 300)}`
}

const only = process.env.PROBE_CALLS?.split(",")
const rows = models.flatMap((model) =>
  Object.entries(calls).filter(([name]) => only === undefined || only.includes(name)).map(([name, call]) => ({
    model,
    name,
    call
  }))
)

const program = Effect.forEach(rows, ({ call, model, name }) =>
  call.pipe(
    Effect.timeout(Duration.seconds(90)),
    Effect.map((detail) => `${model}\t${name}\tOK\t${detail}`),
    Effect.catchCause((cause) => Effect.succeed(`${model}\t${name}\tERR\t${describe(Cause.squash(cause))}`)),
    Effect.provide(AmazonBedrockLanguageModel.layer({ model }).pipe(Layer.provide(client))),
    Effect.tap((row) => Effect.sync(() => console.log(row)))
  ), { concurrency: 4 })

Effect.runPromise(program)
