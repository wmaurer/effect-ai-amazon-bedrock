import { AmazonBedrockSchema } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

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
})
