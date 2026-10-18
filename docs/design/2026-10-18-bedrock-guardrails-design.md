# Amazon Bedrock guardrails (0.4.0)

Status: implemented on the branch `feat/guardrails-0.4.0`, with unit tests against a stubbed `HttpClient`. Plan step 5, the live check, passed on 2026-10-18, and step 6 was not needed. Step 8, the release, has not started. 0.3.0 is on npm, and the data retention hint waits under `## Unreleased` in the CHANGELOG for this release.

## Problem

A program wants to apply an Amazon Bedrock guardrail to Converse and ConverseStream requests, learn what the guardrail did, and choose which content it evaluates. 0.3.0 cannot do any of this:

- `ConverseRequest` models 7 of the 13 request members, and `guardrailConfig` is not one of them. `AmazonBedrockLanguageModel.Config` is derived from `ConverseRequest`, so the config has no key for it.
- `ConverseResponse` and `ConverseStreamMetadataEvent` have no `trace` member, and schema structs strip unknown members, so the guardrail trace is dropped without an error.
- `guardrail_intervened` and `content_filtered` both become the finish reason `"content-filter"`, and the raw stop reason is lost.
- `ContentBlock` and `SystemContentBlock` have no `guardContent` member, so a program cannot guard the system prompt or run a contextual grounding check.

These facts make the shape less obvious than one new schema member:

- The two operations take different guardrail objects. ConverseStream's `GuardrailStreamConfiguration` adds `streamProcessingMode` to Converse's `GuardrailConfiguration`. `makeRequest` builds one request object for both paths.
- A guardrail block is not an error. Bedrock answers HTTP 200 with the blocked message that the guardrail configures as assistant text, `stopReason: "guardrail_intervened"`, and, for a blocked input, zero usage. A masked answer, from a sensitive information filter with the `ANONYMIZE` action, gets the same stop reason with a usable answer. Only the trace tells the two apart.
- The trace is a tree of about 90 Smithy shapes that AWS still extends. It holds the matched text unmasked.
- A guardrail that the account or organization enforces acts without any `guardrailConfig` in the request.
- `"content-filter"` is an incomplete finish in Effect. `generateObject` sends a blocked message to the JSON decoder, which fails with `StructuredOutputError`. That error is retryable, so a retry policy pays again for the same block.

Constraints:

- No new runtime dependency.
- Every 0.3.0 call compiles and behaves as before when no guardrail acts.
- Service methods fail only with `AiError`.
- Every new export has `@stability unstable` and `@since 0.4.0`.
- Finish metadata and prompt options must be valid JSON, so absent values are `null` or absent keys, never `undefined`.

## Usage

```ts
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"

// Every request of this model goes through the guardrail.
const Guarded = AmazonBedrockLanguageModel.model("eu.anthropic.claude-sonnet-4-5-20250929-v1:0", {
  guardrailConfig: {
    guardrailIdentifier: "abc123xyz",
    guardrailVersion: "1", // or "DRAFT"
    trace: "enabled", // needed to tell a block from a mask; the trace holds the matched text
    streamProcessingMode: "async" // ConverseStream only; generateText does not send it
  }
})
```

The finish part says what happened, on `generateText` and on `streamText`:

```ts
const response = yield* LanguageModel.generateText({ prompt })
const bedrock = response.content.find((part) => part.type === "finish")?.metadata.amazonBedrock

if (bedrock?.stopReason === "guardrail_intervened") {
  if (bedrock.guardrail?.input === "blocked") {
    // response.text is the guardrail's blocked-input message
  } else if (bedrock.guardrail?.output === "masked") {
    // response.text is usable, with the sensitive values masked
  }
}
// bedrock.trace is the Converse trace as Bedrock sent it.
```

`generateObject` has no object to return when a guardrail blocks, so it fails with a `ContentPolicyError`, which is not retryable:

```ts
LanguageModel.generateObject({ prompt, schema }).pipe(
  Effect.catchReason("AiError", "ContentPolicyError", (reason) => report(reason.metadata.amazonBedrock))
)
```

An override replaces the whole `guardrailConfig`, and `undefined` turns a layer's guardrail off for one request:

```ts
effect.pipe(AmazonBedrockLanguageModel.withConfigOverride({ guardrailConfig: undefined }))
```

`guardContent` chooses what the guardrail evaluates. Once any part of a request is guarded, the guardrail evaluates only the guarded parts. The model still reads every part:

```ts
Prompt.make([
  { role: "system", content: "Answer from the documents.", options: { amazonBedrock: { guardContent: true } } },
  {
    role: "user",
    content: [
      { type: "text", text: policyText, options: { amazonBedrock: { guardContent: { qualifiers: ["grounding_source"] } } } },
      { type: "text", text: question, options: { amazonBedrock: { guardContent: { qualifiers: ["query"] } } } }
    ]
  }
])
```

## Public types

In `AmazonBedrockSchema.ts`, one schema per Smithy shape:

| Schema | Members |
| --- | --- |
| `GuardrailTrace` | `"enabled" \| "disabled" \| "enabled_full"` |
| `GuardrailStreamProcessingMode` | `"sync" \| "async"` |
| `GuardrailConfiguration` (Converse) | `guardrailIdentifier`, `guardrailVersion`, `trace?`, `streamProcessingMode?: never` |
| `GuardrailStreamConfiguration` (ConverseStream) | the same three, `streamProcessingMode?: GuardrailStreamProcessingMode` |
| `ConverseStreamRequest` | `...ConverseRequest.fields`, `guardrailConfig?: GuardrailStreamConfiguration` |
| `GuardrailConverseContentQualifier` | `"grounding_source" \| "query" \| "guard_content"` |
| `GuardrailConverseTextBlock` | `text`, `qualifiers?` |
| `GuardrailConverseImageBlock` | `format: "png" \| "jpeg"`, `source: { bytes }` |
| `GuardrailConverseContentBlock` | `text?`, `image?` |

Existing schemas gain members:

- `ConverseRequest`: `guardrailConfig: Schema.optional(GuardrailConfiguration)`.
- `ContentBlock` and `SystemContentBlock`: `guardContent: Schema.optional(GuardrailConverseContentBlock)`.
- `ConverseResponse` and `ConverseStreamMetadataEvent`: `trace: Schema.optional(Schema.MutableJson)`.

`guardrailIdentifier` and `guardrailVersion` are required, though Smithy gives both `default: ""`, because Bedrock cannot apply a guardrail without them. `guardrailConfig` uses `Schema.optional`, not `optionalKey`, so `withConfigOverride({ guardrailConfig: undefined })` type-checks.

In `AmazonBedrockLanguageModel.ts`:

```ts
type GuardrailConfig = typeof GuardrailStreamConfiguration.Encoded
type GuardContent = true | { readonly qualifiers: ReadonlyArray<GuardContentQualifier> }
type GuardrailAction = "blocked" | "masked" | "none"

type GuardrailOutcome = {
  readonly input: GuardrailAction
  readonly output: GuardrailAction
  readonly policies: Array<string> // trace keys such as "wordPolicy", each once
}

type FinishMetadata = {
  readonly stopReason: string | null
  readonly guardrail: GuardrailOutcome | null
  readonly trace: Schema.MutableJson | null
}
```

`Config` is derived from `ConverseStreamRequest.Encoded` in place of `ConverseRequest.Encoded`. That one edit gives `model`, `layer`, and `withConfigOverride` the key.

Module augmentations:

- `Response.FinishPartMetadata` and `AiError.ContentPolicyErrorMetadata` gain `amazonBedrock?: FinishMetadata | null`. `AiError`'s `ProviderMetadata` holds `MutableJson`, and `Response`'s holds `Json`, so `policies` is a mutable array and `trace` is `MutableJson`. One type then fits both.
- `Prompt.TextPartOptions` and `Prompt.SystemMessageOptions` move from `CachePointOptions` to a new `GuardableOptions`, which holds `cachePoint` and `guardContent?: GuardContent | null`. Two base interfaces cannot both declare `amazonBedrock` with different types, so the two options share one interface.
- `FileOptions` gains `guardContent?: true | null`. A guarded image takes no qualifiers, and the type rejects them.

The option and metadata shapes are type aliases, not interfaces, so they fit the JSON index signatures of `ProviderOptions` and `ProviderMetadata`.

## Behaviour

### Requests

1. `makeRequest` spreads the config as it does in 0.3.0 and returns a `ConverseStreamRequest`. It does not know which path it serves.
2. `streamText` sends the request to `client.converseStream`, which now takes `ConverseStreamRequest`.
3. `generateText` sends `toConverseRequest(request)`, which removes `guardrailConfig.streamProcessingMode`. `client.converse` takes `ConverseRequest`, whose guardrail declares `streamProcessingMode` as `never`, so passing a stream request to it does not compile. The split of the two wire shapes is a type error, not a test someone has to remember.
4. The provider does not turn `trace` on. AWS's default is `disabled`, and the trace carries matched text unmasked into finish parts that programs log.

A program that sets `streamProcessingMode` and calls `generateText` gets no error. The mode has no meaning without a stream, and the JSDoc says that `generateText` does not send it.

### Responses

`src/internal/guardrails.ts` owns the reading of the trace. `makeResponse` and `makeStreamResponse` both call its pure `finishMetadata(stopReason, trace)` and put the result on the finish part as `metadata.amazonBedrock`. The stream keeps the raw stop reason from `messageStop` next to the finish reason it keeps already, and reads `trace` from the trailing `metadata` event, which is where it emits `finish` already.

`guardrailOutcome(trace)` reads `trace.guardrail.inputAssessment` for the input side and `trace.guardrail.outputAssessments` for the output side. Each map holds one entry per guardrail, including enforced guardrails, and the output side holds a list per guardrail, one assessment per chunk. On each side, the walk visits every value under each assessment and reads every string at a key named `action`. `BLOCKED` counts as blocked and `ANONYMIZED` counts as masked. The strongest value wins, in the order blocked, masked, none. `policies` lists, once each and in first-seen order, the top-level assessment keys under which a blocked or masked action was found, such as `wordPolicy`.

The walk does not list policies by name. A policy that AWS adds later is read without a code change, and no list must stay in step with Smithy. A member that is missing or has another type counts as nothing found. A trace without a `guardrail` object gives `guardrail: null`, and the raw trace still reaches the program. A trace in which nothing acted gives `{ input: "none", output: "none", policies: [] }`, which tells "evaluated and passed" apart from "no trace".

Every finish part carries the metadata, also when no guardrail is configured. `stopReason` also tells `max_tokens` from `model_context_window_exceeded`, which both map to `"length"`. `stopReason` is `null` only when a stream ends without a `messageStop` event.

### Finish reasons

The finish reason map does not change. `guardrail_intervened` and `content_filtered` both stay `"content-filter"`, as in the AI SDK and Pydantic AI. The finish reason depends on the stop reason alone, so turning the trace on cannot change whether Effect runs tool handlers. AWS replaces the model's own stop reason with `guardrail_intervened`, so the provider cannot recover `end_turn` or `tool_use` for a masked answer.

AWS does not define `content_filtered`. Reports from other projects say Converse sends it for a refusal by the model's own classifier, with no guardrail involved. A guardrail cannot provoke it, so the live suite does not observe it.

### generateObject

When the response format is `json`, the stop reason is `guardrail_intervened`, and the text of the response does not parse as JSON, `makeResponse` fails with `ContentPolicyError`. Its description names the guardrail and quotes the first 200 characters of the text. Its metadata is the `FinishMetadata` of the response.

The rule does not depend on the trace. A blocked response holds the blocked message, which is not JSON, so it fails whether or not the trace is on. A masked object is still JSON, so it goes on to Effect's decoder as before. The rule covers both ways of asking for an object. On the object tool path, a blocked response has no tool call, and its text is the blocked message.

`generateText` and `streamText` never fail on a guardrail. The response is a valid HTTP 200 with a message that a chat may show, and in `async` streaming the text has already arrived.

### guardContent

- In `prepareMessages`, a guarded user text part or system message becomes `{ guardContent: { text: { text, qualifiers? } } }` in place of `{ text }`. A cache point still follows it as its own block.
- A guarded file part must be `image/png` or `image/jpeg`, with its data as bytes or base64. A document, `image/*`, gif, webp, or an `s3://` source fails with `InvalidUserInputError`, which names the reason. Smithy allows only png and jpeg with bytes. The AI SDK's provider can emit `s3Location`, gif, and webp here.
- A guarded assistant text part fails with `InvalidUserInputError`. AWS's examples guard only user and system content. Allowing it later breaks no program, and taking it away later would.
- Tool results take no option, because Smithy has no `guardContent` in a tool result.

The option stays on the part. In a `Chat`, a guarded turn is evaluated again on every later turn. A "guard only the newest message" rule would send text that the guardrail once blocked to the model unchecked on the next turn.

### Errors

No hint is added before the live run. The run shows which exception and message Bedrock sends for a wrong guardrail identifier or version. If that message does not name the guardrail setting, a hint in the form of the data retention hint (`buildInvalidRequestDescription` in `internal/errors.ts`) goes in, matched on the observed message. `Guardrail is not supported with the chosen model`, which Bedrock sends for `openai.gpt-5.4` and `openai.gpt-5.5`, needs no hint, because it says what is wrong.

## Live suite

The suite reads `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`, which defaults to `DRAFT`. It skips when the identifier is unset, as a third gate after the file name and the credentials, so `pnpm test:live` stays green on an account without the guardrail. The suite creates and deletes no AWS resource.

The guardrail is defined in `packages/amazon-bedrock/test/live/guardrail.json`, which is checked in, and created with:

```sh
aws bedrock create-guardrail --region eu-west-1 \
  --cli-input-json file://packages/amazon-bedrock/test/live/guardrail.json
```

It has only policies that the AWS price list gives no charge for:

- A word filter blocks `zorptangle` on input and output.
- A second word filter blocks `Canberra` on output only.
- A regex filter masks `TKT-[0-9]{6}` on output only.

A blocked input runs no model. Each other test sends one short request with a low `maxTokens` to the default Sonnet 4.5 EU profile. The IAM policy behind the credentials needs `bedrock:ApplyGuardrail` on the guardrail ARN.

| Test | Prompt | Assertion |
| --- | --- | --- |
| input block | "Tell me about zanzibar zorptangle." | `guardrail_intervened`, `"content-filter"`, the blocked-input message, zero usage, outcome `{ input: "blocked", output: "none", policies: ["wordPolicy"] }` |
| output block | "What is the capital of Australia? Answer with the city only." | output `blocked`, the blocked-output message |
| mask | "Repeat exactly: ticket TKT-123456" | output `masked`, `policies: ["sensitiveInformationPolicy"]`, the text lacks `TKT-123456` |
| trace off | the input block prompt | `stopReason` set, `guardrail` and `trace` `null` |
| stream, sync | the output block prompt | the finish outcome is output `blocked`, and the deltas are recorded |
| stream, async | the output block prompt | the finish outcome is output `blocked` |
| generateText with `async` in the config | the input block prompt | Converse accepts the request, so the mode was removed |
| guarded part only | an unguarded part with `zorptangle` and a guarded "What is 2 + 2?" | `end_turn`, and the answer holds `4` |
| guarded system prompt | a guarded system prompt with `zorptangle` | input `blocked` |
| unguarded system prompt | the same system prompt, unguarded | `end_turn` |
| generateObject | the input block prompt | `ContentPolicyError` |
| wrong version | version `99999999` | the `AiError` reason, with the exception and message recorded |

## Facts checked on 2026-10-18

- The Smithy model gives `ConverseRequest.guardrailConfig` the shape `GuardrailConfiguration` and `ConverseStreamRequest.guardrailConfig` the shape `GuardrailStreamConfiguration`. The second adds only `streamProcessingMode` (`sync` or `async`, default `sync`). No member of either is `@required`. Source: `.repos/refs/api-models-aws/models/bedrock-runtime/service/2023-09-30/bedrock-runtime-2023-09-30.json`.
- The trace appears in a Converse response as `trace` and in a stream only on the `metadata` event. `GuardrailConverseImageBlock` takes only `png` and `jpeg`, and only `bytes` as its source. `guardContent` exists in `ContentBlock` and `SystemContentBlock` and in no other shape. Same source.
- When a guardrail blocks, the stop reason is `guardrail_intervened` for input and output alike. The answer is the blocked message, and a blocked input has zero usage. A masked answer has the same stop reason. Only guarded blocks are evaluated once a request holds one, and the system prompt only when it is guarded. Source: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html.
- In `async` streaming, chunks can arrive before the guardrail has evaluated them, and masking does not apply. Source: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-streaming.html.
- Word filters and regex filters cost nothing to evaluate. Content filters and denied topics cost $0.15 per 1,000 text units of up to 1,000 characters. The page names no charge for keeping a guardrail. Source: https://aws.amazon.com/bedrock/pricing/.
- `"content-filter"` is an incomplete finish in Effect 4.0.5. `AiError.ContentPolicyError` exists, with its own `ContentPolicyErrorMetadata` interface. Source: `effect/src/ai/LanguageModel.ts`, `effect/src/ai/AiError.ts`.
- Prior art: the AI SDK spreads untyped provider options into the body, so it sends `streamProcessingMode` to Converse too. It puts the trace unparsed in finish provider metadata and offers `guardContent` on user text and image parts. Source: `.repos/refs/vercel-ai/packages/amazon-bedrock/src/`. Pydantic AI copies the boto3 Converse config into both operations, keeps the trace and the raw stop reason in `provider_details`, and has no `guardContent`. A recorded live call shows that `DRAFT` works from Converse. Source: `.repos/refs/pydantic-ai/`.

## Facts observed live on 2026-10-18

The live suite ran against the guardrail `effect-ai-bedrock-live` in `eu-west-1`, version `DRAFT`, with the default Sonnet 4.5 EU inference profile. All 12 tests passed, and so did the other 27 live tests.

- An EU inference profile accepts a guardrail in `eu-west-1` that has no cross-region setting.
- A blocked input comes back with zero usage, `BLOCKED_INPUT_MESSAGE` as the text, and a trace whose `inputAssessment` is keyed by the guardrail id and holds `wordPolicy.customWords[].action: "BLOCKED"`, with `actionReason: "Guardrail blocked."` and `modelOutput: []`.
- The regex filter's `ANONYMIZE` gives `guardrail_intervened` and the text `ticket {ticket}`.
- In `sync` streaming, the only text delta of a blocked output is `BLOCKED_OUTPUT_MESSAGE`. In `async` streaming, the blocked word `Canberra` arrives as a delta, and only the finish part reports the block.
- A request with `guardContent` on one part is not blocked for a blocked word in an unguarded part. An unguarded system prompt with a blocked word is not evaluated, and a guarded one is blocked.
- A wrong guardrail version fails with HTTP 400 `ValidationException`: "The guardrail identifier or version provided in the request does not exist." The message names the setting, so step 6 added no hint.

## How the design was chosen

Two independent sketches, one from Opus and one from Sonnet, agreed on most of the design. Both put `guardrailConfig` in the AWS shape in `Config`, keep `streamProcessingMode` off Converse, and leave the trace as JSON on the finish part next to a computed outcome. Both keep `"content-filter"`, ship `guardContent` in 0.4.0, and give `generateObject` an error that is not retryable on a block. A Sonnet judge scored them against a six-part rubric and chose the Opus sketch as the base, 24 to 22.

- The base is the Opus sketch. It keeps the wire shapes apart by type with `ConverseStreamRequest` and a `never` member. Its outcome has `input` and `output` sides, and its error metadata is the finish metadata.
- From the Sonnet sketch came the generic walk over every `action` key, in place of a list of policies, `guardrail.json` as a checked-in file, and the live `generateText` test with `async` in the config.
- The judge found that the Opus sketch's `generateObject` rule let a block through when the trace was off or named an unknown policy. The rule now looks at whether the text is JSON, not at the trace.

Rejected:

- Removing `streamProcessingMode` in `AmazonBedrockClient.converse`, as the Sonnet sketch did. It is the right owner at run time, but a later edit that bypasses it is caught only by a test. The type split catches it in `tsc`.
- Sending `streamProcessingMode` to both operations, as the AI SDK does. Smithy says Converse has no such member, and leaving it out costs nothing.
- Two config keys, one for each operation. They split one AWS object, and a program would set the same guardrail twice.
- Domain names such as `guardrail: { id, version }`. They break the rule that `Config` is the encoded request, and put a second vocabulary next to the AWS documentation.
- A typed trace tree. It would be about 90 hand-copied shapes, and a struct drops every member that AWS adds later.
- Only the raw trace, as the AI SDK and Pydantic AI do. Every program would walk six levels to tell a block from a mask.
- A single `action` for the whole exchange, as the Sonnet sketch had. A program cannot then tell a blocked input from a blocked output.
- Mapping a masked answer to `"stop"`. It guesses the stop reason that AWS replaced, and turning the trace on would change whether tool handlers run.
- A `ContentPolicyError` from `generateText` or `streamText`.
- A hint for `Guardrail is not supported with the chosen model`, and a hint matched on `/guardrail/i`. The first message already says what is wrong, and the regex would also match it.
- A `withGuardrail` helper or a new module. Each would be a second way to set what `Config` already sets.
- Modelling `ApplyGuardrail`, which evaluates content without a model call. It is a different operation, and nobody has asked for it.

## Open questions

- A masked answer finishes as `"content-filter"`, so Effect does not run the tool handlers of that response. Should an outcome that shows only masking finish as `"tool-calls"` or `"stop"` instead? This design says no, because the finish reason should not depend on the trace.
- Does Converse reject `streamProcessingMode` or ignore it? It no longer matters, because Converse never receives it, and nothing in the plan settles it.
- Can a program ask for the trace of an enforced guardrail without naming one, as `guardrailConfig: { trace: "enabled" }`? Smithy allows it, the type does not, and checking it needs an enforced guardrail in the account.
- What does `enabled_full` add to the trace? AWS does not document it. The live run records it if a test is added for it.

## Implementation plan

Each step ends in a check. Work on the branch `feat/guardrails-0.4.0`, and commit each step.

1. Add the schemas and members to `AmazonBedrockSchema.ts`. Widen `client.converseStream` to `ConverseStreamRequest`. Derive `Config` from `ConverseStreamRequest.Encoded`, and send `toConverseRequest(request)` from `generateText`. `makeResponse` and `makeStreamResponse` take the request of their path. Check: `pnpm check` prints no diagnostic, a schema test decodes a response with a trace unchanged, request tests show the body on both paths (the mode on `/converse-stream` only, no key without a config, `undefined` removing a layer's guardrail, an override replacing the whole object), and a types file holds the `@ts-expect-error` cases.
2. Write `internal/guardrails.ts` with pure tests: a blocked input, a masked output, blocked over masked, two guardrails with one `ACCOUNT_ENFORCED`, output assessments across chunks, `NONE` entries, a trace where nothing acted, no `guardrail` member, a policy key that does not exist today, and a member of an unexpected type. Then put `FinishMetadata` on the finish part on both paths, with the `FinishPartMetadata` augmentation. Check: `pnpm test`, and response tests on both paths with a trace fixture.
3. Fail `generateObject` with `ContentPolicyError`, and add the `ContentPolicyErrorMetadata` augmentation. `makeResponse` gains `AiError` in its error channel. Check: a blocked response fails with `ContentPolicyError` on the native path and on the object tool path, a masked JSON response decodes, and `isRetryable` is false.
4. Add `GuardableOptions`, the file option, the block builders, and their validation in `prepareMessages`. Check: tests for a guarded user text part with `true` and with qualifiers, a guarded system message, a cache point after a guarded block, a png with bytes, and an `InvalidUserInputError` for `s3://`, gif, `image/*`, a pdf, and an assistant text part. `pnpm check` and `pnpm lint`.
5. Write `test/live/guardrail.json`, the live suite, and its section of `test/live/README.md`. Create the guardrail in `eu-west-1`, with the operator's approval of the command. Run `pnpm test:live`. Check: the suite passes, it skips without `BEDROCK_GUARDRAIL_ID`, and the observed facts go into this record.
6. Not needed: the observed message names the guardrail setting. If the run shows a wrong-version message that does not name the guardrail setting, add a hint for it, with a unit test that uses the observed message. Check: `pnpm test`.
7. Update the docs. The README gets a section "Apply a guardrail", with the trace warning and the `guardContent` rule in its first sentences. The CHANGELOG 0.4.0 entry names these changes in behaviour: every finish part has `metadata.amazonBedrock`, `generateObject` fails with `ContentPolicyError` on a guardrail block (which an enforced guardrail can cause in 0.3.0 too), and `converseStream` takes `ConverseStreamRequest`. `docs/TODO.md` moves `guardrailConfig` out of "Other `ConverseRequest` fields", takes `guardContent` off the list of ignored blocks, and records `guardrail_intervened` as observed. `content_filtered` stays unobserved.
8. Run the four checks in `AGENTS.md` ("Before you claim work is done"), then the release steps.
