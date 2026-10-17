# TODO — `@wmaurer/effect-ai-amazon-bedrock`

Extensions deliberately scoped out while implementing streaming tool calls, reasoning,
images/documents, prompt caching, and citations, and assumptions that no live run has checked.
Ordered by how likely they are to matter.

## Credentials

`AmazonBedrockClient.layer` and `layerConfig` take one fixed access key id, secret access key, and
optional session token (`AmazonBedrockClient.ts`). Nothing else supplies credentials:

- There is no AWS credential chain. Shared config and credential files (`~/.aws`), profiles, IAM
  Identity Center, ECS and EKS container credentials, and EC2 instance metadata are not read.
  A service on ECS or EKS gets its role's credentials only from the container credentials
  endpoint, so it cannot use this provider without code of its own that copies them into the
  layer.
- Temporary credentials are never refreshed. The layer reads them once, so a long-running
  process fails with `ExpiredTokenException` when the session ends.
- Bedrock API keys are not supported. They are sent as `Authorization: Bearer <key>` in place of
  a SigV4 signature. The AI SDK's provider takes them through an `apiKey` option or the
  `AWS_BEARER_TOKEN_BEDROCK` environment variable, and takes refreshable credentials through a
  `credentialProvider` function (`packages/amazon-bedrock/src/amazon-bedrock-provider.ts` in
  `vercel/ai`). That is the prior art for both.

## Models from other providers

Every live call so far has gone to a Claude model. The live suites default to Claude Sonnet 4.5
and Opus 5.5, and the structured-output probe sent only Claude inference profiles. Nova, Llama,
Mistral, DeepSeek, and the other providers on Bedrock are untested. `generateText`, `streamText`,
and tool calls use the shape Converse shares across models, so they are the most likely to work.
These parts of the provider assume a Claude model:

- `getModelCapabilities` gives `outputConfig.textFormat` to every model ID it does not name, so
  `generateObject` on another provider's model takes the native path by default. Whether Bedrock
  accepts `outputConfig.textFormat` for those models is unchecked. If it does not, the default
  `generateObject` fails with a 400 until the caller sets `structuredOutputs: false`.
- On the tool path, `getModelCapabilities` treats every model it does not name as accepting a
  forced `toolChoice`. The Smithy model documents `ToolChoice.tool` as "Only supported by
  Anthropic Claude 3 and Amazon Nova models", so `structuredOutputs: false` likely fails on Llama,
  Mistral, and the others. `forcedToolChoice: false` would avoid it.
- Tool input schemas and the `outputConfig.textFormat` schema are converted with
  `toCodecAnthropic` for every model.
- Reasoning has been seen only from Claude, always with a `signature` or `redactedContent`.
  Reasoning from DeepSeek R1 and similar models has no signature. The schema makes `signature`
  optional, so it should decode, but no live run has shown it.

The live suites cannot settle this as they stand. `BEDROCK_MODEL_ID` changes the model, but the
cache, citation, and reasoning tests check Claude behaviour and would fail on other models for
that reason alone. A probe with one `generateText`, one `streamText` with a tool call, and one
`generateObject` per model would cover the list above.

## Unknown stop reasons

`StopReason` in `AmazonBedrockSchema.ts` is a closed set of the nine values in the Smithy model,
and it decodes `ConverseResponse.stopReason` and `MessageStopEvent.stopReason`. If Bedrock adds
a stop reason, or a model returns one outside the set, the whole response fails to decode,
including the text that came before it. Decoding an unknown value as a string would keep the
response. `resolveFinishReason` in `internal/utilities.ts` already gives `"unknown"` for a value
missing from its map, though Effect's `"other"` (a reason the protocol does not support) fits an
unrecognised stop reason better.

## Embeddings

`effect/ai` defines an `EmbeddingModel` interface, and this package implements only
`LanguageModel`. The Bedrock embedding models, such as Titan Text Embeddings and Cohere Embed,
are served by `InvokeModel` with a request body that differs for each model, not by Converse.
Supporting them means a second request path in `AmazonBedrockClient` and one body codec for each
model family.

## `additionalModelResponseFieldPaths`

The read side of the Converse feature whose write side is now modelled.
`additionalModelResponseFieldPaths` asks for model-specific response fields by JSON Pointer
(`[ "/stop_sequence" ]`), and Converse returns them in `additionalModelResponseFields` — which
lands in two places the Smithy model shows: on `ConverseResponse` and, for the streaming path,
on `MessageStopEvent`.

Neither side is modelled. The request half is worthless without the response half, and the
response half has nowhere to go: it would need a provider-metadata carrier invented for it,
with no caller waiting. `ConverseResponse` here already omits `trace`, `performanceConfig` and
`serviceTier` by the same selectivity, so leaving this out is consistent rather than an
oversight. Model both halves together or neither.

## Other `ConverseRequest` fields

The Smithy model gives Converse and ConverseStream the same 13 request members.
`ConverseRequest` in `AmazonBedrockSchema.ts` models seven of them: `modelId`, `messages`,
`system`, `toolConfig`, `inferenceConfig`, `additionalModelRequestFields`, and `outputConfig`. The
section above covers `additionalModelResponseFieldPaths`. The other five are not modelled:
`guardrailConfig`, `promptVariables`, `requestMetadata`, `performanceConfig`, and `serviceTier`.

`AmazonBedrockLanguageModel.Config` is the encoded `ConverseRequest` without `messages`, `system`,
and `outputConfig`, with every field optional, so the request config has no key for these five.
It adds its own `outputConfig`, which takes only `effort`, because the provider sets `textFormat`
for `generateObject`. It also adds `structuredOutputs` and `forcedToolChoice`, which pick how `generateObject`
asks for the object and are never sent to Bedrock. `make` spreads the config into the request, so a field
added to `ConverseRequest` reaches Bedrock through `model`, `layer`, and `withConfigOverride` with
no other change.

`guardrailConfig` would let the live suites provoke the `content_filtered` and
`guardrail_intervened` stop reasons, which are still mapped from the Smithy model alone.

## How `generateObject` chooses its path

`getModelCapabilities` in `AmazonBedrockLanguageModel.ts` reads the model ID and decides between
native `outputConfig.textFormat`, a forced object tool, and an unforced one.
`Config.structuredOutputs` and `Config.forcedToolChoice` override each decision, and a prompt
that holds tool calls while no tools go out takes the object tool on every model. A probe on
2026-10-17 sent one Converse request per path to 17 Claude inference profiles through the
`eu-west-1` endpoint, and the rule follows what it saw. These parts of the rule it could not check:

- The models without native structured output, which are the Claude 3 models and Claude Sonnet 4
  and Opus 4, come from Anthropic's table. Claude 3 Haiku, Claude 3 Sonnet, and Sonnet 4 have
  reached end of life in `eu-west-1`, and the probe did not try the others.
- Fable 5.1 and Mythos 5.1 are treated as rejecting a forced `toolChoice`, as Opus 5.5 and Sonnet
  5.5 did in the probe. Nobody has checked them on Bedrock.
- Every model ID the rule does not name gets `outputConfig.textFormat`, including the models of
  other providers on Bedrock. The probe sent only Claude models.

## Fable 5 and 5.1 reject every request

In the same probe, Bedrock answered every request to `global.anthropic.claude-fable-5` and
`global.anthropic.claude-fable-5-1` with a `ValidationException`: `The model returned the following
errors: data retention mode 'default' is not available for this model`. The requests carried no
data retention setting, and the Bedrock Runtime Smithy model in `.repos/refs/api-models-aws` has no
field that names one. Which account setting, inference profile, or request field makes these models
usable is open.

## Video blocks

`VideoBlock` mirrors `ImageBlock` exactly: a format enum (`mkv`, `mov`, `mp4`, `webm`, `flv`,
`mpeg`, `mpg`, `wmv`, `three_gp`) plus a source that is `bytes` or `s3Location`. The `MediaSource`
schema, the `fileSource` resolver and the media-type lookup-table pattern all already exist from
the image/document work, so this is mostly mechanical. Today a `video/*` file part fails with
`InvalidUserInputError` naming the media type.

## `DocumentSource.content`

`bytes`, `s3Location` and `text` are modelled; `content` is not. It carries a document as a list of
pre-chunked `{ text }` blocks, and it is what makes chunk-granular citations meaningful:
`DocumentChunkLocation.start` and `.end` are chunk indices, so a `documentChunk` citation has
nothing to index into unless the request supplied chunks. `Prompt.FilePart` carries a single `data`
and cannot express "this document is these five sections", so modelling it means a new
`amazonBedrock` file-part option carrying document payload rather than configuration — the first
option in this repo to do so. That is the decision to make before implementing it.

## `ImageBlock.error`

`ErrorBlock` reports that an image could not be processed. Not modelled, so such a response decodes
as an image block with no usable content rather than surfacing the reason.

---

Other `ContentBlock` union members remain unmodelled and decode-and-ignore by design: `audio`,
`guardContent`, `searchResult`, `toolAddition`, `toolRemoval`. So are the `web` and
`searchResultLocation` members of `CitationLocation`, which accompany search results the provider
cannot send; such a citation is dropped rather than attributed to a document.
The `systemTool` member of the `Tool` union is likewise unmodelled: it selects Bedrock-hosted tools
this provider cannot invoke.

## Verification gaps

Every test in this package stubs the `HttpClient`, so nothing here is evidence about AWS
itself. `packages/amazon-bedrock/test/live/` holds checks that talk to real Bedrock; see
its README for how to run them and why they cannot fire by accident. **That directory is
temporary and comes out before the branch is squashed for the upstream PR.**

The suites have been run green against real Bedrock in `eu-west-1` against Sonnet 4.5 via
the EU geo inference profile. What that run settled, and what it did not:

**Closed.** Streaming decodes bytes AWS actually produced, over several frames, including a
tool call whose input JSON is split across `contentBlockDelta` frames — so the parser and
its hand-built unit-test fixtures no longer rest on a single shared reading of the spec.
A tool call is answered and sent back: the `toolResult` block, its `toolUseId` and the
`toolConfig` that has to accompany it are accepted by Converse, and the model's next
answer is built from the tool's output — the pairing Converse validates itself and a
stubbed test cannot see. Cache checkpoints are written and read back at both `5m` and
`1h`, with the usage identity
`totalTokens == inputTokens + cacheRead + cacheWrite + outputTokens` asserted on the
write call as well as the read, where the write term is actually non-zero. Image and
document blocks round-trip, and citations come back as source parts resolving to the right
document. Three of the nine mapped Converse stop reasons are observed rather than assumed:
`end_turn`, `tool_use`, and `max_tokens` forced with a one-token ceiling. The
`x-amzn-errortype` values behind three of the five mapped exception shapes are pinned to
the strings AWS sends: `UnrecognizedClientException`, `InvalidSignatureException` and
`AccessDeniedException`.

Reasoning is closed too, now that `ConverseRequest` models
`additionalModelRequestFields` and extended thinking can be switched on. All three paths
have seen bytes AWS produced: a `reasoningContent` block decodes carrying a non-empty
`signature`; that signed block is sent back in a later turn and Converse — which validates
the signature server-side — accepts it; and reasoning arrives over the stream as
`reasoningContent` deltas followed by a separate delta carrying the signature, ahead of the
visible answer.

**Found by doing this.** Converse accepts a `text` document source only alongside a
citations config, and rejects an uncited one with "must set one of the following keys:
bytes, s3Location". The provider converted every `text/*` document to a `text` source
unconditionally, so uncited text, csv, html and markdown documents were rejected outright.
The Smithy model lists `text` as an unconditional member of the `DocumentSource` union, so
no amount of reading the spec would have shown this, and a stubbed test would only have
confirmed the wrong shape.

The spelling that enables extended thinking is `thinking` with `{ type: "enabled",
budget_tokens }` — the direct Anthropic API spelling, forwarded unchanged. This file
previously recorded `reasoning_config` from the AWS documentation; that is wrong, and the
AI SDK's Bedrock provider had it right. `additionalModelRequestFields` is a free-form
document Converse hands to the model without interpreting, so the Smithy model could never
have shown which spelling the model expects — only a live call could.
`inferenceConfig.maxTokens` must exceed `budget_tokens`, since the budget is drawn from the
same ceiling as the visible answer.

`AccessDeniedException` is now pinned too, from an unusual direction: a request that
carries no `Authorization` header at all. That is documented as the
`MissingAuthenticationTokenException` case, and Bedrock disagrees — it answers
`AccessDeniedException` with the body `{"Message": "Authorization header is missing"}`, so
the reader gets `InsufficientPermissions`, not `MissingKey`. It is also the only observed
response that spells the body key `Message` rather than `message`, which the schema already
accepts. Nothing observed so far produces `MissingAuthenticationTokenException` at all; the
table entry may be dead weight inherited from the AWS-wide error set, and it is left in
place because a wrong mapping costs more than an unused one.

**Still open.** The remaining six stop reasons stay mapped from the Smithy model alone. `stop_sequence`
is provokable and shares its target (`stop`) with `end_turn`; `content_filtered` and
`guardrail_intervened` need a configured guardrail; the two `malformed_*` reasons need a
model that misbehaves on demand. `generateObject` sends one of three request shapes. The live
suite has a check for two of them, which has not run since Opus 5.5 moved to the native path:
native `outputConfig.textFormat` on Sonnet 4.5 and Opus 5.5, and an unforced `{ auto: {} }` object
tool on Opus 5.5 with `structuredOutputs: false`, since Opus 5.5 rejects a forced `toolChoice` on
Bedrock. The third, a forced `{ tool: { name } }` object tool, is stub-only. The provider sends it
to the models that `getModelCapabilities` lists as lacking native structured output, which are the
Claude 3 models and Claude Sonnet 4 and Opus 4 but not Opus 4.1, unless `Config.forcedToolChoice`
is `false`. With `structuredOutputs: false` it also sends it to every model that
`getModelCapabilities` or `Config.forcedToolChoice` says accepts a forced `toolChoice`. The same
models, the default Sonnet 4.5, Opus 4.8 and Sonnet 5 among them, get it when the prompt holds tool
calls and no tools go out. No live run covers that fallback. Anthropic rejects a forced
tool while budget thinking (`thinking.type: "enabled"`) is on, which the AI SDK's Anthropic
provider accounts for (`packages/anthropic/src/anthropic-language-model.ts` in `vercel/ai` treats
`thinkingType === 'enabled'` as rejecting forced tool use). So an agent loop that runs with budget
thinking may get a 400 on the fallback; `forcedToolChoice: false` avoids it. The provider does not
detect this case. The `{ any: {} }` tool choice is stub-only too. Image and document `s3Location` sources are untested — they
need a bucket and objects to point at. The 429 -> `RateLimitError` mapping has been seen
in practice (it is why `--no-file-parallelism` exists) but is asserted nowhere, since
provoking it means deliberately exceeding the account's token quota.

`ExpiredTokenException` is the last entry still mapped from documentation alone, and cannot
be provoked on demand: an absent or malformed session token is `UnrecognizedClientException`
("The security token included in the request is invalid"), not an expired one, and the
shortest token STS will issue lives fifteen minutes. Closing it means holding a genuinely
expired token from an earlier session.

Long-lived IAM key pairs remain untested end to end. The no-session-token _signing_ path now
runs — signing without a session token produces a canonical request AWS accepts as far as
key lookup, rather than one rejected as malformed — but every call that reached a model used
a temporary `ASIA…` triple, so no `AKIA…` pair has ever been signed successfully.

Note also that the decoder does not validate CRCs at all — `AmazonBedrockEventStream.ts:54-56`
documents this deliberately, and `test/utils.ts` writes zeroes into both CRC fields. Live
bytes prove nothing about frame integrity; nothing reads those fields. That is defensible
over HTTPS, but it means a truncated or corrupted frame surfaces as a decode error rather
than a checksum failure.

## Not this package

Streaming structured output is a gap in `packages/effect`, not here. `LanguageModel.streamText`
hardcodes `responseFormat: { type: "text" }` and there is no `streamObject` export, so a provider's
`streamText` can never receive a `json` response format. Nothing this provider does can enable it.
