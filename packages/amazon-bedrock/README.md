# @wmaurer/effect-ai-amazon-bedrock

An [Amazon Bedrock](https://aws.amazon.com/bedrock/) provider for the Effect AI modules in `effect/ai`. `AmazonBedrockLanguageModel` provides a `LanguageModel` that calls the Bedrock Runtime Converse and ConverseStream APIs. `AmazonBedrockClient` signs each request with AWS Signature Version 4 through [`aws4fetch`](https://github.com/mhart/aws4fetch).

The package supports text generation, streaming, tool calls, structured output, images, documents, citations, prompt caching, and reasoning.

## Install the package

```sh
pnpm add @wmaurer/effect-ai-amazon-bedrock effect
```

The package declares `effect` `^4.0.5` as a peer dependency. Its tests run on `effect` 4.0.5.

Set these options in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "exactOptionalPropertyTypes": true
  }
}
```

Effect's declaration files use `AsyncDisposable` and `Symbol.asyncDispose`, which the default library of TypeScript 6.0 and 7 does not declare. Without `"target": "esnext"`, `tsc` reports errors TS2304 and TS2550 in those files. Without `exactOptionalPropertyTypes`, `tsc` reports error TS2411 on the `amazonBedrock` option types. Effect's own AI providers at 4.0.5, such as `@effect/ai-anthropic` and `@effect/ai-openai`, need the same option, so a project that uses one of them has it already. `skipLibCheck` hides all of these errors and can replace both options.

The options work with TypeScript 6.0 and later. TypeScript 5.9 also needs `"strict": true` and `"module": "nodenext"`.

### Link the source to use unreleased changes

To use a change that is not on npm yet, link the package source from a clone of this repository. The steps need pnpm 10.5.1 or later, because they put a pnpm override in `pnpm-workspace.yaml`. Earlier versions ignore the override or reject the file. Replace `<checkout>` with the absolute path of the clone.

1. Clone the repository and run `pnpm install` in the clone. The install creates `<checkout>/packages/amazon-bedrock/node_modules/effect`, which the next step needs.

   ```sh
   git clone https://github.com/wmaurer/effect-ai-amazon-bedrock.git <checkout>
   cd <checkout>
   pnpm install
   ```

2. In your project, add an override to `pnpm-workspace.yaml` that points `effect` at the copy in the clone.

   ```yaml
   overrides:
     effect: link:<checkout>/packages/amazon-bedrock/node_modules/effect
   ```

   The linked package and your project must load the same copy of `effect`. With two copies, the client cannot read a `Redacted` value that the other copy made, and it fails with `Error: Unable to get redacted value` before it sends a request.

3. Add the linked package and `effect` to your project.

   ```sh
   pnpm add link:<checkout>/packages/amazon-bedrock effect
   ```

   Because of the override, pnpm records `effect` in your `package.json` as a `link:` path and not as a version range.

4. Set these options in your `tsconfig.json`.

   ```json
   {
     "compilerOptions": {
       "target": "esnext",
       "exactOptionalPropertyTypes": true,
       "allowImportingTsExtensions": true,
       "noEmit": true
     }
   }
   ```

   The linked package's imports resolve to its `.ts` source files. TypeScript 7 reports TS2411 on that source even with `skipLibCheck`, so set `exactOptionalPropertyTypes`. The source imports its own modules with a `.ts` extension, so without `allowImportingTsExtensions`, `tsc` reports error TS5097. `tsc` accepts `allowImportingTsExtensions` only with `noEmit`, `emitDeclarationOnly`, or `rewriteRelativeImportExtensions`, and reports error TS5096 without one of them. Set `target` for the reason that [Install the package](#install-the-package) gives. TypeScript 5.9 needs the same two extra options as there.

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

To run the program, do these steps:

1. Create a project whose `package.json` sets `"type": "module"`, and install the package.

   ```sh
   mkdir bedrock-example
   cd bedrock-example
   pnpm init --init-type module
   pnpm add @wmaurer/effect-ai-amazon-bedrock effect
   ```

   Without a `type` field, Node still runs `main.ts` as an ES module, but it first prints the warning `MODULE_TYPELESS_PACKAGE_JSON`.

2. Save the program as `main.ts` in the project.

3. Set your AWS credentials in the environment.

   ```sh
   export AWS_ACCESS_KEY_ID=<access key ID>
   export AWS_SECRET_ACCESS_KEY=<secret access key>
   ```

   If you use temporary credentials, such as the result of `aws sts assume-role`, also set `AWS_SESSION_TOKEN`. Bedrock rejects a temporary key without its session token. If either variable is missing, Node stops with an `UnhandledPromiseRejection` whose reason is `"[object Object]"`, and the message does not name the variable.

4. Run the program with Node 22.18 or a later 22 release, or with Node 23.6 or later. These versions run a TypeScript file without a build step.

   ```sh
   AWS_REGION=eu-west-1 node main.ts
   ```

## Configure the client

`AmazonBedrockClient` needs an `HttpClient`. The example above uses `FetchHttpClient.layer` from `effect/http`.

The client authenticates each request in one of three ways:

- Fixed keys. `accessKeyId`, `secretAccessKey`, and an optional `sessionToken`. The client signs each request with SigV4.
- A credential provider. `credentialProvider` is a function or an `Effect` that returns credentials. The client signs each request with SigV4 and asks the provider for new credentials before the old ones expire.
- A Bedrock API key. `apiKey` is sent as `Authorization: Bearer <key>` in place of a SigV4 signature.

Give exactly one of them. Options that mix two ways, or give none, do not compile. `AmazonBedrockClient.layerConfig` reads each value from a `Config`. `AmazonBedrockClient.layer` takes plain values, with the secrets as `Redacted` values. The client reads no environment variable and no file by itself.

### Use fixed keys

The example above reads fixed keys from the environment. `sessionToken` is optional, but `layerConfig` fails with a `ConfigError` if a `Config` that you give it finds no value. For that reason the example gives `AWS_SESSION_TOKEN` an empty default with `Config.withDefault`. The client sends no session token when the token is empty, so the same program runs with temporary and long-lived keys. AWS Lambda sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` for the function's execution role, so the example runs there without changes.

The client reads fixed keys once, when the layer is built. When temporary keys expire, every request fails with an `AuthenticationError` of kind `ExpiredKey`. A program that runs longer than its session needs a credential provider.

### Use a credential provider

A function in the shape of the AWS SDK's credential providers fits `credentialProvider` without an adapter. `fromNodeProviderChain()` from `@aws-sdk/credential-providers` looks for credentials where the AWS CLI does, in the environment, in the profiles and IAM Identity Center sessions of `~/.aws`, and in the container credentials of Amazon ECS and Amazon EKS and the instance metadata of Amazon EC2. This package does not depend on the AWS SDK, so install `@aws-sdk/credential-providers` yourself.

```ts
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { AmazonBedrockClient } from "@wmaurer/effect-ai-amazon-bedrock"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const BedrockClient = AmazonBedrockClient.layer({
  region: "eu-west-1",
  credentialProvider: fromNodeProviderChain()
}).pipe(Layer.provide(FetchHttpClient.layer))
```

The client runs the provider when a request needs credentials, and runs it once for requests that need them at the same time:

- It keeps the credentials until five minutes before their `expiration`. It keeps credentials that expire in less than five minutes for 10 seconds, and credentials without an `expiration` until Bedrock rejects them.
- If the provider fails while the last credentials have not expired, the client signs with the last credentials. It asks the provider again after 30 seconds, or when the last credentials expire if that is sooner.
- If Bedrock rejects the credentials with an `AuthenticationError` of kind `ExpiredKey`, `InvalidKey`, or `MissingKey`, the request fails, and the next request gets new credentials. The client calls a function provider with `{ forceRefresh: true }` for them. Kind `InsufficientPermissions` keeps the credentials, because new credentials for the same role have the same IAM policy.
- If the promise of a function provider rejects, the request fails with an `AuthenticationError` of kind `Unknown`. If the provider returns an empty access key ID or secret access key, the request fails with an `AuthenticationError` of kind `MissingKey`.

An `Effect` provider can load credentials from a service of your own. The layer then requires that service:

```ts
import { AmazonBedrockClient } from "@wmaurer/effect-ai-amazon-bedrock"
import { Context, Effect } from "effect"
import type { AiError } from "effect/ai"

class Vault extends Context.Service<Vault, {
  readonly bedrockCredentials: Effect.Effect<AmazonBedrockClient.Credentials, AiError.AiError>
}>()("Vault") {}

// Layer<AmazonBedrockClient, never, HttpClient | Vault>
export const BedrockClient = AmazonBedrockClient.layer({
  region: "eu-west-1",
  credentialProvider: Effect.gen(function*() {
    const vault = yield* Vault
    return yield* vault.bedrockCredentials
  })
})
```

The provider runs with the services of the request first, and the services that the layer was built with fill in the rest. A span that the provider opens is a child of the span of the request that runs the provider.

The `Effect` can fail with an `AiError`, which the request fails with unchanged, or with an `AiError` reason such as an `AuthenticationError`, which the client puts in an `AiError`.

A retry policy in `transformClient` does not retry a failed provider, because the client gets the credentials before it sends the request. Each retry of a request signs again with the credentials of the first attempt.

### Use a Bedrock API key

```ts
import { AmazonBedrockClient } from "@wmaurer/effect-ai-amazon-bedrock"
import { Config, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const BedrockClient = AmazonBedrockClient.layerConfig({
  region: Config.String("AWS_REGION"),
  apiKey: Config.Redacted("AWS_BEARER_TOKEN_BEDROCK")
}).pipe(Layer.provide(FetchHttpClient.layer))
```

`AWS_BEARER_TOKEN_BEDROCK` is the variable that the AWS SDK for JavaScript reads the key from. The client reads it only through the `Config` that you give it. An `AiError` and an HTTP span that records headers show the `authorization` header as `<redacted>`.

### Set the other options

The other options are these:

- `region` defaults to `us-east-1`.
- `apiUrl` replaces the endpoint, which defaults to `https://bedrock-runtime.<region>.amazonaws.com`.
- `transformClient` changes the `HttpClient` for every request, for example to add a retry policy. To change it for one effect only, use `AmazonBedrockConfig.withClientTransform`.

## Choose a model

Give a Bedrock model ID or an inference profile ID as the first argument of `AmazonBedrockLanguageModel.model`, or as the `model` option of `AmazonBedrockLanguageModel.layer`. Some models accept only an inference profile ID. The live suites call Claude Sonnet 4.5 through `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, and their setup notes that Bedrock rejects its bare foundation-model ID. The model must be enabled for your account in the region of the client.

To set request defaults, give them as the second argument of `model` or as the `config` option of `layer`. The defaults take these fields:

- `inferenceConfig`, `additionalModelRequestFields`, and `toolConfig`. The provider sends each one as the Converse request field of the same name.
- `outputConfig`, which takes only `effort`. The provider sets `outputConfig.textFormat` itself. `effort` is `low`, `medium`, `high`, `xhigh`, or `max`, and a higher level lets the model reason longer before it answers. The Bedrock Runtime API model documents that the level is capped at `high` when extended thinking is off. Not every model takes `effort`. On 2026-10-17 Bedrock rejected it for Claude Sonnet 4.5 and Haiku 4.5 with `This model doesn't support the effort field`.
- `structuredOutputs` and `forcedToolChoice`, which choose how `generateObject` asks for the object. The provider does not send them to Bedrock. [Get structured output](#get-structured-output) explains them.

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

The live reasoning suite treats Claude Opus 4.7 and 4.8 and the Claude Opus, Sonnet, Fable, and Mythos 5.x models as rejecting `budget_tokens` with a 400, and sends them adaptive thinking instead. On 2026-10-17 Bedrock rejected `budget_tokens` for Opus 4.8, Opus 5.5, and Sonnet 5.5. On these models `outputConfig.effort` sets how much they reason. The suite's notes say that their reasoning text is empty unless `display` is `"summarized"`. When `BEDROCK_MODEL_ID` names one of them, the suite sends this form:

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

A probe on 2026-10-17 sent one Converse request per path to 17 Claude inference profiles through the `eu-west-1` endpoint. Every profile that served the probe's requests, 12 of the 17, accepted `outputConfig.textFormat`: Claude Haiku 4.5 and 5.5, Opus 4.5, 4.6, 4.7, 4.8, 5, and 5.5, and Sonnet 4.5, 4.6, 5, and 5.5. On Opus 4.8, Opus 5.5, and Sonnet 5.5 it also accepted `outputConfig.textFormat` together with `effort`, with adaptive thinking, and next to a strict tool. Fable 5 and 5.1 rejected every request, with or without `outputConfig.textFormat`, with `data retention mode 'default' is not available for this model`, and the other three profiles have reached end of life.

The provider keeps a list of models that get the schema as a tool instead: the Claude 3 models and Claude Sonnet 4 and Opus 4. The list comes from Anthropic's table of models with structured output. The probe could not check it on Bedrock. Claude 3 Haiku, Claude 3 Sonnet, and Sonnet 4 have reached end of life in `eu-west-1`, and the probe did not try the other models on the list. The tool replaces the tools you pass, and the tool's input becomes the object. If the model calls the tool more than once, the first call is the object. If the model answers in text instead of calling the tool, `effect/ai` decodes the text as the object.

On the tool path the provider forces the model to call the tool. In the probe, Claude Opus 5.5 and Sonnet 5.5 rejected a forced `toolChoice` with `tool_choice: type "tool" and "any" are not supported for this model`. The provider also treats Fable 5.1 and Mythos 5.1 as rejecting it, which nobody has checked on Bedrock. For these four models the provider leaves the tool unforced and adds a system prompt line that tells the model to call it. They take the tool path only when `structuredOutputs` is `false`, or when the prompt holds tool calls and no tools go out.

When the prompt holds tool calls or tool results and the request offers no tools, `generateObject` uses the tool on every model, even with `structuredOutputs: true`. Converse rejects such a request unless it carries a `toolConfig`, and the object tool is one.

The provider matches the model ID against its lists. Two config fields override the match, and the provider sends neither to Bedrock:

- `structuredOutputs` set to `true` sends `outputConfig.textFormat` to any model, except when the prompt holds tool calls and no tools go out. Set to `false`, it sends the tool.
- `forcedToolChoice` set to `true` forces the tool, and set to `false` leaves it unforced. It has an effect only on the tool path. It does not change a `toolChoice` you pass with your own tools: `"required"` and a named tool go to Bedrock as `any` and `tool`, and the probe's error from Opus 5.5 and Sonnet 5.5 names both as unsupported.

A model ID that does not name the model, such as an application inference profile ARN, gets `outputConfig.textFormat`, or a forced tool when `structuredOutputs` is `false`. With tool history and no tools it also gets a forced tool by default. Behind an ARN that wraps Opus 5.5 or Sonnet 5.5, set `forcedToolChoice: false` for that case. To send the unforced tool through such an ARN in every case, set both fields:

```ts
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"

export const Opus = AmazonBedrockLanguageModel.model(
  "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
  { structuredOutputs: false, forcedToolChoice: false }
)
```

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

Converse has no `"none"` tool choice, and it rejects a request whose messages hold tool calls or tool results unless the request carries a `toolConfig`. A `generateText` or `streamText` call whose prompt holds tool calls therefore fails with `InvalidUserInputError` before the provider sends it, when the call has no tools, its `toolChoice` is a `oneOf` that names none of them, or it sets `toolChoice: "none"`. A `toolConfig` in the request config counts, and `generateObject` sends the object tool in this case, as [Get structured output](#get-structured-output) explains. To continue such a conversation with text, pass the toolkit that produced the tool calls, with `toolChoice: "auto"`:

```ts
import { Schema } from "effect"
import { LanguageModel, type Prompt, Tool, Toolkit } from "effect/ai"

const ReadFile = Tool.make("readFile", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String
})
export const toolkit = Toolkit.make(ReadFile)

declare const history: Prompt.Prompt

export const answer = LanguageModel.generateText({
  prompt: history,
  toolkit,
  toolChoice: "auto"
})
```

The model may then call a tool instead of answering. If you cannot accept that, rewrite the tool calls and results in the history as text first.

[`docs/TODO.md`](https://github.com/wmaurer/effect-ai-amazon-bedrock/blob/main/docs/TODO.md) explains each gap and what was tested against real Bedrock.

## Where the package comes from

Tom McKenzie wrote the first version of this provider as `packages/ai/amazon-bedrock` in a fork of [`effect-ts/effect`](https://github.com/Effect-TS/effect). Wayne Maurer added tool calls, streaming tool calls, files, citations, prompt caching, and reasoning.

The package may go back to Effect as a pull request. Until then it is published here under its own name. Its source follows Effect's lint, format, and TypeScript rules, and it differs from the fork only in the package name.

## License

MIT. See [`LICENSE`](./LICENSE).
