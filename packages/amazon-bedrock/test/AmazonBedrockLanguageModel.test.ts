import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { concat, eventFrame, exceptionFrame, happyPathFrames } from "./utils.ts"

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) =>
  HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      return yield* handler(request)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
  )

const binaryResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: Uint8Array
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream" }
    })
  )

const layersFor = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) =>
  AmazonBedrockLanguageModel.layer({ model: "us.test.model-v1:0" }).pipe(
    Layer.provide(AmazonBedrockClient.layer({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: Redacted.make("test-secret"),
      region: "us-east-1"
    })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeHttpClient(handler)))
  )

const getRequestBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function*() {
    const body = request.body
    if (body._tag === "Uint8Array") {
      return JSON.parse(new TextDecoder().decode(body.body))
    }
    if (body._tag === "Raw" && typeof body.body === "string") {
      return JSON.parse(body.body)
    }
    return yield* Effect.die(new Error(`Expected Raw or Uint8Array body, got ${body._tag}`))
  })

describe("AmazonBedrockLanguageModel", () => {
  describe("generateText", () => {
    it.effect("sends a signed Converse request and decodes the response", () =>
      Effect.gen(function*() {
        const capturedRequests: Array<HttpClientRequest.HttpClientRequest> = []
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          capturedRequests.push(request)
          return Effect.succeed(jsonResponse(request, {
            output: { message: { role: "assistant", content: [{ text: "Hi there" }] } },
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
            stopReason: "end_turn",
            metrics: { latencyMs: 42 }
          }))
        }

        const response = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          Effect.provide(layersFor(handler))
        )

        assert.strictEqual(response.text, "Hi there")
        assert.strictEqual(response.finishReason, "stop")
        assert.strictEqual(response.usage.inputTokens.total, 7)
        assert.strictEqual(response.usage.outputTokens.total, 3)

        const captured = capturedRequests[0]
        assert.isDefined(captured)
        if (captured === undefined) {
          return
        }
        assert.strictEqual(
          captured.url,
          "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.test.model-v1:0/converse"
        )
        // SigV4 signing happened
        assert.include(captured.headers["authorization"], "AWS4-HMAC-SHA256")
        assert.isDefined(captured.headers["x-amz-date"])
        // modelId travels in the path, not the body
        const body = yield* getRequestBody(captured)
        assert.isUndefined(body.modelId)
        assert.deepStrictEqual(body.messages, [{ role: "user", content: [{ text: "Hello" }] }])
      }))

    it.effect("ignores non-text response content blocks", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, {
            output: {
              message: {
                role: "assistant",
                content: [
                  { reasoningContent: { reasoningText: { text: "thinking" } } },
                  { text: "Answer" }
                ]
              }
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            stopReason: "end_turn"
          }))

        const response = yield* LanguageModel.generateText({ prompt: "Q" }).pipe(
          Effect.provide(layersFor(handler))
        )
        assert.strictEqual(response.text, "Answer")
      }))

    const toolResponse = (request: HttpClientRequest.HttpClientRequest, content: ReadonlyArray<unknown>) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn"
      })

    const GlobTool = Tool.make("GlobTool", {
      description: "Search for files",
      parameters: Schema.Struct({ pattern: Schema.String }),
      success: Schema.String
    })
    const globToolkit = Toolkit.make(GlobTool)
    const globToolkitLayer = globToolkit.toLayer({ GlobTool: () => Effect.succeed("found.ts") })

    it.effect("encodes user tools into toolConfig.tools", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "find ts files", toolkit: globToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 1)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GlobTool")
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.description, "Search for files")
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.inputSchema.json.type, "object")
        assert.isDefined(body.toolConfig.tools[0].toolSpec.inputSchema.json.properties.pattern)
        assert.isDefined(body.toolConfig.toolChoice.auto)
      }))

    it.effect("maps toolChoice 'required' to { any: {} }", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "x", toolkit: globToolkit, toolChoice: "required" }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.isDefined(body.toolConfig.toolChoice.any)
      }))

    it.effect("maps a named toolChoice to { tool: { name } }", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "x", toolkit: globToolkit, toolChoice: { tool: "GlobTool" } }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.toolChoice.tool.name, "GlobTool")
      }))

    it.effect("decodes a toolUse response into a tool-call part", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, {
            output: {
              message: {
                role: "assistant",
                content: [{ toolUse: { toolUseId: "tu_1", name: "GlobTool", input: { pattern: "*.ts" } } }]
              }
            },
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            stopReason: "tool_use"
          }))

        const response = yield* LanguageModel.generateText({
          prompt: "find ts files",
          toolkit: globToolkit,
          // Do not auto-resolve the tool call; we want to inspect the tool-call part.
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        assert.strictEqual(response.finishReason, "tool-calls")
        const toolCall = response.content.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type === "tool-call") {
          assert.strictEqual(toolCall.id, "tu_1")
          assert.strictEqual(toolCall.name, "GlobTool")
          assert.deepStrictEqual(toolCall.params, { pattern: "*.ts" })
        }
      }))

    it.effect("maps 429 to a RateLimitError", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, { message: "Too many requests" }, 429))

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layersFor(handler)))
        )
        assert.strictEqual(error._tag, "AiError")
        assert.strictEqual(error.reason._tag, "RateLimitError")
      }))

    it.effect("maps 400 to InvalidRequestError and surfaces the AWS message", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, { message: "The provided model identifier is invalid." }, 400))

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layersFor(handler)))
        )
        assert.strictEqual(error.reason._tag, "InvalidRequestError")
        assert.include(error.message, "The provided model identifier is invalid.")
      }))
  })

  describe("streamText", () => {
    const streamParts = (frames: ReadonlyArray<Uint8Array>) =>
      LanguageModel.streamText({ prompt: "Hello" }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => globalThis.Array.from(chunk)),
        Effect.provide(layersFor((request) => Effect.succeed(binaryResponse(request, concat(frames)))))
      )

    it.effect("maps the happy path to text parts with a usage-bearing finish", () =>
      Effect.gen(function*() {
        const parts = yield* streamParts(happyPathFrames)
        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "text-start",
          "text-delta",
          "text-delta",
          "text-end",
          "finish"
        ])
        const finish = parts[parts.length - 1]!
        if (finish.type === "finish") {
          assert.strictEqual(finish.reason, "stop")
          assert.strictEqual(finish.usage.inputTokens.total, 10)
          assert.strictEqual(finish.usage.outputTokens.total, 5)
        }
        const text = parts
          .filter((part) => part.type === "text-delta")
          .map((part) => (part as { delta: string }).delta)
          .join("")
        assert.strictEqual(text, "Hello, world")
      }))

    it.effect("skips non-text deltas without emitting parts", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: "thinking" } }
          }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Visible" } }),
          eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
          eventFrame("messageStop", { stopReason: "end_turn" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ]
        const parts = yield* streamParts(frames)
        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "text-start",
          "text-delta",
          "text-end",
          "finish"
        ])
      }))

    it.effect("surfaces in-stream exceptions as error parts", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          exceptionFrame("throttlingException", { message: "Slow down" })
        ]
        // Matching the Anthropic provider, in-stream exceptions surface as
        // `error` parts for the consumer to handle.
        const parts = yield* streamParts(frames)
        const errorPart = parts.find((part) => part.type === "error")
        assert.isDefined(errorPart)
        assert.include(JSON.stringify(errorPart), "Slow down")
      }))
  })
})
