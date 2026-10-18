import { assert, describe, it } from "@effect/vitest"
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { type AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { concat, eventFrame, exceptionFrame, happyPathFrames, inputBlockedTrace, outputMaskedTrace } from "./utils.ts"

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
  status = 200,
  headers: Record<string, string> = {}
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
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
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
  model = "us.test.model-v1:0",
  config?: Omit<typeof AmazonBedrockLanguageModel.Config.Service, "modelId">
) =>
  AmazonBedrockLanguageModel.layer({ model, config }).pipe(
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
                  { citationsContent: { citations: [] } },
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

    const reasoningResponse = (request: HttpClientRequest.HttpClientRequest, content: ReadonlyArray<unknown>) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn"
      })

    it.effect("decodes a reasoningContent block into a reasoning part", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(reasoningResponse(request, [
            { reasoningContent: { reasoningText: { text: "Let me think", signature: "sig_abc" } } },
            { text: "Answer" }
          ]))

        const response = yield* LanguageModel.generateText({ prompt: "Q" }).pipe(
          Effect.provide(layersFor(handler))
        )

        assert.strictEqual(response.text, "Answer")
        assert.strictEqual(response.reasoningText, "Let me think")
        const reasoning = response.reasoning[0]
        assert.isDefined(reasoning)
        assert.deepStrictEqual(reasoning?.metadata.amazonBedrock, {
          info: { type: "reasoningText", signature: "sig_abc" }
        })
      }))

    it.effect("decodes an unsigned reasoningText block with a null signature", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(reasoningResponse(request, [
            { reasoningContent: { reasoningText: { text: "Let me think" } } },
            { text: "Answer" }
          ]))

        const response = yield* LanguageModel.generateText({ prompt: "Q" }).pipe(
          Effect.provide(layersFor(handler))
        )

        assert.deepStrictEqual(response.reasoning[0]?.metadata.amazonBedrock, {
          info: { type: "reasoningText", signature: null }
        })
      }))

    it.effect("omits the signature when sending back an unsigned reasoning part", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(reasoningResponse(request, [{ text: "done" }]))
        }

        const prompt = Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Q" })] }),
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("reasoning", {
                text: "Let me think",
                options: { amazonBedrock: { info: { type: "reasoningText", signature: null } } }
              }),
              Prompt.makePart("text", { text: "Answer" })
            ]
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Follow up" })] })
        ])

        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))

        const body = yield* getRequestBody(captured!)
        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content[0], {
          reasoningContent: { reasoningText: { text: "Let me think" } }
        })
      }))

    it.effect("decodes a redacted reasoning block into an empty reasoning part", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(reasoningResponse(request, [
            { reasoningContent: { redactedContent: "cmVkYWN0ZWQ=" } },
            { text: "Answer" }
          ]))

        const response = yield* LanguageModel.generateText({ prompt: "Q" }).pipe(
          Effect.provide(layersFor(handler))
        )

        const reasoning = response.reasoning[0]
        assert.isDefined(reasoning)
        assert.strictEqual(reasoning?.text, "")
        assert.deepStrictEqual(reasoning?.metadata.amazonBedrock, {
          info: { type: "redactedContent", redactedContent: "cmVkYWN0ZWQ=" }
        })
      }))

    it.effect("encodes an assistant reasoning part as a reasoningContent block", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(reasoningResponse(request, [{ text: "done" }]))
        }

        const prompt = Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Q" })] }),
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("reasoning", {
                text: "Let me think",
                options: { amazonBedrock: { info: { type: "reasoningText", signature: "sig_abc" } } }
              }),
              Prompt.makePart("text", { text: "Answer" })
            ]
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Follow up" })] })
        ])

        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))

        const body = yield* getRequestBody(captured!)
        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content[0], {
          reasoningContent: { reasoningText: { text: "Let me think", signature: "sig_abc" } }
        })
        assert.deepStrictEqual(assistant.content[1], { text: "Answer" })
      }))

    it.effect("encodes a redacted assistant reasoning part as a reasoningContent block", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(reasoningResponse(request, [{ text: "done" }]))
        }

        const prompt = Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Q" })] }),
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("reasoning", {
                text: "",
                options: {
                  amazonBedrock: { info: { type: "redactedContent", redactedContent: "cmVkYWN0ZWQ=" } }
                }
              }),
              Prompt.makePart("text", { text: "Answer" })
            ]
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Follow up" })] })
        ])

        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))

        const body = yield* getRequestBody(captured!)
        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content[0], {
          reasoningContent: { redactedContent: "cmVkYWN0ZWQ=" }
        })
      }))

    it.effect("drops an assistant reasoning part that carries no provider info", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(reasoningResponse(request, [{ text: "done" }]))
        }

        const prompt = Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Q" })] }),
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("reasoning", { text: "Let me think" }),
              Prompt.makePart("text", { text: "Answer" })
            ]
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Follow up" })] })
        ])

        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))

        const body = yield* getRequestBody(captured!)
        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content, [{ text: "Answer" }])
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

    const GrepTool = Tool.make("GrepTool", {
      description: "Search file contents",
      parameters: Schema.Struct({ query: Schema.String }),
      success: Schema.String
    })
    const twoToolkit = Toolkit.make(GlobTool, GrepTool)
    const twoToolkitLayer = twoToolkit.toLayer({
      GlobTool: () => Effect.succeed("found.ts"),
      GrepTool: () => Effect.succeed("match")
    })

    const CachedGlobTool = GlobTool.annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
    const cachedToolkit = Toolkit.make(CachedGlobTool, GrepTool)
    const cachedToolkitLayer = cachedToolkit.toLayer({
      GlobTool: () => Effect.succeed("found.ts"),
      GrepTool: () => Effect.succeed("match")
    })

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

    const stopReasonCases = [
      { stopReason: "end_turn", finishReason: "stop" },
      { stopReason: "tool_use", finishReason: "tool-calls" },
      { stopReason: "max_tokens", finishReason: "length" },
      { stopReason: "stop_sequence", finishReason: "stop" },
      { stopReason: "guardrail_intervened", finishReason: "content-filter" },
      { stopReason: "content_filtered", finishReason: "content-filter" },
      { stopReason: "malformed_model_output", finishReason: "error" },
      { stopReason: "malformed_tool_use", finishReason: "error" },
      { stopReason: "model_context_window_exceeded", finishReason: "length" },
      { stopReason: "brand_new_reason", finishReason: "other" },
      { stopReason: "toString", finishReason: "other" }
    ] as const

    for (const testCase of stopReasonCases) {
      it.effect(`maps stop reason ${testCase.stopReason} to finish reason ${testCase.finishReason}`, () =>
        Effect.gen(function*() {
          const handler = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.succeed(jsonResponse(request, {
              output: { message: { role: "assistant", content: [{ text: "Partial answer" }] } },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              stopReason: testCase.stopReason
            }))

          const response = yield* LanguageModel.generateText({ prompt: "Q" }).pipe(
            Effect.provide(layersFor(handler))
          )
          assert.strictEqual(response.text, "Partial answer")
          assert.strictEqual(response.finishReason, testCase.finishReason)
        }))
    }

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
        assert.notInclude(error.message, "data retention")
      }))

    it.effect("names the account data retention setting when a model rejects the retention mode", () =>
      Effect.gen(function*() {
        const message =
          "The model returned the following errors: data retention mode 'default' is not available for this model"
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, { message }, 400, { "x-amzn-errortype": "ValidationException" }))

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(layersFor(handler, "global.anthropic.claude-fable-5-1"))
          )
        )
        assert.strictEqual(error.reason._tag, "InvalidRequestError")
        assert.strictEqual(
          error.reason._tag === "InvalidRequestError" ? error.reason.description : undefined,
          `${message} (POST https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-fable-5-1/converse)` +
            " The account's data retention mode in this region does not allow this model." +
            " Claude Fable 5 and 5.1 need `aws_review`." +
            " Set the mode with the Bedrock PutAccountDataRetention operation:" +
            " https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html"
        )
      }))

    // Bedrock answers 403 for four different problems and separates them only in
    // the `x-amzn-errortype` header. The status alone cannot tell a bad key from an
    // expired one from a model the account may not use.
    const authCases = [
      {
        errorType: "AccessDeniedException",
        status: 403,
        message: "anthropic.claude-sonnet-5 is not available for this account.",
        kind: "InsufficientPermissions"
      },
      {
        errorType: "ExpiredTokenException",
        status: 403,
        message: "The security token included in the request is expired",
        kind: "ExpiredKey"
      },
      {
        errorType: "UnrecognizedClientException",
        status: 403,
        message: "The security token included in the request is invalid.",
        kind: "InvalidKey"
      },
      {
        errorType: "InvalidSignatureException",
        status: 403,
        message: "Signature expired",
        kind: "InvalidKey"
      },
      {
        errorType: "MissingAuthenticationTokenException",
        status: 401,
        message: "Missing Authentication Token",
        kind: "MissingKey"
      }
    ] as const

    for (const testCase of authCases) {
      it.effect(`maps ${testCase.errorType} to ${testCase.kind}`, () =>
        Effect.gen(function*() {
          const handler = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.succeed(jsonResponse(request, { message: testCase.message }, testCase.status, {
              // AWS appends a Coral shape URL after a colon; only the prefix identifies it.
              "x-amzn-errortype": `${testCase.errorType}:http://internal.amazon.com/coral/com.amazon.bedrock/`
            }))

          const error = yield* Effect.flip(
            LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layersFor(handler)))
          )
          assert.strictEqual(error.reason._tag, "AuthenticationError")
          if (error.reason._tag === "AuthenticationError") {
            assert.strictEqual(error.reason.kind, testCase.kind)
          }
          assert.include(error.message, testCase.message)
        }))
    }

    it.effect("falls back to the status when no error type header is present", () =>
      Effect.gen(function*() {
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(jsonResponse(request, { message: "Forbidden" }, 403))

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layersFor(handler)))
        )
        assert.strictEqual(error.reason._tag, "AuthenticationError")
        if (error.reason._tag === "AuthenticationError") {
          assert.strictEqual(error.reason.kind, "InsufficientPermissions")
        }
      }))

    it.effect("encodes an assistant tool-call as a toolUse block", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "done" }]))
        }

        const prompt = Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "find ts" })] }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("tool-call", {
              id: "tu_1",
              name: "GlobTool",
              params: { pattern: "*.ts" },
              providerExecuted: false
            })]
          }),
          Prompt.makeMessage("tool", {
            content: [Prompt.makePart("tool-result", {
              id: "tu_1",
              name: "GlobTool",
              isFailure: false,
              result: "a.ts\nb.ts",
              providerExecuted: false
            })]
          })
        ])

        yield* LanguageModel.generateText({ prompt, toolkit: globToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content[0].toolUse, {
          toolUseId: "tu_1",
          name: "GlobTool",
          input: { pattern: "*.ts" }
        })
        const user = body.messages.find((m: any) =>
          m.role === "user" && m.content.some((c: any) => c.toolResult !== undefined)
        )
        assert.deepStrictEqual(user.content.find((c: any) => c.toolResult).toolResult, {
          toolUseId: "tu_1",
          content: [{ text: JSON.stringify("a.ts\nb.ts") }]
        })
      }))

    it.effect("omits toolConfig when toolChoice is 'none'", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "x", toolkit: globToolkit, toolChoice: "none" }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.isUndefined(body.toolConfig)
      }))

    it.effect("filters tools to the oneOf set and defaults to auto", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({
          prompt: "x",
          toolkit: twoToolkit,
          toolChoice: { oneOf: ["GlobTool"] }
        }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(twoToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 1)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GlobTool")
        assert.isDefined(body.toolConfig.toolChoice.auto)
      }))

    it.effect("emits a cachePoint entry after an annotated tool only", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "x", toolkit: cachedToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(cachedToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 3)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GlobTool")
        assert.deepStrictEqual(body.toolConfig.tools[1], { cachePoint: { type: "default" } })
        assert.strictEqual(body.toolConfig.tools[2].toolSpec.name, "GrepTool")
        assert.isUndefined(body.toolConfig.tools[2].cachePoint)
      }))

    // Asserts the end-to-end result; passes today via core's pre-filter, so it's
    // not a red-first test of the provider-side filter.
    it.effect("drops a filtered-out tool's cache point with the tool", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({
          prompt: "x",
          toolkit: cachedToolkit,
          toolChoice: { oneOf: ["GrepTool"] }
        }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(cachedToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 1)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GrepTool")
      }))

    it.effect("carries the cache point ttl into the request", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        const ttlTool = GlobTool.annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default", ttl: "1h" })
        const ttlToolkit = Toolkit.make(ttlTool)

        yield* LanguageModel.generateText({ prompt: "x", toolkit: ttlToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(ttlToolkit.toLayer({ GlobTool: () => Effect.succeed("found.ts") }))
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 2)
        assert.deepStrictEqual(body.toolConfig.tools[1], { cachePoint: { type: "default", ttl: "1h" } })
      }))

    const fileResponse = (request: HttpClientRequest.HttpClientRequest) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content: [{ text: "done" }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn"
      })

    const captureUserContent = (parts: ReadonlyArray<Prompt.UserMessagePart>) =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(fileResponse(request))
        }

        const prompt = Prompt.fromMessages([Prompt.makeMessage("user", { content: parts })])
        yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))

        const body = yield* getRequestBody(captured!)
        return body.messages[0].content
      })

    it.effect("encodes an image file part as an image block", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }),
          Prompt.makePart("text", { text: "What is this?" })
        ])

        assert.deepStrictEqual(content, [
          { image: { format: "png", source: { bytes: "AQID" } } },
          { text: "What is this?" }
        ])
      }))

    it.effect("passes base64 image data through unchanged", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "image/jpeg", data: "AQID" })
        ])

        assert.deepStrictEqual(content, [{ image: { format: "jpeg", source: { bytes: "AQID" } } }])
      }))

    it.effect("maps the image/* media type to jpeg", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "image/*", data: "AQID" })
        ])

        assert.strictEqual(content[0].image.format, "jpeg")
      }))

    it.effect("encodes a document file part as a document block", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            fileName: "quarterly_report.pdf",
            data: new Uint8Array([1, 2, 3])
          })
        ])

        // Bedrock only accepts alphanumerics, single spaces, hyphens,
        // parentheses and square brackets in a document name.
        assert.deepStrictEqual(content, [{
          document: { format: "pdf", name: "quarterly report", source: { bytes: "AQID" } }
        }])
      }))

    it.effect("generates a document name when the file part has none", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "text/plain", data: "AQID" }),
          Prompt.makePart("file", { mediaType: "text/csv", data: "AQID" })
        ])

        assert.strictEqual(content[0].document.name, "document 1")
        assert.strictEqual(content[0].document.format, "txt")
        assert.strictEqual(content[1].document.name, "document 2")
        assert.strictEqual(content[1].document.format, "csv")
      }))

    it.effect("sends a cited text document as a text source", () =>
      Effect.gen(function*() {
        // "aGVsbG8gd29ybGQ=" is base64 for "hello world"; string file part data
        // is base64 per the `Prompt.FilePart` contract.
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/plain",
            fileName: "notes.txt",
            data: "aGVsbG8gd29ybGQ=",
            options: { amazonBedrock: { citations: { enabled: true } } }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "txt",
            name: "notes",
            source: { text: "hello world" },
            citations: { enabled: true }
          }
        }])
      }))

    it.effect("decodes Uint8Array data for a cited text document as utf-8", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/markdown",
            fileName: "readme.md",
            data: new TextEncoder().encode("# Title"),
            options: { amazonBedrock: { citations: { enabled: true } } }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "md",
            name: "readme",
            source: { text: "# Title" },
            citations: { enabled: true }
          }
        }])
      }))

    /**
     * Converse accepts a `text` document source only alongside a citations config, and
     * answers "must set one of the following keys: bytes, s3Location" otherwise. The
     * Smithy model does not say so — it lists `text` as an unconditional member of the
     * union — so this was only visible from a live call.
     */
    it.effect("sends an uncited text document as a bytes source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/plain",
            fileName: "notes.txt",
            data: "aGVsbG8gd29ybGQ="
          })
        ])

        assert.deepStrictEqual(content, [{
          document: { format: "txt", name: "notes", source: { bytes: "aGVsbG8gd29ybGQ=" } }
        }])
      }))

    it.effect("sends uncited Uint8Array text document data as bytes, not decoded text", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/markdown",
            fileName: "readme.md",
            data: new TextEncoder().encode("# Title")
          })
        ])

        assert.deepStrictEqual(content, [{
          document: { format: "md", name: "readme", source: { bytes: "IyBUaXRsZQ==" } }
        }])
      }))

    it.effect("keeps the context option on an uncited text document", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/plain",
            fileName: "notes.txt",
            data: "aGVsbG8gd29ybGQ=",
            options: { amazonBedrock: { context: "Throughput figures are authoritative." } }
          })
        ])

        assert.deepStrictEqual(content[0].document.source, { bytes: "aGVsbG8gd29ybGQ=" })
        assert.strictEqual(content[0].document.context, "Throughput figures are authoritative.")
      }))

    it.effect("keeps a binary document as a bytes source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "application/pdf", data: new Uint8Array([1, 2, 3]) })
        ])

        assert.deepStrictEqual(content[0].document.source, { bytes: "AQID" })
      }))

    it.effect("keeps an s3 text document as an s3Location source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "text/csv", data: new URL("s3://bucket/rows.csv") })
        ])

        assert.deepStrictEqual(content[0].document.source, {
          s3Location: { uri: "s3://bucket/rows.csv" }
        })
      }))

    // Only the cited path decodes the base64 itself; an uncited document passes the string
    // through as `bytes` and lets Converse reject it.
    it.effect("fails on cited text document data that is not base64", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          captureUserContent([
            Prompt.makePart("file", {
              mediaType: "text/plain",
              fileName: "notes.txt",
              data: "not base64!!",
              options: { amazonBedrock: { citations: { enabled: true } } }
            })
          ])
        )

        assert.strictEqual((error as any).reason._tag, "InvalidUserInputError")
        assert.include((error as any).message, "notes")
        assert.include((error as any).message, "text/plain")
      }))

    it.effect("encodes an s3 file url as an s3Location source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "image/png", data: new URL("s3://bucket/key.png") })
        ])

        assert.deepStrictEqual(content, [{
          image: { format: "png", source: { s3Location: { uri: "s3://bucket/key.png" } } }
        }])
      }))

    it.effect("fails on an unsupported file media type", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          captureUserContent([Prompt.makePart("file", { mediaType: "video/mp4", data: "AQID" })])
        )

        assert.strictEqual((error as any).reason._tag, "InvalidUserInputError")
        assert.include((error as any).message, "video/mp4")
      }))

    it.effect("fails on a file url that is not an s3 location", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          captureUserContent([
            Prompt.makePart("file", { mediaType: "image/png", data: new URL("https://example.com/a.png") })
          ])
        )

        assert.strictEqual((error as any).reason._tag, "InvalidUserInputError")
        assert.include((error as any).message, "https://example.com/a.png")
      }))

    const cacheResponse = (request: HttpClientRequest.HttpClientRequest) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content: [{ text: "done" }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn"
      })

    const captureBody = (prompt: Prompt.Prompt) =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(cacheResponse(request))
        }

        // Converse rejects a prompt with tool calls unless the request offers tools.
        yield* LanguageModel.generateText({ prompt, toolkit: globToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(globToolkitLayer)
        )
        return yield* getRequestBody(captured!)
      })

    const cachePoint = { amazonBedrock: { cachePoint: { type: "default" } } } as const

    it.effect("inserts a cachePoint block after a system message that requests one", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("system", { content: "Long preamble", options: cachePoint }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Q" })] })
        ]))

        assert.deepStrictEqual(body.system, [
          { text: "Long preamble" },
          { cachePoint: { type: "default" } }
        ])
      }))

    it.effect("inserts a cachePoint block after a text part that requests one", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", { text: "Cached", options: cachePoint }),
              Prompt.makePart("text", { text: "Fresh" })
            ]
          })
        ]))

        assert.deepStrictEqual(body.messages[0].content, [
          { text: "Cached" },
          { cachePoint: { type: "default" } },
          { text: "Fresh" }
        ])
      }))

    it.effect("carries the cache point ttl when one is given", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", {
                text: "Cached",
                options: { amazonBedrock: { cachePoint: { type: "default", ttl: "1h" } } }
              })
            ]
          })
        ]))

        assert.deepStrictEqual(body.messages[0].content[1], { cachePoint: { type: "default", ttl: "1h" } })
      }))

    it.effect("inserts a cachePoint block after the last block of a message that requests one", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", { text: "One" }),
              Prompt.makePart("text", { text: "Two" })
            ],
            options: cachePoint
          })
        ]))

        assert.deepStrictEqual(body.messages[0].content, [
          { text: "One" },
          { text: "Two" },
          { cachePoint: { type: "default" } }
        ])
      }))

    it.effect("inserts a cachePoint block after a tool result that requests one", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "find ts" })] }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("tool-call", {
              id: "tool-1",
              name: "GlobTool",
              params: { pattern: "*.ts" },
              providerExecuted: false
            })]
          }),
          Prompt.makeMessage("tool", {
            content: [Prompt.makePart("tool-result", {
              id: "tool-1",
              name: "GlobTool",
              isFailure: false,
              result: { files: ["a.ts"] },
              providerExecuted: false,
              options: cachePoint
            })]
          })
        ]))

        const last = body.messages[body.messages.length - 1]
        assert.strictEqual(last.role, "user")
        assert.deepStrictEqual(last.content[1], { cachePoint: { type: "default" } })
      }))

    it.effect("inserts a cachePoint block after an assistant tool call that requests one", () =>
      Effect.gen(function*() {
        const body = yield* captureBody(Prompt.fromMessages([
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "find ts" })] }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("tool-call", {
              id: "tool-1",
              name: "GlobTool",
              params: { pattern: "*.ts" },
              providerExecuted: false,
              options: cachePoint
            })]
          }),
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Follow up" })] })
        ]))

        const assistant = body.messages.find((m: any) => m.role === "assistant")
        assert.deepStrictEqual(assistant.content[1], { cachePoint: { type: "default" } })
      }))

    const citedDocument = Prompt.makePart("file", {
      mediaType: "application/pdf",
      fileName: "report.pdf",
      data: "AQID",
      options: { amazonBedrock: { citations: { enabled: true } } }
    })

    it.effect("enables citations on a document block when requested", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([citedDocument])

        assert.deepStrictEqual(content, [{
          document: {
            format: "pdf",
            name: "report",
            source: { bytes: "AQID" },
            citations: { enabled: true }
          }
        }])
      }))

    it.effect("sends context on a document block when requested", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            fileName: "report.pdf",
            data: "AQID",
            options: {
              amazonBedrock: {
                context: "A quarterly earnings report.",
                citations: { enabled: true }
              }
            }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "pdf",
            name: "report",
            source: { bytes: "AQID" },
            context: "A quarterly earnings report.",
            citations: { enabled: true }
          }
        }])
      }))

    it.effect("sends context on a document block with citations disabled", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            fileName: "report.pdf",
            data: "AQID",
            options: { amazonBedrock: { context: "A quarterly earnings report." } }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "pdf",
            name: "report",
            source: { bytes: "AQID" },
            context: "A quarterly earnings report."
          }
        }])
      }))

    const generateWithDocument = (content: ReadonlyArray<unknown>) =>
      LanguageModel.generateText({
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [citedDocument, Prompt.makePart("text", { text: "Summarize" })]
          })
        ])
      }).pipe(
        Effect.provide(layersFor((request) =>
          Effect.succeed(jsonResponse(request, {
            output: { message: { role: "assistant", content } },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            stopReason: "end_turn"
          }))
        ))
      )

    const sourceParts = (parts: ReadonlyArray<{ readonly type: string }>): Array<any> =>
      parts.filter((part) => part.type === "source") as Array<any>

    it.effect("decodes a citationsContent block into text and a document source", () =>
      Effect.gen(function*() {
        const response = yield* generateWithDocument([{
          citationsContent: {
            content: [{ text: "Revenue grew 12%." }],
            citations: [{
              title: "Q3 revenue",
              source: "s3://reports/q3.pdf",
              sourceContent: [{ text: "revenue increased by 12 percent" }],
              location: { documentChar: { documentIndex: 0, start: 100, end: 140 } }
            }]
          }
        }])

        assert.strictEqual(response.text, "Revenue grew 12%.")

        const sources = sourceParts(response.content)
        assert.strictEqual(sources.length, 1)
        assert.strictEqual(sources[0].sourceType, "document")
        assert.strictEqual(sources[0].title, "Q3 revenue")
        assert.strictEqual(sources[0].mediaType, "application/pdf")
        assert.strictEqual(sources[0].fileName, "report.pdf")
        assert.isString(sources[0].id)
        assert.deepStrictEqual(sources[0].metadata.amazonBedrock, {
          location: "documentChar",
          citedText: "revenue increased by 12 percent",
          start: 100,
          end: 140,
          source: "s3://reports/q3.pdf"
        })
      }))

    it.effect("falls back to the document name when a citation carries no title", () =>
      Effect.gen(function*() {
        const response = yield* generateWithDocument([{
          citationsContent: {
            content: [{ text: "Revenue grew." }],
            citations: [{ location: { documentPage: { documentIndex: 0, start: 4, end: 5 } } }]
          }
        }])

        const sources = sourceParts(response.content)
        assert.strictEqual(sources.length, 1)
        // The document block name Converse was sent, with the extension dropped.
        assert.strictEqual(sources[0].title, "report")
        assert.deepStrictEqual(sources[0].metadata.amazonBedrock, {
          location: "documentPage",
          citedText: "",
          start: 4,
          end: 5,
          source: null
        })
      }))

    it.effect("keeps the generated text when a citation references an unknown document", () =>
      Effect.gen(function*() {
        const response = yield* generateWithDocument([{
          citationsContent: {
            content: [{ text: "Revenue grew." }],
            citations: [{ location: { documentChar: { documentIndex: 7, start: 1, end: 2 } } }]
          }
        }])

        assert.strictEqual(response.text, "Revenue grew.")
        assert.strictEqual(sourceParts(response.content).length, 0)
      }))

    it.effect("skips a citation whose location this provider does not model", () =>
      Effect.gen(function*() {
        const response = yield* generateWithDocument([{
          citationsContent: {
            content: [{ text: "Revenue grew." }],
            citations: [{ title: "A web page", location: { web: { url: "https://example.com" } } }]
          }
        }])

        assert.strictEqual(response.text, "Revenue grew.")
        assert.strictEqual(sourceParts(response.content).length, 0)
      }))
  })

  describe("generateObject", () => {
    const objectResponse = (request: HttpClientRequest.HttpClientRequest, content: ReadonlyArray<unknown>) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content } },
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        stopReason: "end_turn"
      })
    const claude = "eu.anthropic.claude-opus-4-8"

    it.effect("requests native structured output and decodes the text block", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(objectResponse(request, [{ text: "{\"name\":\"Ada\",\"age\":36}" }]))
        }

        const result = yield* LanguageModel.generateObject({
          prompt: "Give me a person",
          objectName: "person",
          schema: Schema.Struct({ name: Schema.String, age: Schema.Number }).annotate({ description: "A person" })
        }).pipe(Effect.provide(layersFor(handler, claude)))

        assert.deepStrictEqual(result.value, { name: "Ada", age: 36 })

        const body = yield* getRequestBody(captured!)
        assert.isUndefined(body.toolConfig)
        const textFormat = body.outputConfig.textFormat
        assert.strictEqual(textFormat.type, "json_schema")
        assert.strictEqual(textFormat.structure.jsonSchema.name, "person")
        assert.strictEqual(textFormat.structure.jsonSchema.description, "A person")
        // Converse models the schema as a string, not a document.
        assert.strictEqual(typeof textFormat.structure.jsonSchema.schema, "string")
        assert.strictEqual(JSON.parse(textFormat.structure.jsonSchema.schema).type, "object")
      }))

    it.effect("requests native structured output on Claude Opus 5.5", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(objectResponse(request, [{ text: "{\"ok\":true}" }]))
        }

        const result = yield* LanguageModel.generateObject({
          prompt: "x",
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean })
        }).pipe(Effect.provide(layersFor(handler, "eu.anthropic.claude-opus-5-5")))

        assert.deepStrictEqual(result.value, { ok: true })
        const body = yield* getRequestBody(captured!)
        assert.isUndefined(body.toolConfig)
        assert.strictEqual(body.outputConfig.textFormat.structure.jsonSchema.name, "result")
      }))

    it.effect("renders union and nullable fields in the output schema", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(objectResponse(request, [{ text: "{\"line\":12,\"owner\":null}" }]))
        }

        yield* LanguageModel.generateObject({
          prompt: "describe a finding",
          objectName: "finding",
          schema: Schema.Struct({
            line: Schema.Union([Schema.Int, Schema.String]),
            owner: Schema.NullOr(Schema.Int)
          })
        }).pipe(Effect.provide(layersFor(handler, claude)))

        const body = yield* getRequestBody(captured!)
        const props = JSON.parse(body.outputConfig.textFormat.structure.jsonSchema.schema).properties
        // The exact JSON-Schema encoding is whatever `toCodecAnthropic` produces;
        // assert the union/nullable members survive in some accepted form.
        assert.include(JSON.stringify(props.line), "integer")
        assert.include(JSON.stringify(props.line), "string")
        assert.include(JSON.stringify(props.owner), "integer")
        assert.include(JSON.stringify(props.owner), "null")
      }))

    it.effect("keeps other outputConfig fields from the config alongside the text format", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(objectResponse(request, [{ text: "{\"ok\":true}" }]))
        }

        yield* LanguageModel.generateObject({
          prompt: "x",
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean })
        }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ outputConfig: { effort: "low" } }),
          Effect.provide(layersFor(handler, claude))
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.outputConfig.effort, "low")
        assert.strictEqual(body.outputConfig.textFormat.type, "json_schema")
      }))

    describe("on the path the model ID selects", () => {
      const json = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false
      }
      const objectTool = (toolChoice: unknown) => ({
        tools: [{ toolSpec: { name: "result", description: "Respond with a JSON object", inputSchema: { json } } }],
        toolChoice
      })
      const paths = {
        native: {
          system: [],
          outputConfig: {
            textFormat: {
              type: "json_schema",
              structure: { jsonSchema: { schema: JSON.stringify(json), name: "result" } }
            }
          },
          toolConfig: undefined
        },
        "the forced tool": { system: [], outputConfig: undefined, toolConfig: objectTool({ any: {} }) },
        "the unforced tool": {
          system: [{ text: "Respond only by calling the `result` tool. Do not answer in text." }],
          outputConfig: undefined,
          toolConfig: objectTool({ auto: {} })
        }
      }

      const generate = (
        model: string,
        config: typeof AmazonBedrockLanguageModel.Config.Service = {}
      ) =>
        Effect.gen(function*() {
          const bodies: Array<any> = []
          const handler = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.map(getRequestBody(request), (body) => {
              bodies.push(body)
              return objectResponse(
                request,
                body.toolConfig === undefined
                  ? [{ text: "{\"ok\":true}" }]
                  : [{ toolUse: { toolUseId: "tu_1", name: "result", input: { ok: true } } }]
              )
            })
          const result = yield* LanguageModel.generateObject({
            prompt: "x",
            objectName: "result",
            schema: Schema.Struct({ ok: Schema.Boolean })
          }).pipe(AmazonBedrockLanguageModel.withConfigOverride(config), Effect.provide(layersFor(handler, model)))
          assert.deepStrictEqual(result.value, { ok: true })
          const [body] = bodies
          return { system: body.system, outputConfig: body.outputConfig, toolConfig: body.toolConfig }
        })

      for (
        const { model, path } of [
          { model: "eu.anthropic.claude-opus-4-8", path: "native" },
          { model: "global.anthropic.claude-haiku-4-5-20251001-v1:0", path: "native" },
          {
            model: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-opus-4-8",
            path: "native"
          },
          {
            model: "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
            path: "native"
          },
          { model: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", path: "the forced tool" },
          { model: "eu.amazon.nova-pro-v1:0", path: "the forced tool" },
          { model: "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-pro-v1:0", path: "the forced tool" },
          { model: "mistral.mistral-large-2402-v1:0", path: "the forced tool" },
          { model: "global.openai.gpt-5.5", path: "the forced tool" },
          { model: "us.meta.llama4-maverick-17b-instruct-v1:0", path: "the unforced tool" },
          { model: "meta.llama3-70b-instruct-v1:0", path: "the unforced tool" },
          { model: "us.writer.palmyra-x5-v1:0", path: "the unforced tool" },
          {
            model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.meta.llama4-maverick-17b-instruct-v1:0",
            path: "the unforced tool"
          }
        ] as const
      ) {
        it.effect(`asks ${model} for the object through ${path}`, () =>
          Effect.gen(function*() {
            assert.deepStrictEqual(yield* generate(model), paths[path])
          }))
      }

      it.effect("lets the config override the path the model ID selects", () =>
        Effect.gen(function*() {
          assert.deepStrictEqual(yield* generate("global.openai.gpt-5.5", { structuredOutputs: true }), paths.native)
          assert.deepStrictEqual(
            yield* generate("eu.amazon.nova-pro-v1:0", { forcedToolChoice: false }),
            paths["the unforced tool"]
          )
          assert.deepStrictEqual(
            yield* generate("us.meta.llama4-maverick-17b-instruct-v1:0", { forcedToolChoice: true }),
            paths["the forced tool"]
          )
        }))
    })

    describe("through the object tool", () => {
      const Answer = Schema.Struct({ answer: Schema.Number })
      const toolPath = AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false })

      it.effect("asks for an unforced tool when the model rejects a forced one", () =>
        Effect.gen(function*() {
          let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
          const handler = (request: HttpClientRequest.HttpClientRequest) => {
            captured = request
            return Effect.succeed(jsonResponse(request, {
              output: {
                message: {
                  role: "assistant",
                  content: [
                    { text: "Here is the answer." },
                    { toolUse: { toolUseId: "tu_1", name: "Answer", input: { answer: 4 } } }
                  ]
                }
              },
              usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
              stopReason: "tool_use"
            }))
          }

          const result = yield* LanguageModel.generateObject({
            prompt: "2 + 2?",
            objectName: "Answer",
            schema: Answer
          }).pipe(toolPath, Effect.provide(layersFor(handler, "eu.anthropic.claude-opus-5-5")))

          // The tool input is the object; the prose next to it is not concatenated in.
          assert.deepStrictEqual(result.value, { answer: 4 })
          assert.strictEqual(result.finishReason, "stop")

          const body = yield* getRequestBody(captured!)
          assert.isUndefined(body.outputConfig)
          assert.strictEqual(body.toolConfig.tools.length, 1)
          assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "Answer")
          assert.deepStrictEqual(body.toolConfig.toolChoice, { auto: {} })
          // An unforced tool is only a suggestion, so the request says to call it.
          assert.include(body.system.at(-1).text, "Answer")
        }))

      it.effect("decodes a text reply when the model skips the unforced tool", () =>
        Effect.gen(function*() {
          const handler = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.succeed(objectResponse(request, [{ text: "{\"answer\":4}" }]))

          const result = yield* LanguageModel.generateObject({
            prompt: "2 + 2?",
            objectName: "Answer",
            schema: Answer
          }).pipe(toolPath, Effect.provide(layersFor(handler, "eu.anthropic.claude-opus-5-5")))

          assert.deepStrictEqual(result.value, { answer: 4 })
        }))

      it.effect("forces the tool on a model that accepts a forced one", () =>
        Effect.gen(function*() {
          let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
          const handler = (request: HttpClientRequest.HttpClientRequest) => {
            captured = request
            return Effect.succeed(objectResponse(request, [
              { toolUse: { toolUseId: "tu_1", name: "Answer", input: { answer: 4 } } }
            ]))
          }

          const result = yield* LanguageModel.generateObject({
            prompt: "2 + 2?",
            objectName: "Answer",
            schema: Answer
          }).pipe(Effect.provide(layersFor(handler, "us.anthropic.claude-3-7-sonnet-20250219-v1:0")))

          assert.deepStrictEqual(result.value, { answer: 4 })
          const body = yield* getRequestBody(captured!)
          assert.isUndefined(body.outputConfig)
          assert.deepStrictEqual(body.toolConfig.toolChoice, { any: {} })
        }))
      it.effect("emits only the first object when the model calls the object tool twice", () =>
        Effect.gen(function*() {
          const handler = (request: HttpClientRequest.HttpClientRequest) =>
            Effect.succeed(objectResponse(request, [
              { toolUse: { toolUseId: "tu_1", name: "Answer", input: { answer: 4 } } },
              { toolUse: { toolUseId: "tu_2", name: "Answer", input: { answer: 5 } } }
            ]))

          const result = yield* LanguageModel.generateObject({
            prompt: "2 + 2?",
            objectName: "Answer",
            schema: Answer
          }).pipe(Effect.provide(layersFor(handler, "us.anthropic.claude-3-7-sonnet-20250219-v1:0")))

          assert.deepStrictEqual(result.value, { answer: 4 })
          assert.strictEqual(result.text, "{\"answer\":4}")
        }))
    })

    it.effect("lets structuredOutputs override the model detection, and keeps it off the wire", () =>
      Effect.gen(function*() {
        const bodies: Array<any> = []
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.map(getRequestBody(request), (body) => {
            bodies.push(body)
            return objectResponse(request, [{ text: "{\"ok\":true}" }])
          })
        const generate = LanguageModel.generateObject({
          prompt: "x",
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean })
        })

        // Off on a model detected as supporting it ...
        yield* generate.pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false }),
          Effect.provide(layersFor(handler, claude))
        )
        // ... and on for one detected as not supporting it.
        yield* generate.pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: true }),
          Effect.provide(layersFor(handler, "us.anthropic.claude-3-7-sonnet-20250219-v1:0"))
        )

        assert.isUndefined(bodies[0].outputConfig)
        assert.strictEqual(bodies[0].toolConfig.tools[0].toolSpec.name, "result")
        assert.isUndefined(bodies[1].toolConfig)
        assert.strictEqual(bodies[1].outputConfig.textFormat.type, "json_schema")
        for (const body of bodies) {
          assert.notProperty(body, "structuredOutputs")
        }
      }))

    it.effect("lets forcedToolChoice override the model detection, and keeps it off the wire", () =>
      Effect.gen(function*() {
        const bodies: Array<any> = []
        const handler = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.map(getRequestBody(request), (body) => {
            bodies.push(body)
            return objectResponse(request, [{ toolUse: { toolUseId: "tu_1", name: "result", input: { ok: true } } }])
          })
        const generate = LanguageModel.generateObject({
          prompt: "x",
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean })
        })

        // An application inference profile ARN does not name its model, so the
        // detection cannot tell that the model rejects a forced tool ...
        yield* generate.pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false, forcedToolChoice: false }),
          Effect.provide(layersFor(
            handler,
            "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/a1b2c3d4e5f6"
          ))
        )
        // ... and forcing can be turned back on for a model detected as rejecting it.
        yield* generate.pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false, forcedToolChoice: true }),
          Effect.provide(layersFor(handler, "eu.anthropic.claude-opus-5-5"))
        )

        assert.deepStrictEqual(bodies[0].toolConfig.toolChoice, { auto: {} })
        assert.deepStrictEqual(bodies[0].system, [{
          text: "Respond only by calling the `result` tool. Do not answer in text."
        }])
        assert.deepStrictEqual(bodies[1].toolConfig.toolChoice, { any: {} })
        assert.deepStrictEqual(bodies[1].system, [])
        for (const body of bodies) {
          assert.notProperty(body, "forcedToolChoice")
        }
      }))

    it.effect("emits a toolUse block in json mode as a tool call, not as the object", () =>
      Effect.gen(function*() {
        const Lookup = Tool.make("Lookup", {
          description: "Look something up",
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.String
        })
        const toolkit = Toolkit.make(Lookup)
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(objectResponse(request, [
            { toolUse: { toolUseId: "tu_1", name: "Lookup", input: { key: "a" } } },
            { text: "{\"ok\":true}" }
          ]))
        }

        const result = yield* LanguageModel.generateObject({
          prompt: "x",
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean }),
          toolkit
        }).pipe(
          Effect.provide(layersFor(handler, claude)),
          Effect.provide(toolkit.toLayer({ Lookup: () => Effect.succeed("found") }))
        )

        assert.deepStrictEqual(result.value, { ok: true })
        assert.strictEqual(result.toolCalls.length, 1)
        assert.strictEqual(result.toolCalls[0].name, "Lookup")

        // The caller's tools still go out, unforced, next to the output format.
        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "Lookup")
        assert.isDefined(body.outputConfig.textFormat)
      }))
  })

  describe("a prompt with tool calls", () => {
    const ReadFile = Tool.make("readFile", {
      description: "Read a file",
      parameters: Schema.Struct({ path: Schema.String }),
      success: Schema.String
    })
    const toolkit = Toolkit.make(ReadFile)
    const toolkitLayer = toolkit.toLayer({ readFile: () => Effect.succeed("ok") })

    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Read a.txt." })] }),
      Prompt.makeMessage("assistant", {
        content: [Prompt.makePart("tool-call", {
          id: "tu_1",
          name: "readFile",
          params: { path: "a.txt" },
          providerExecuted: false
        })]
      }),
      Prompt.makeMessage("tool", {
        content: [Prompt.makePart("tool-result", {
          id: "tu_1",
          name: "readFile",
          isFailure: false,
          result: "ok",
          providerExecuted: false
        })]
      }),
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Does it say ok?" })] })
    ])

    const makeHandler = (
      content: ReadonlyArray<unknown> = [{ toolUse: { toolUseId: "tu_2", name: "result", input: { ok: true } } }]
    ) => {
      const bodies: Array<any> = []
      const handler = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.map(getRequestBody(request), (body) => {
          bodies.push(body)
          return jsonResponse(request, {
            output: { message: { role: "assistant", content } },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            stopReason: "tool_use"
          })
        })
      return { bodies, handler }
    }

    const noToolConfigMessage = "AmazonBedrockLanguageModel.makeRequest: Invalid user input: The prompt " +
      "contains tool calls or tool results, and Converse rejects them in a request that carries no tools. " +
      "This request has none: it was given no tools, its toolChoice is a oneOf that names none of them, " +
      "or its toolChoice is \"none\", which Converse cannot express. Pass the toolkit that produced the " +
      "tool calls, with toolChoice \"auto\"."

    it.effect("fails before sending a request that offers no tools", () =>
      Effect.gen(function*() {
        const { bodies, handler } = makeHandler()

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt }).pipe(Effect.provide(layersFor(handler)))
        )

        assert.strictEqual(bodies.length, 0)
        assert.strictEqual(error.reason._tag, "InvalidUserInputError")
        assert.strictEqual(error.message, noToolConfigMessage)
      }))

    it.effect("fails before sending a request whose toolChoice is 'none'", () =>
      Effect.gen(function*() {
        const { bodies, handler } = makeHandler()

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt, toolkit, toolChoice: "none" }).pipe(
            Effect.provide(layersFor(handler)),
            Effect.provide(toolkitLayer)
          )
        )

        assert.strictEqual(bodies.length, 0)
        assert.strictEqual(error.reason._tag, "InvalidUserInputError")
        assert.strictEqual(error.message, noToolConfigMessage)
      }))

    it.effect("fails before sending a request whose toolChoice is a oneOf that names no tool", () =>
      Effect.gen(function*() {
        const { bodies, handler } = makeHandler()

        const error = yield* Effect.flip(
          LanguageModel.generateText({ prompt, toolkit, toolChoice: { oneOf: [] } }).pipe(
            Effect.provide(layersFor(handler)),
            Effect.provide(toolkitLayer)
          )
        )

        assert.strictEqual(bodies.length, 0)
        assert.strictEqual(error.reason._tag, "InvalidUserInputError")
        assert.strictEqual(error.message, noToolConfigMessage)
      }))

    // Without tools a native request would carry no `toolConfig`, so
    // generateObject asks for the object through the tool on every model.
    for (
      const { model, toolChoice } of [
        { model: "us.test.model-v1:0", toolChoice: { any: {} } },
        { model: "eu.anthropic.claude-opus-5-5", toolChoice: { auto: {} } }
      ]
    ) {
      it.effect(`asks generateObject on ${model} for the object through the tool when no tools go out`, () =>
        Effect.gen(function*() {
          const { bodies, handler } = makeHandler()
          const schema = Schema.Struct({ ok: Schema.Boolean })

          const withoutToolkit = yield* LanguageModel.generateObject({ prompt, objectName: "result", schema }).pipe(
            Effect.provide(layersFor(handler, model))
          )
          const withNone = yield* LanguageModel.generateObject({
            prompt,
            objectName: "result",
            schema,
            toolkit,
            toolChoice: "none"
          }).pipe(Effect.provide(layersFor(handler, model)), Effect.provide(toolkitLayer))

          assert.deepStrictEqual(withoutToolkit.value, { ok: true })
          assert.deepStrictEqual(withNone.value, { ok: true })
          assert.strictEqual(bodies.length, 2)
          for (const body of bodies) {
            assert.isUndefined(body.outputConfig)
            assert.deepStrictEqual(body.toolConfig.tools.map((tool: any) => tool.toolSpec.name), ["result"])
            assert.deepStrictEqual(body.toolConfig.toolChoice, toolChoice)
          }
        }))
    }

    it.effect("sends a request whose config carries a toolConfig", () =>
      Effect.gen(function*() {
        const { bodies, handler } = makeHandler([{ text: "Yes." }])
        const toolConfig = {
          tools: [{ toolSpec: { name: "readFile", inputSchema: { json: { type: "object" } } } }]
        }

        const response = yield* LanguageModel.generateText({ prompt }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ toolConfig }),
          Effect.provide(layersFor(handler))
        )

        assert.strictEqual(response.text, "Yes.")
        assert.strictEqual(bodies.length, 1)
        assert.deepStrictEqual(bodies[0].toolConfig, toolConfig)
      }))

    it.effect("sends the object tool as the toolConfig of a generateObject request", () =>
      Effect.gen(function*() {
        const { bodies, handler } = makeHandler()

        const result = yield* LanguageModel.generateObject({
          prompt,
          objectName: "result",
          schema: Schema.Struct({ ok: Schema.Boolean })
        }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false }),
          Effect.provide(layersFor(handler))
        )

        assert.deepStrictEqual(result.value, { ok: true })
        assert.strictEqual(bodies.length, 1)
        assert.deepStrictEqual(bodies[0].toolConfig.tools.map((tool: any) => tool.toolSpec.name), ["result"])
        assert.deepStrictEqual(bodies[0].messages[1].content[0].toolUse, {
          toolUseId: "tu_1",
          name: "readFile",
          input: { path: "a.txt" }
        })
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
            delta: { citation: { title: "source" } }
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

    it.effect("finishes with reason other on a stop reason outside the known set", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Partial answer" } }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("messageStop", { stopReason: "brand_new_reason" }),
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
        const delta = parts[2]!
        assert.strictEqual(delta.type === "text-delta" && delta.delta, "Partial answer")
        const finish = parts[4]!
        assert.strictEqual(finish.type === "finish" && finish.reason, "other")
      }))

    it.effect("streams reasoningContent deltas as reasoning parts", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me " } } }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "think" } } }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: "sig_abc" } }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Answer" } }),
          eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
          eventFrame("messageStop", { stopReason: "end_turn" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ]

        const parts = yield* streamParts(frames)
        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "reasoning-start",
          "reasoning-delta",
          "reasoning-delta",
          "reasoning-delta",
          "reasoning-end",
          "text-start",
          "text-delta",
          "text-end",
          "finish"
        ])

        const reasoningDeltas = parts.filter((part) => part.type === "reasoning-delta")
        assert.deepStrictEqual(
          reasoningDeltas.map((part) => (part as { delta: string }).delta),
          ["Let me ", "think", ""]
        )
        // The signature arrives as its own delta and rides along as metadata,
        // since a `reasoning-delta` carries no other place to put it.
        assert.deepStrictEqual((reasoningDeltas[2] as any).metadata, {
          amazonBedrock: { info: { type: "reasoningText", signature: "sig_abc" } }
        })
      }))

    it.effect("streams a redacted reasoning delta as an empty reasoning part", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: "cmVkYWN0ZWQ=" } }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("messageStop", { stopReason: "end_turn" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ]

        const parts = yield* streamParts(frames)
        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "reasoning-start",
          "reasoning-delta",
          "reasoning-end",
          "finish"
        ])
        const delta = parts.find((part) => part.type === "reasoning-delta")
        assert.strictEqual((delta as any).delta, "")
        assert.deepStrictEqual((delta as any).metadata, {
          amazonBedrock: { info: { type: "redactedContent", redactedContent: "cmVkYWN0ZWQ=" } }
        })
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

    const StreamGlobTool = Tool.make("GlobTool", {
      description: "Search for files",
      parameters: Schema.Struct({ pattern: Schema.String }),
      success: Schema.String
    })
    const streamGlobToolkit = Toolkit.make(StreamGlobTool)
    const streamGlobToolkitLayer = streamGlobToolkit.toLayer({ GlobTool: () => Effect.succeed("found.ts") })

    const toolStreamFrames: ReadonlyArray<Uint8Array> = [
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("contentBlockStart", {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "tu_1", name: "GlobTool" } }
      }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{\"pattern\":" } } }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "\"*.ts\"}" } } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("messageStop", { stopReason: "tool_use" }),
      eventFrame("metadata", { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } })
    ]

    const streamToolParts = (frames: ReadonlyArray<Uint8Array>) =>
      LanguageModel.streamText({
        prompt: "find ts files",
        toolkit: streamGlobToolkit,
        // Do not auto-resolve the tool call; we want to inspect the emitted parts.
        disableToolCallResolution: true
      }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => globalThis.Array.from(chunk)),
        Effect.provide(layersFor((request) => Effect.succeed(binaryResponse(request, concat(frames))))),
        Effect.provide(streamGlobToolkitLayer)
      )

    it.effect("streams a tool-use block as tool-params parts and a final tool-call", () =>
      Effect.gen(function*() {
        const parts = yield* streamToolParts(toolStreamFrames)
        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "tool-params-start",
          "tool-params-delta",
          "tool-params-delta",
          "tool-params-end",
          "tool-call",
          "finish"
        ])

        const start = parts.find((part) => part.type === "tool-params-start")
        if (start?.type === "tool-params-start") {
          assert.strictEqual(start.id, "tu_1")
          assert.strictEqual(start.name, "GlobTool")
        }

        const deltas = parts
          .filter((part) => part.type === "tool-params-delta")
          .map((part) => (part as { delta: string }).delta)
        assert.deepStrictEqual(deltas, ["{\"pattern\":", "\"*.ts\"}"])

        const toolCall = parts.find((part) => part.type === "tool-call")
        if (toolCall?.type === "tool-call") {
          assert.strictEqual(toolCall.id, "tu_1")
          assert.strictEqual(toolCall.name, "GlobTool")
          assert.deepStrictEqual(toolCall.params, { pattern: "*.ts" })
        }

        const finish = parts[parts.length - 1]!
        if (finish.type === "finish") {
          assert.strictEqual(finish.reason, "tool-calls")
        }
      }))

    it.effect("emits an empty params object for a tool-use block with no deltas", () =>
      Effect.gen(function*() {
        // A tool taking no arguments: Bedrock announces the block and stops it
        // without ever sending a `toolUse` delta.
        const PingTool = Tool.make("PingTool", {
          description: "Ping",
          parameters: Schema.Struct({}),
          success: Schema.String
        })
        const pingToolkit = Toolkit.make(PingTool)

        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockStart", {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tu_1", name: "PingTool" } }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("messageStop", { stopReason: "tool_use" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ]

        const parts = yield* LanguageModel.streamText({
          prompt: "ping",
          toolkit: pingToolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => globalThis.Array.from(chunk)),
          Effect.provide(layersFor((request) => Effect.succeed(binaryResponse(request, concat(frames))))),
          Effect.provide(pingToolkit.toLayer({ PingTool: () => Effect.succeed("pong") }))
        )

        const toolCall = parts.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type === "tool-call") {
          assert.deepStrictEqual(toolCall.params, {})
        }
      }))

    it.effect("fails with an InvalidOutputError when the streamed tool input is not JSON", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(streamToolParts([
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockStart", {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tu_1", name: "GlobTool" } }
          }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { toolUse: { input: "city\": \"Zurich\"}" } }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("messageStop", { stopReason: "tool_use" }),
          eventFrame("metadata", { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } })
        ]))

        assert.strictEqual(error._tag, "AiError")
        assert.strictEqual(error.reason._tag, "InvalidOutputError")
        assert.strictEqual(
          error.message,
          "AmazonBedrockLanguageModel.makeStreamResponse: Invalid output: Bedrock streamed input for the " +
            "`GlobTool` tool that is not valid JSON: city\": \"Zurich\"}"
        )
      }))

    it.effect("keeps text and tool blocks separate by content-block index", () =>
      Effect.gen(function*() {
        const parts = yield* streamToolParts([
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Looking" } }),
          eventFrame("contentBlockStart", {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: "tu_1", name: "GlobTool" } }
          }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 1,
            delta: { toolUse: { input: "{\"pattern\":\"*.ts\"}" } }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
          eventFrame("messageStop", { stopReason: "tool_use" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ])

        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "text-start",
          "text-delta",
          "tool-params-start",
          "tool-params-delta",
          "text-end",
          "tool-params-end",
          "tool-call",
          "finish"
        ])
      }))

    it.effect("sends toolConfig on the converse-stream request", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(binaryResponse(request, concat(toolStreamFrames)))
        }

        yield* LanguageModel.streamText({
          prompt: "find ts files",
          toolkit: streamGlobToolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runDrain,
          Effect.provide(layersFor(handler)),
          Effect.provide(streamGlobToolkitLayer)
        )

        assert.strictEqual(
          captured!.url,
          "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.test.model-v1:0/converse-stream"
        )
        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GlobTool")
      }))

    it.effect("decodes a citation delta into a document source part", () =>
      Effect.gen(function*() {
        const frames = [
          eventFrame("messageStart", { role: "assistant" }),
          eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Revenue grew 12%." } }),
          eventFrame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: {
              citation: {
                title: "Q3 revenue",
                sourceContent: [{ text: "revenue increased by 12 percent" }],
                location: { documentChar: { documentIndex: 0, start: 100, end: 140 } }
              }
            }
          }),
          eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
          eventFrame("messageStop", { stopReason: "end_turn" }),
          eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
        ]

        const parts = yield* LanguageModel.streamText({
          prompt: Prompt.fromMessages([
            Prompt.makeMessage("user", {
              content: [
                Prompt.makePart("file", {
                  mediaType: "application/pdf",
                  fileName: "report.pdf",
                  data: "AQID",
                  options: { amazonBedrock: { citations: { enabled: true } } }
                }),
                Prompt.makePart("text", { text: "Summarize" })
              ]
            })
          ])
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => globalThis.Array.from(chunk)),
          Effect.provide(layersFor((request) => Effect.succeed(binaryResponse(request, concat(frames)))))
        )

        assert.deepStrictEqual(parts.map((part) => part.type), [
          "response-metadata",
          "text-start",
          "text-delta",
          "source",
          "text-end",
          "finish"
        ])
        const source = parts.find((part) => part.type === "source") as any
        assert.strictEqual(source.sourceType, "document")
        assert.strictEqual(source.title, "Q3 revenue")
        assert.strictEqual(source.mediaType, "application/pdf")
        assert.deepStrictEqual(source.metadata.amazonBedrock, {
          location: "documentChar",
          citedText: "revenue increased by 12 percent",
          start: 100,
          end: 140,
          source: null
        })
      }))
  })
  describe("session token", () => {
    const sessionToken = "FAKE-SESSION-TOKEN-0123"
    const layer = AmazonBedrockLanguageModel.layer({ model: "us.test.model-v1:0" }).pipe(
      Layer.provide(AmazonBedrockClient.layer({
        accessKeyId: "AKIA_TEST",
        secretAccessKey: Redacted.make("test-secret"),
        sessionToken: Redacted.make(sessionToken),
        region: "us-east-1"
      })),
      Layer.provide(Layer.succeed(
        HttpClient.HttpClient,
        makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, { message: "Forbidden" }, 403, {
            "x-amz-security-token": sessionToken
          }))
        )
      ))
    )

    const tokenHeaders = (error: AiError.AiError) => {
      const http = error.reason._tag === "AuthenticationError" ? error.reason.http : undefined
      return [
        String(http?.request.headers["x-amz-security-token"]),
        String(http?.response?.headers["x-amz-security-token"])
      ]
    }

    it.effect("is redacted in the request and response headers of a generateText error", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layer)))
        assert.deepStrictEqual(tokenHeaders(error), ["<redacted>", "<redacted>"])
      }))

    it.effect("is redacted in the request and response headers of a streamText error", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          LanguageModel.streamText({ prompt: "Hello" }).pipe(Stream.runDrain, Effect.provide(layer))
        )
        assert.deepStrictEqual(tokenHeaders(error), ["<redacted>", "<redacted>"])
      }))
  })
  describe("additionalModelRequestFields", () => {
    const reasoningConfig = { thinking: { type: "enabled", budget_tokens: 1024 } }

    it.effect("carries the configured fields into the Converse request", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(jsonResponse(request, {
            output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            stopReason: "end_turn"
          }))
        }

        yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({
            additionalModelRequestFields: reasoningConfig,
            inferenceConfig: { maxTokens: 2048 }
          }),
          Effect.provide(layersFor(handler))
        )

        const body = yield* getRequestBody(captured!)
        assert.deepStrictEqual(body.additionalModelRequestFields, reasoningConfig)
      }))

    it.effect("carries the configured fields into the converse-stream request", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(binaryResponse(request, concat(happyPathFrames)))
        }

        yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runDrain,
          AmazonBedrockLanguageModel.withConfigOverride({
            additionalModelRequestFields: reasoningConfig
          }),
          Effect.provide(layersFor(handler))
        )

        const body = yield* getRequestBody(captured!)
        assert.deepStrictEqual(body.additionalModelRequestFields, reasoningConfig)
      }))

    it.effect("omits the key entirely when no fields are configured", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(jsonResponse(request, {
            output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            stopReason: "end_turn"
          }))
        }

        yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          Effect.provide(layersFor(handler))
        )

        const body = yield* getRequestBody(captured!)
        assert.notProperty(body, "additionalModelRequestFields")
      }))
  })

  describe("guardrailConfig", () => {
    const streamGuardrail = {
      guardrailIdentifier: "gr-layer",
      guardrailVersion: "DRAFT",
      trace: "enabled",
      streamProcessingMode: "async"
    } as const
    const converseHandler =
      (captured: Array<HttpClientRequest.HttpClientRequest>) => (request: HttpClientRequest.HttpClientRequest) => {
        captured.push(request)
        return Effect.succeed(jsonResponse(request, {
          output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: "end_turn"
        }))
      }
    const streamHandler =
      (captured: Array<HttpClientRequest.HttpClientRequest>) => (request: HttpClientRequest.HttpClientRequest) => {
        captured.push(request)
        return Effect.succeed(binaryResponse(request, concat(happyPathFrames)))
      }

    it.effect("sends the guardrail to Converse without streamProcessingMode", () =>
      Effect.gen(function*() {
        const captured: Array<HttpClientRequest.HttpClientRequest> = []
        yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          Effect.provide(layersFor(converseHandler(captured), undefined, { guardrailConfig: streamGuardrail }))
        )

        assert.strictEqual(captured[0]!.url.endsWith("/converse"), true)
        const body = yield* getRequestBody(captured[0]!)
        assert.deepStrictEqual(body.guardrailConfig, {
          guardrailIdentifier: "gr-layer",
          guardrailVersion: "DRAFT",
          trace: "enabled"
        })
      }))

    it.effect("sends the guardrail to converse-stream with streamProcessingMode", () =>
      Effect.gen(function*() {
        const captured: Array<HttpClientRequest.HttpClientRequest> = []
        yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runDrain,
          Effect.provide(layersFor(streamHandler(captured), undefined, { guardrailConfig: streamGuardrail }))
        )

        assert.strictEqual(captured[0]!.url.endsWith("/converse-stream"), true)
        const body = yield* getRequestBody(captured[0]!)
        assert.deepStrictEqual(body.guardrailConfig, {
          guardrailIdentifier: "gr-layer",
          guardrailVersion: "DRAFT",
          trace: "enabled",
          streamProcessingMode: "async"
        })
      }))

    it.effect("omits the key on both paths when no guardrail is configured", () =>
      Effect.gen(function*() {
        const captured: Array<HttpClientRequest.HttpClientRequest> = []
        yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          Effect.provide(layersFor(converseHandler(captured)))
        )
        yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runDrain,
          Effect.provide(layersFor(streamHandler(captured)))
        )

        assert.notProperty(yield* getRequestBody(captured[0]!), "guardrailConfig")
        assert.notProperty(yield* getRequestBody(captured[1]!), "guardrailConfig")
      }))

    it.effect("turns off the layer's guardrail with an undefined override", () =>
      Effect.gen(function*() {
        const captured: Array<HttpClientRequest.HttpClientRequest> = []
        yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          AmazonBedrockLanguageModel.withConfigOverride({ guardrailConfig: undefined }),
          Effect.provide(layersFor(converseHandler(captured), undefined, { guardrailConfig: streamGuardrail }))
        )
        yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runDrain,
          AmazonBedrockLanguageModel.withConfigOverride({ guardrailConfig: undefined }),
          Effect.provide(layersFor(streamHandler(captured), undefined, { guardrailConfig: streamGuardrail }))
        )

        assert.notProperty(yield* getRequestBody(captured[0]!), "guardrailConfig")
        assert.notProperty(yield* getRequestBody(captured[1]!), "guardrailConfig")
      }))

    it.effect("replaces the whole guardrail of the layer with an override", () =>
      Effect.gen(function*() {
        const captured: Array<HttpClientRequest.HttpClientRequest> = []
        yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runDrain,
          AmazonBedrockLanguageModel.withConfigOverride({
            guardrailConfig: { guardrailIdentifier: "gr-override", guardrailVersion: "2" }
          }),
          Effect.provide(layersFor(streamHandler(captured), undefined, { guardrailConfig: streamGuardrail }))
        )

        const body = yield* getRequestBody(captured[0]!)
        assert.deepStrictEqual(body.guardrailConfig, { guardrailIdentifier: "gr-override", guardrailVersion: "2" })
      }))
  })

  describe("finish metadata", () => {
    const blockedResponse = (request: HttpClientRequest.HttpClientRequest, trace?: unknown) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content: [{ text: "BLOCKED_INPUT_MESSAGE" }] } },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: "guardrail_intervened",
        ...(trace === undefined ? {} : { trace })
      })

    const streamFrames = (stopReason: string | undefined, trace: unknown) => [
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ticket {TICKET}" } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      ...(stopReason === undefined ? [] : [eventFrame("messageStop", { stopReason })]),
      eventFrame("metadata", {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        ...(trace === undefined ? {} : { trace })
      })
    ]

    it.effect("reports the stop reason and what the guardrail did on generateText", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: "zorptangle" }).pipe(
          Effect.provide(layersFor((request) => Effect.succeed(blockedResponse(request, inputBlockedTrace))))
        )

        assert.strictEqual(response.text, "BLOCKED_INPUT_MESSAGE")
        assert.strictEqual(response.finishReason, "content-filter")
        const finish = response.content.find((part) => part.type === "finish")
        assert.deepStrictEqual(finish?.metadata.amazonBedrock, {
          stopReason: "guardrail_intervened",
          guardrail: { input: "blocked", output: "none", policies: ["wordPolicy"] },
          trace: inputBlockedTrace
        })
      }))

    it.effect("reports the stop reason without a trace on generateText", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: "zorptangle" }).pipe(
          Effect.provide(layersFor((request) => Effect.succeed(blockedResponse(request))))
        )

        const finish = response.content.find((part) => part.type === "finish")
        assert.deepStrictEqual(finish?.metadata.amazonBedrock, {
          stopReason: "guardrail_intervened",
          guardrail: null,
          trace: null
        })
      }))

    it.effect("reports the stop reason and what the guardrail did on streamText", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "Repeat TKT-123456" }).pipe(
          Stream.runCollect,
          Effect.provide(layersFor((request) =>
            Effect.succeed(binaryResponse(request, concat(streamFrames("guardrail_intervened", outputMaskedTrace))))
          ))
        )

        const finish = parts.find((part) =>
          part.type === "finish"
        )
        assert.strictEqual(finish?.reason, "content-filter")
        assert.deepStrictEqual(finish?.metadata.amazonBedrock, {
          stopReason: "guardrail_intervened",
          guardrail: { input: "none", output: "masked", policies: ["sensitiveInformationPolicy"] },
          trace: outputMaskedTrace
        })
      }))

    it.effect("reports a null stop reason when a stream ends without messageStop", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.provide(
            layersFor((request) => Effect.succeed(binaryResponse(request, concat(streamFrames(undefined, undefined)))))
          )
        )

        const finish = parts.find((part) => part.type === "finish")
        assert.deepStrictEqual(finish?.metadata.amazonBedrock, { stopReason: null, guardrail: null, trace: null })
      }))

    it.effect("reports the raw stop reason when no guardrail is configured", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.provide(layersFor((request) => Effect.succeed(binaryResponse(request, concat(happyPathFrames)))))
        )

        const finish = parts.find((part) => part.type === "finish")
        assert.deepStrictEqual(finish?.metadata.amazonBedrock, { stopReason: "end_turn", guardrail: null, trace: null })
      }))
  })

  describe("generateObject when a guardrail intervenes", () => {
    const Ticket = Schema.Struct({ ticket: Schema.String })
    const claude = "eu.anthropic.claude-opus-4-8"
    const toolPath = AmazonBedrockLanguageModel.withConfigOverride({ structuredOutputs: false })
    const guardrailResponse = (
      request: HttpClientRequest.HttpClientRequest,
      content: ReadonlyArray<unknown>,
      trace?: unknown
    ) =>
      jsonResponse(request, {
        output: { message: { role: "assistant", content } },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: "guardrail_intervened",
        ...(trace === undefined ? {} : { trace })
      })
    const blockedDescription = "An Amazon Bedrock guardrail intervened, and the response holds no JSON object. " +
      "Bedrock answered: BLOCKED_INPUT_MESSAGE"

    it.effect("fails with ContentPolicyError on the native path", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateObject({ prompt: "zorptangle", schema: Ticket }).pipe(
          Effect.provide(layersFor(
            (request) =>
              Effect.succeed(guardrailResponse(request, [{ text: "BLOCKED_INPUT_MESSAGE" }], inputBlockedTrace)),
            claude
          )),
          Effect.flip
        )

        assert.strictEqual(error.reason._tag, "ContentPolicyError")
        assert.strictEqual(error.isRetryable, false)
        if (error.reason._tag === "ContentPolicyError") {
          assert.strictEqual(error.reason.description, blockedDescription)
          assert.deepStrictEqual(error.reason.metadata.amazonBedrock, {
            stopReason: "guardrail_intervened",
            guardrail: { input: "blocked", output: "none", policies: ["wordPolicy"] },
            trace: inputBlockedTrace
          })
        }
      }))

    it.effect("fails with ContentPolicyError on the object tool path", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateObject({ prompt: "zorptangle", schema: Ticket }).pipe(
          toolPath,
          Effect.provide(layersFor(
            (request) => Effect.succeed(guardrailResponse(request, [{ text: "BLOCKED_INPUT_MESSAGE" }])),
            claude
          )),
          Effect.flip
        )

        assert.strictEqual(error.reason._tag, "ContentPolicyError")
        assert.strictEqual(error.isRetryable, false)
        if (error.reason._tag === "ContentPolicyError") {
          assert.strictEqual(error.reason.description, blockedDescription)
          assert.deepStrictEqual(error.reason.metadata.amazonBedrock, {
            stopReason: "guardrail_intervened",
            guardrail: null,
            trace: null
          })
        }
      }))

    it.effect("quotes only the first 200 characters of the response", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateObject({ prompt: "zorptangle", schema: Ticket }).pipe(
          Effect.provide(layersFor(
            (request) =>
              Effect.succeed(guardrailResponse(request, [{ text: "x".repeat(150) }, { text: "y".repeat(150) }])),
            claude
          )),
          Effect.flip
        )

        assert.strictEqual(
          error.reason._tag === "ContentPolicyError" ? error.reason.description : undefined,
          "An Amazon Bedrock guardrail intervened, and the response holds no JSON object. Bedrock answered: " +
            `${"x".repeat(150)}${"y".repeat(50)}...`
        )
      }))

    it.effect("decodes a masked object on the native path", () =>
      Effect.gen(function*() {
        const result = yield* LanguageModel.generateObject({ prompt: "Repeat TKT-123456", schema: Ticket }).pipe(
          Effect.provide(layersFor(
            (request) =>
              Effect.succeed(guardrailResponse(request, [{ text: "{\"ticket\":\"{TICKET}\"}" }], outputMaskedTrace)),
            claude
          ))
        )

        assert.deepStrictEqual(result.value, { ticket: "{TICKET}" })
      }))

    it.effect("decodes a masked object on the object tool path", () =>
      Effect.gen(function*() {
        const result = yield* LanguageModel.generateObject({
          prompt: "Repeat TKT-123456",
          objectName: "Ticket",
          schema: Ticket
        }).pipe(
          toolPath,
          Effect.provide(layersFor(
            (request) =>
              Effect.succeed(guardrailResponse(request, [
                { text: "Here it is." },
                { toolUse: { toolUseId: "tu_1", name: "Ticket", input: { ticket: "{TICKET}" } } }
              ])),
            claude
          ))
        )

        assert.deepStrictEqual(result.value, { ticket: "{TICKET}" })
      }))

    it.effect("leaves generateText to answer with the blocked message", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: "zorptangle" }).pipe(
          Effect.provide(layersFor(
            (request) => Effect.succeed(guardrailResponse(request, [{ text: "BLOCKED_INPUT_MESSAGE" }])),
            claude
          ))
        )

        assert.strictEqual(response.text, "BLOCKED_INPUT_MESSAGE")
      }))
  })
})
