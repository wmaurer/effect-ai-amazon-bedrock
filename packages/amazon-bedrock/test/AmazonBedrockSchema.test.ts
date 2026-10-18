import { assert, describe, it } from "@effect/vitest"
import { AmazonBedrockSchema } from "@wmaurer/effect-ai-amazon-bedrock"
import { Effect, Schema } from "effect"
import { inputBlockedTrace } from "./utils.ts"

describe("AmazonBedrockSchema", () => {
  it.effect("decodes a toolUse content block", () =>
    Effect.gen(function*() {
      const block = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ContentBlock)({
        toolUse: { toolUseId: "tu_1", name: "GlobTool", input: { pattern: "*.ts" } }
      })
      assert.isDefined(block.toolUse)
      assert.strictEqual(block.toolUse?.name, "GlobTool")
      assert.deepStrictEqual(block.toolUse?.input, { pattern: "*.ts" })
    }))

  it.effect("decodes a toolResult content block", () =>
    Effect.gen(function*() {
      const block = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ContentBlock)({
        toolResult: { toolUseId: "tu_1", content: [{ text: "done" }] }
      })
      assert.isDefined(block.toolResult)
      assert.strictEqual(block.toolResult?.content[0]?.text, "done")
    }))

  it.effect("ignores unknown content blocks (tolerant decode preserved)", () =>
    Effect.gen(function*() {
      const block = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ContentBlock)({
        reasoningContent: { reasoningText: { text: "hmm" } }
      })
      assert.isUndefined(block.text)
      assert.isUndefined(block.toolUse)
      assert.isUndefined(block.toolResult)
    }))

  it.effect("decodes a stop reason outside the known set", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.StopReason)("brand_new_reason")
      assert.strictEqual(decoded, "brand_new_reason")
    }))

  it.effect("rejects a stop reason that is not a string", () =>
    Effect.gen(function*() {
      const error = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.StopReason)(42).pipe(Effect.flip)
      assert.strictEqual(error._tag, "SchemaError")
    }))

  it.effect("encodes a ConverseRequest carrying toolConfig", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.ConverseRequest)(
        new AmazonBedrockSchema.ConverseRequest({
          modelId: "m",
          messages: [],
          toolConfig: new AmazonBedrockSchema.ToolConfiguration({
            tools: [
              new AmazonBedrockSchema.Tool({
                toolSpec: new AmazonBedrockSchema.ToolSpecification({
                  name: "GlobTool",
                  inputSchema: { json: { type: "object" } }
                })
              })
            ],
            toolChoice: { auto: {} }
          })
        })
      )
      assert.strictEqual(encoded.toolConfig?.tools[0]?.toolSpec?.name, "GlobTool")
      assert.isDefined(encoded.toolConfig && (encoded.toolConfig.toolChoice as { auto?: unknown })?.auto)
    }))

  it.effect("encodes a cachePoint entry in toolConfig.tools", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.ConverseRequest)(
        new AmazonBedrockSchema.ConverseRequest({
          modelId: "m",
          messages: [],
          toolConfig: new AmazonBedrockSchema.ToolConfiguration({
            tools: [
              new AmazonBedrockSchema.Tool({
                toolSpec: new AmazonBedrockSchema.ToolSpecification({
                  name: "GlobTool",
                  inputSchema: { json: { type: "object" } }
                })
              }),
              new AmazonBedrockSchema.Tool({
                cachePoint: new AmazonBedrockSchema.CachePointBlock({ type: "default", ttl: "1h" })
              })
            ]
          })
        })
      )
      assert.deepStrictEqual(encoded.toolConfig?.tools[1], { cachePoint: { type: "default", ttl: "1h" } })
    }))

  it.effect("round-trips a document block carrying a text source", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.DocumentBlock)(
        new AmazonBedrockSchema.DocumentBlock({
          format: "txt",
          name: "notes",
          source: { text: "hello world" }
        })
      )
      assert.deepStrictEqual(encoded.source, { text: "hello world" })

      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.DocumentBlock)(encoded)
      assert.strictEqual(decoded.source.text, "hello world")
      assert.isUndefined(decoded.source.bytes)
    }))

  it.effect("round-trips a document block carrying context", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.DocumentBlock)(
        new AmazonBedrockSchema.DocumentBlock({
          format: "pdf",
          name: "report",
          source: { bytes: "AQID" },
          context: "A quarterly earnings report. Prefer the tables over the prose."
        })
      )
      assert.strictEqual(encoded.context, "A quarterly earnings report. Prefer the tables over the prose.")

      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.DocumentBlock)(encoded)
      assert.strictEqual(decoded.context, "A quarterly earnings report. Prefer the tables over the prose.")
      assert.isUndefined(decoded.citations)
    }))

  it.effect("round-trips additionalModelRequestFields on a ConverseRequest", () =>
    Effect.gen(function*() {
      const fields = { thinking: { type: "enabled", budget_tokens: 1024 } }
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.ConverseRequest)(
        new AmazonBedrockSchema.ConverseRequest({
          modelId: "m",
          messages: [],
          additionalModelRequestFields: fields
        })
      )
      assert.deepStrictEqual(encoded.additionalModelRequestFields, fields)

      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ConverseRequest)(encoded)
      assert.deepStrictEqual(decoded.additionalModelRequestFields, fields)
    }))

  it.effect("decodes the trace of a Converse response unchanged", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ConverseResponse)({
        output: { message: { role: "assistant", content: [{ text: "Blocked." }] } },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: "guardrail_intervened",
        trace: inputBlockedTrace
      })
      assert.deepStrictEqual(decoded.trace, inputBlockedTrace)
    }))

  it.effect("decodes the trace of a stream metadata event unchanged", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.ConverseStreamMetadataEvent)({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        trace: inputBlockedTrace
      })
      assert.deepStrictEqual(decoded.trace, inputBlockedTrace)
    }))
})
