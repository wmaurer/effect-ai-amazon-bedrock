# A prompt with tool history and no tools gets a 400 from Converse

## Summary

`prepareTools` omits `toolConfig` when the request has no tools or when `toolChoice` is `"none"`.
Converse rejects a request without `toolConfig` when its messages contain `toolUse` or `toolResult` blocks.
So any call whose prompt carries earlier tool calls, but which offers no tools, fails with a 400:

```
AmazonBedrockClient.converse: Invalid request. The toolConfig field must be defined when using toolUse and
toolResult content blocks.
```

The error reaches the caller as `InvalidRequestError`. It does not say that the request was built this way by
the provider, or that `toolChoice: "none"` is the cause.

## Where

`packages/amazon-bedrock/src/AmazonBedrockLanguageModel.ts`, in `prepareTools`:

```ts
if (options.tools.length === 0 || options.toolChoice === "none") {
  return { toolConfig: undefined, nameMapper }
}
```

This is line 1002 on `main` and `br-2b`, and line 1121 on `br-2a`. The vendored
`@effect/ai-amazon-bedrock` 4.0.3 tarball has the same code.

Converse cannot express "no tool may be called". Its `ToolChoice` has three members only: `auto`, `any` and
`tool` (see `ToolChoice` in `AmazonBedrockSchema.ts`). The Anthropic Messages API has `tool_choice: none`;
Converse does not.

## When it happens

The common case is an agent loop. The loop runs `generateText` with a toolkit for several turns, then asks for a
final structured answer with `generateObject` on the same chat, without the toolkit or with
`toolChoice: "none"`. The history then holds `toolUse` and `toolResult` blocks, and the last request has no
`toolConfig`.

On a model that uses the object-tool fallback for `generateObject` (Opus 5.5 today), the request does carry a
`toolConfig`, because the object tool is in it. So the same call succeeds there, and fails only on models with
native structured output, or on `generateText`.

## Observed

Live, Bedrock `eu-west-1`, 2026-10-17. The prompt is: user message, assistant `tool-call` (`readFile`), `tool`
message with its `tool-result`, user message asking for the answer. Schema `{ ok: Boolean }`.

| Model                          | Call                                      | Result                        |
| ------------------------------ | ----------------------------------------- | ----------------------------- |
| `eu.anthropic.claude-opus-4-8` | `generateObject`, no toolkit              | 400, toolConfig must be defined |
| `eu.anthropic.claude-opus-4-8` | `generateObject`, toolkit, `"none"`       | 400, toolConfig must be defined |
| `eu.anthropic.claude-opus-4-8` | `generateObject`, toolkit, `"auto"`       | accepted, `{ ok: true }`      |
| `eu.anthropic.claude-sonnet-5` | `generateObject`, no toolkit              | 400, toolConfig must be defined |
| `eu.anthropic.claude-sonnet-5` | `generateObject`, toolkit, `"none"`       | 400, toolConfig must be defined |
| `eu.anthropic.claude-sonnet-5` | `generateObject`, toolkit, `"auto"`       | accepted                      |
| `eu.anthropic.claude-sonnet-5` | `generateText`, no toolkit                | 400, toolConfig must be defined |
| `eu.anthropic.claude-opus-5-5` | `generateObject`, no toolkit              | accepted (object tool sent)   |
| `eu.anthropic.claude-opus-5-5` | `generateObject`, toolkit, `"none"`       | accepted (object tool sent)   |
| `eu.anthropic.claude-opus-5-5` | `generateObject`, toolkit, `"auto"`       | accepted                      |

The Opus 4.8 and Opus 5.5 runs set `outputConfig.effort: "high"`, the Sonnet 5 `generateObject` runs set
`"low"`. Effort did not change the result.

## Repro

```ts
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"

const client = Layer.effect(
  AmazonBedrockClient.AmazonBedrockClient,
  Effect.gen(function*() {
    return yield* AmazonBedrockClient.make({
      accessKeyId: yield* Config.String("AWS_ACCESS_KEY_ID"),
      secretAccessKey: yield* Config.Redacted("AWS_SECRET_ACCESS_KEY"),
      sessionToken: Option.getOrUndefined(yield* Config.option(Config.Redacted("AWS_SESSION_TOKEN"))),
      region: "eu-west-1"
    })
  })
).pipe(Layer.provide(NodeHttpClient.layerUndici))

const model = AmazonBedrockLanguageModel.layer({
  model: "eu.anthropic.claude-sonnet-5",
  config: { inferenceConfig: { maxTokens: 100 } }
}).pipe(Layer.provide(client))

const prompt = [
  { role: "user", content: "Read a.txt and report whether it says ok." },
  {
    role: "assistant",
    content: [{ type: "tool-call", id: "toolu_01", name: "readFile", params: { path: "a.txt" }, providerExecuted: false }]
  },
  {
    role: "tool",
    content: [{
      type: "tool-result",
      id: "toolu_01",
      name: "readFile",
      isFailure: false,
      result: { content: "ok" },
      providerExecuted: false
    }]
  },
  { role: "user", content: "Answer in one word." }
] as never

// Fails with InvalidRequestError: "The toolConfig field must be defined when using toolUse and toolResult
// content blocks."
await Effect.runPromise(LanguageModel.generateText({ prompt }).pipe(Effect.provide(model)))
```

## Proposed change

Detect the case before the request is sent: the prompt contains a `tool-call` or `tool-result` part, and
`prepareTools` would return no `toolConfig`. Then fail with `AiError.InvalidUserInputError`, with a description
that names both causes:

- with `toolChoice: "none"`: Converse has no "none" tool choice, so a prompt with tool history must offer its
  tools with `"auto"` or another choice.
- with no tools: Converse needs the tool definitions for a prompt that contains tool calls, so pass the toolkit
  that produced them.

The alternative is to send the tools with `{ auto: {} }` when the caller asked for `"none"`. That gives the
model a choice the caller did not allow, so a caller could receive tool calls it does not handle. An explicit
error is safer, and the README can show the `"auto"` workaround.

Tests:

- A unit test for each case (no tools, `toolChoice: "none"`) that asserts `InvalidUserInputError` and that no
  HTTP request was sent.
- A unit test that the object-tool fallback is not affected: the object tool alone is a valid `toolConfig`.
- A live test of the `"auto"` workaround on a native-structured-output model.

## Workaround for callers

Pass the toolkit that produced the history, with `toolChoice: "auto"`. This works on every model in the table
above. The model may then call a tool instead of answering. A caller that cannot accept that needs to remove
the tool blocks from the history first, for example by rewriting them as text.
