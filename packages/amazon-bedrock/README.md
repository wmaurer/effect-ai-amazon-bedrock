# @wmaurer/effect-ai-amazon-bedrock

An [Amazon Bedrock](https://aws.amazon.com/bedrock/) provider for the Effect AI modules in `effect/ai`. `AmazonBedrockLanguageModel` provides a `LanguageModel` that calls the Bedrock Runtime Converse and ConverseStream APIs. `AmazonBedrockClient` signs each request with AWS Signature Version 4 through [`aws4fetch`](https://github.com/mhart/aws4fetch).

The package supports text generation, streaming, tool calls, structured output, images, documents, citations, prompt caching, and reasoning.

## Install the package

The package declares `effect` `^4.0.5` as a peer dependency. Its tests run on `effect` 4.0.5.

```sh
pnpm add @wmaurer/effect-ai-amazon-bedrock effect
```

The package's types need `exactOptionalPropertyTypes` or `skipLibCheck` in your `tsconfig.json`. Without either option, `tsc` reports error TS2411 on the `amazonBedrock` option types. Effect's own AI providers at 4.0.5, such as `@effect/ai-anthropic` and `@effect/ai-openai`, need the same setting. A project that already uses one of those providers already has it.

If you link the package source through a pnpm workspace or `pnpm link`, its imports resolve to `.ts` files. TypeScript 7 then reports TS2411 even with `skipLibCheck`, so set `exactOptionalPropertyTypes`.

A linked package and your project must also load the same copy of `effect`. With two copies, the client cannot read a `Redacted` value that the other copy made, and it fails with `Error: Unable to get redacted value` before it sends a request. To load one copy, add an override to your `pnpm-workspace.yaml` that points `effect` at the copy in the package's checkout, and run `pnpm install`. Replace `<checkout>` with the absolute path of your clone of this repository.

```yaml
overrides:
  effect: link:<checkout>/packages/amazon-bedrock/node_modules/effect
```

## Generate text

This program reads AWS credentials from the environment, asks a Claude model on Bedrock for one sentence, and prints the answer.

```ts
import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Config, Effect, Layer, Redacted } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"

const BedrockClient = AmazonBedrockClient.layerConfig({
  accessKeyId: Config.String("AWS_ACCESS_KEY_ID"),
  secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY"),
  sessionToken: Config.Redacted("AWS_SESSION_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
  region: Config.String("AWS_REGION")
}).pipe(Layer.provide(FetchHttpClient.layer))

const Sonnet = AmazonBedrockLanguageModel.model("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")

const program = Effect.gen(function*() {
  const response = yield* LanguageModel.generateText({
    prompt: "Describe Amazon Bedrock in one sentence."
  })
  console.log(response.text)
})

program.pipe(
  Effect.provide(Sonnet),
  Effect.provide(BedrockClient),
  Effect.runPromise
)
```

Run it with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION=eu-west-1` set. If you use temporary credentials, such as the result of `aws sts assume-role`, also set `AWS_SESSION_TOKEN`. Bedrock rejects a temporary key without its session token.

## Configure the client

`AmazonBedrockClient` needs an `HttpClient`. The example above uses `FetchHttpClient.layer` from `effect/http`.

The client takes explicit credentials. It does not read `~/.aws`, the AWS profile variables, or instance metadata. Give the credentials in one of two ways:

- `AmazonBedrockClient.layerConfig` reads each option from a `Config`, as in the example above.
- `AmazonBedrockClient.layer` takes plain values. Pass `secretAccessKey` and `sessionToken` as `Redacted` values.

`sessionToken` is optional, but `layerConfig` fails with a `ConfigError` if a `Config` that you give it finds no value. For that reason the example above gives `AWS_SESSION_TOKEN` an empty default with `Config.withDefault`. The client sends no session token when the token is empty, so the same program runs with temporary and long-lived keys.

The other options are these:

- `region` defaults to `us-east-1`.
- `apiUrl` replaces the endpoint, which defaults to `https://bedrock-runtime.<region>.amazonaws.com`.
- `transformClient` changes the `HttpClient` for every request, for example to add a retry policy. To change it for one effect only, use `AmazonBedrockConfig.withClientTransform`.

## Choose a model

Give a Bedrock model ID or an inference profile ID as the first argument of `AmazonBedrockLanguageModel.model`, or as the `model` option of `AmazonBedrockLanguageModel.layer`. Some models accept only an inference profile ID. Claude Sonnet 4.5, for example, needs a profile ID such as `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`. The model must be enabled for your account in the region of the client.

To set request defaults, give them as the second argument of `model` or as the `config` option of `layer`. The defaults take these fields:

- `inferenceConfig`, `additionalModelRequestFields`, and `toolConfig`. The provider sends each one as the Converse request field of the same name.
- `outputConfig`, which takes only `effort`. The provider sets `outputConfig.textFormat` itself. `effort` is `low`, `medium`, `high`, `xhigh`, or `max`, and a higher level lets the model reason longer before it answers. Bedrock caps it at `high` when extended thinking is off.
- `structuredOutputs`, which chooses how `generateObject` asks for the object. The provider does not send it to Bedrock. [Get structured output](#get-structured-output) explains it.

When `generateObject` asks for the object through a tool, that tool replaces your `toolConfig`. Any other request with tools replaces it with a `toolConfig` built from those tools, unless `toolChoice` is `"none"`. With no tools, or with `toolChoice` set to `"none"`, the provider sends your `toolConfig` unchanged.

To change the defaults for one request, wrap the effect in `AmazonBedrockLanguageModel.withConfigOverride`. It takes the same fields and `modelId`. Set `modelId` to send that request to a different model. Each field you give replaces the whole default field.

This example turns on extended thinking for one request on a Claude model that takes a thinking budget, such as Claude Sonnet 4.5. The thinking budget comes out of `maxTokens`, so `maxTokens` must be greater than `budget_tokens`. When `answer` runs with `Sonnet`, the override replaces all of `inferenceConfig`, so the request sends `maxTokens: 4096` and no `temperature`.

```ts
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { LanguageModel } from "effect/ai"

export const Sonnet = AmazonBedrockLanguageModel.model("eu.anthropic.claude-sonnet-4-5-20250929-v1:0", {
  inferenceConfig: { maxTokens: 1024, temperature: 0.2 }
})

export const answer = LanguageModel.generateText({
  prompt: "How many r's are in strawberry?"
}).pipe(
  AmazonBedrockLanguageModel.withConfigOverride({
    additionalModelRequestFields: {
      thinking: { type: "enabled", budget_tokens: 1024 }
    },
    inferenceConfig: { maxTokens: 4096 }
  })
)
```

The live reasoning suite treats Claude Opus 4.7 and 4.8 and the Claude Opus, Sonnet, Fable, and Mythos 5.x models as rejecting `budget_tokens` with a 400, and sends them adaptive thinking instead. On these models `outputConfig.effort` sets how much they reason, and the reasoning text is empty unless `display` is `"summarized"`. When `BEDROCK_MODEL_ID` names one of them, the suite sends this form:

```ts
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { LanguageModel } from "effect/ai"

export const adaptiveAnswer = LanguageModel.generateText({
  prompt: "How many r's are in strawberry?"
}).pipe(
  AmazonBedrockLanguageModel.withConfigOverride({
    additionalModelRequestFields: {
      thinking: { type: "adaptive", display: "summarized" }
    },
    outputConfig: { effort: "high" },
    inferenceConfig: { maxTokens: 4096 }
  })
)
```

## Get structured output

`LanguageModel.generateText`, `LanguageModel.streamText`, and `LanguageModel.generateObject` all work with this provider. By default, `generateObject` sends the schema in the Converse `outputConfig.textFormat` field, and the tools you pass go with it. The provider converts the schema with the rules for Anthropic models.

The provider keeps a list of models that get the schema as a tool instead: the Claude 3 models, Claude Sonnet 4 and Opus 4, and Claude Opus 5.5. The Claude 3, Sonnet 4, and Opus 4 entries come from Anthropic's table of models with structured output. Opus 5.5 is on the list because Bedrock rejected `outputConfig.textFormat` for it in a live run. The tool replaces the tools you pass, and the tool's input becomes the object. If the model answers in text instead of calling the tool, `effect/ai` decodes the text as the object.

On the tool path the provider forces the model to call the tool. Claude Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject a forced `toolChoice`, so for them the provider leaves the tool unforced and adds a system prompt line that tells the model to call it. Sonnet 5.5, Fable 5.1, and Mythos 5.1 take the tool path only when `structuredOutputs` is `false`.

The provider matches the model ID against its lists. Set `structuredOutputs` to `true` to send `outputConfig.textFormat` to any model, or to `false` to send the tool. The flag does not choose between the forced and the unforced tool, which also comes from the model ID. A model ID that does not name the model, such as an application inference profile ARN for Opus 5.5, therefore gets `outputConfig.textFormat` or a forced tool, and Opus 5.5 rejects both. [`docs/TODO.md`](https://github.com/wmaurer/effect-ai-amazon-bedrock/blob/main/docs/TODO.md) tracks this gap.

Every model that is not on the list gets `outputConfig.textFormat` by default. The AI SDK's Bedrock provider asks for native structured output only from an allowlist of Claude models, because it records that newer Claude models reject it on Bedrock. Its list leaves out Claude Haiku 4.5, Sonnet 4.6, Opus 4.7 and 4.8, and the 5.x models. This provider does not follow that list. On 2026-10-17 in `eu-west-1`, Bedrock accepted `outputConfig.textFormat` from this provider for `eu.anthropic.claude-opus-4-8` and `eu.anthropic.claude-sonnet-5`, in `generateObject` calls that also passed a toolkit with `toolChoice: "auto"`. Nobody has checked Claude Haiku 4.5, Sonnet 4.6, Opus 4.7, Sonnet 5.5, Fable 5.1, or Mythos 5.1 with this provider. If a request fails on one of them, try `structuredOutputs: false`, which is also unchecked on those models.

## Set Bedrock options on a prompt

The provider reads its options from the `amazonBedrock` key of the `options` field on prompt messages and parts.

To cache a prompt prefix, add `cachePoint` to the last message or part of the prefix. Bedrock caches everything before the cache point. `ttl` is `"5m"` or `"1h"`. If you leave it out, Bedrock chooses the lifetime.

```ts
import { Prompt } from "effect/ai"

declare const longInstructions: string

export const prompt = Prompt.fromMessages([
  Prompt.makeMessage("system", {
    content: longInstructions,
    options: { amazonBedrock: { cachePoint: { type: "default", ttl: "1h" } } }
  }),
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text: "Summarize the rules." })]
  })
])
```

To cache the tool list, annotate the last tool of the cached prefix with `ToolCachePoint`.

```ts
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Schema } from "effect"
import { Tool } from "effect/ai"

export const search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String })
}).annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
```

A `file` part becomes an `image` block or a `document` block. Bedrock accepts JPEG, PNG, GIF, and WebP images, and PDF, CSV, DOC, DOCX, XLS, XLSX, HTML, TXT, and Markdown documents. Give the data as base64, as a `Uint8Array`, or as an `s3://` URL. The provider does not fetch other URLs.

A document part takes two more options. `citations` lets the model cite the document, and the response then holds `source` parts that point at the cited text. `context` tells the model how to read the document.

```ts
import { Prompt } from "effect/ai"

declare const reportBase64: string

export const prompt = Prompt.fromMessages([
  Prompt.makeMessage("user", {
    content: [
      Prompt.makePart("file", {
        mediaType: "application/pdf",
        fileName: "q3-report.pdf",
        data: reportBase64,
        options: {
          amazonBedrock: {
            citations: { enabled: true },
            context: "A quarterly earnings report."
          }
        }
      }),
      Prompt.makePart("text", { text: "What was the revenue? Cite the report." })
    ]
  })
])
```

Reasoning parts carry the Bedrock signature in `metadata.amazonBedrock.info`. Bedrock accepts reasoning in a later turn only with that signature. `Prompt.fromResponseParts` and `Chat` copy it into the options of the next prompt. A reasoning part without it is left out of the request.

### Avoid a clash with another Bedrock provider

The provider adds the `amazonBedrock` key to the option and metadata types of `effect/ai` through module augmentation. If Effect ships its own Amazon Bedrock provider that uses the same key, both packages declare the same property. Install only one of them.

## Check what the provider does not support

Converse has features that this provider does not model yet:

- `additionalModelResponseFieldPaths` and the `additionalModelResponseFields` it returns.
- Video blocks. A `video/*` file part fails with `InvalidUserInputError`.
- Documents given as pre-chunked `content`.
- The `error` field of an image block.
- The `audio`, `guardContent`, `searchResult`, `toolAddition`, and `toolRemoval` content blocks, which the provider decodes and ignores.
- Citations with a `web` or `searchResultLocation` location, which the provider drops.
- System tools, which run on Bedrock.
- The Converse request fields `guardrailConfig`, `promptVariables`, `requestMetadata`, `performanceConfig`, and `serviceTier`. The request config has no key for them.

`LanguageModel.streamText` always asks for text, so streamed structured output is not available. That limit is in `effect/ai`, not in this provider.

[`docs/TODO.md`](https://github.com/wmaurer/effect-ai-amazon-bedrock/blob/main/docs/TODO.md) explains each gap and what was tested against real Bedrock.

## Where the package comes from

Tom McKenzie wrote the first version of this provider as `packages/ai/amazon-bedrock` in a fork of [`effect-ts/effect`](https://github.com/Effect-TS/effect). Wayne Maurer added tool calls, streaming tool calls, files, citations, prompt caching, and reasoning.

The package may go back to Effect as a pull request. Until then it is published here under its own name. Its source follows Effect's lint, format, and TypeScript rules, and it differs from the fork only in the package name.

## License

MIT. See [`LICENSE`](./LICENSE).
