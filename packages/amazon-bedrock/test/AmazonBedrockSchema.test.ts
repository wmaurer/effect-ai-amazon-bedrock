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
      assert.strictEqual(encoded.toolConfig?.tools[0]?.toolSpec.name, "GlobTool")
      assert.isDefined(encoded.toolConfig && (encoded.toolConfig.toolChoice as { auto?: unknown })?.auto)
    }))
})
