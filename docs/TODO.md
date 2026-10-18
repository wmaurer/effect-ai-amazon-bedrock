# TODO — `@wmaurer/effect-ai-amazon-bedrock`

Extensions deliberately scoped out while implementing streaming tool calls, reasoning,
images/documents, prompt caching, and citations, and assumptions that no live run has checked.
Ordered by how likely they are to matter.

## Credentials

`AmazonBedrockClient` takes fixed keys, a `credentialProvider`, or a Bedrock `apiKey`
(`AmazonBedrockClient.ts`, `internal/credentials.ts`). These gaps remain:

- AWS rejects an API key that it does not accept with `AccessDeniedException`, as it rejects a
  missing IAM permission, so the client reports kind `InsufficientPermissions` for both. The
  live run on 2026-10-17 observed this for a tampered short-term key. It did not try an
  expired or revoked key.
- The client reads no AWS credential chain of its own. A program passes `fromNodeProviderChain()`
  from `@aws-sdk/credential-providers`, or another provider, to `credentialProvider`.
- The client does not read `AWS_BEARER_TOKEN_BEDROCK` implicitly, as the AI SDK's provider and
  the AWS SDK for JavaScript do. A program reads it with `Config.Redacted`.
- A request that Bedrock rejects with `ExpiredTokenException` fails, and only the next request
  gets new credentials. Refreshing five minutes before `expiration` makes that case rare.

The design and the reasons for these choices are in
`docs/design/2026-10-17-bedrock-credentials-design.md`.

## Models from other providers

`packages/amazon-bedrock/test/live/probe-models.ts` called models from other providers on
2026-10-17: 15 through the `eu-west-1` endpoint and 32 through `us-east-1`, with one run per
model and call unless noted. Most models got a `generateText`, a `streamText` that should call a
tool, a `generateText` with `toolChoice: "required"`, and `generateObject` on each of its three
paths. `getModelCapabilities` follows what the probe saw for `generateObject`, and "How
`generateObject` chooses its path" below gives the rule. These findings and gaps remain:

- Bedrock streamed the tool input of Qwen3 32B as `city": "Zurich"}`, without the opening `{"`,
  in each of 4 runs. Its non-streaming tool input was intact. The provider now fails the stream
  with an `InvalidOutputError`. It does not repair the input.
- Mistral Large 2402 and Pixtral Large in `eu-west-1`, and Llama 3 70B, Llama 3.3 70B, Llama 4
  Maverick, Palmyra X5, DeepSeek R1, Mistral 7B, Mixtral 8x7B, and Mistral Small 2402 in
  `us-east-1`, answer a `streamText` with tools with `This model doesn't support tool use in
  streaming mode`. Mistral Large 3, Devstral 2, and Ministral 3 8B stream tool calls.
- Gemma 3 27B, Gemma 3 12B, and Magistral Small make no tool call in `streamText`. They answer
  in text.
- Magistral Small returns no valid JSON on any `generateObject` path, and makes no tool call
  with `toolChoice: "required"`.
- Llama 3 70B, Mistral 7B, Mixtral 8x7B, and DeepSeek R1 answer a request with tools with
  `This model doesn't support tool use`. They answer `outputConfig` with a 400 too, so
  `generateObject` has no path on them. Mistral 7B and Mixtral 8x7B also reject the system prompt line of the unforced
  tool.
- gpt-oss-120b accepts `outputConfig.textFormat`, but wrote text before the JSON in 3 of 4
  runs. DeepSeek V3.2 and Mistral Large 3 accepted it in `us-east-1`. The provider sends neither
  of them `outputConfig.textFormat`, and a caller can set `structuredOutputs: true`.
- The unforced tool on Llama 3.3 70B returned an object that does not match the schema in both
  runs, and on Llama 3.1 70B in 1 of 2 runs.
- Some results vary between runs. The forced tool on gpt-oss-20b failed in 1 of 8 runs with
  `No text content in response`, and MiniMax M2 made no tool call in `streamText` in 1 of 2
  runs. The probe did not keep those raw responses.
- vercel-ai's `normalize-tool-call-id.ts` says that Mistral models need tool call IDs that match
  `^[a-zA-Z0-9]{9}$`, and rewrites the `tooluse_...` IDs that Bedrock generates. The provider
  sends the IDs unchanged. The probe made one tool call per request and sent no tool result
  back, so it did not test this.
- vercel-ai's `amazon-bedrock-chat-language-model.ts` drops `stopSequences` for OpenAI models,
  and `temperature` and `topP` for the ones other than gpt-oss. Its comment says that Converse
  rejects them. The provider sends `inferenceConfig` as given, and the probe did not set these
  fields, so this is unverified.
- Llama 3.2 3B in `eu-west-1`, and Nova Premier, Llama 3.2 11B, and Llama 3.2 90B in
  `us-east-1`, have reached end of life. Bedrock denied the probe's account access to Palmyra X4,
  which Writer marks as Legacy, and to GLM 5.3.
- Tool input schemas and the `outputConfig.textFormat` schema are converted with
  `toCodecAnthropic` for every model. The probe's schemas were small objects of strings and
  booleans.
- gpt-5.5, gpt-oss, grok, MiniMax, Kimi K3, and DeepSeek R1 returned reasoning, and the
  provider decoded it into reasoning parts. No test sends their reasoning back in a later turn.
- Only `eu-west-1` and `us-east-1` are probed.

The live suites cannot settle this as they stand. `BEDROCK_MODEL_ID` changes the model, but the
cache, citation, and reasoning tests check Claude behaviour and would fail on other models for
that reason alone. Run `probe-models.ts` for the model instead.

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
`ConverseRequest` in `AmazonBedrockSchema.ts` models eight of them: `modelId`, `messages`,
`system`, `toolConfig`, `inferenceConfig`, `additionalModelRequestFields`, `outputConfig`, and
`guardrailConfig`. The section above covers `additionalModelResponseFieldPaths`. The other four are
not modelled: `promptVariables`, `requestMetadata`, `performanceConfig`, and `serviceTier`.

`AmazonBedrockLanguageModel.Config` is the encoded `ConverseStreamRequest` without `messages`,
`system`, and `outputConfig`, with every field optional, so the request config has no key for these
four. `ConverseStreamRequest` is `ConverseRequest` with the guardrail config of ConverseStream, which
adds `streamProcessingMode`.
It adds its own `outputConfig`, which takes only `effort`, because the provider sets `textFormat`
for `generateObject`. It also adds `structuredOutputs` and `forcedToolChoice`, which pick how `generateObject`
asks for the object and are never sent to Bedrock. `make` spreads the config into the request, so a field
added to `ConverseRequest` reaches Bedrock through `model`, `layer`, and `withConfigOverride` with
no other change.

## Guardrails

`guardrailConfig`, the trace on the finish part, and `guardContent` are modelled, and
`docs/design/2026-10-18-bedrock-guardrails-design.md` gives the design. The live suite
`test/live/AmazonBedrockGuardrails.integration.test.ts` ran green on 2026-10-18 against a guardrail of
word and regex filters in `eu-west-1`. These gaps remain:

- `ApplyGuardrail`, which evaluates content without a model call, is not modelled.
- The `promptRouter` member of the trace reaches the caller only in the raw `trace`.
- The type requires `guardrailIdentifier` and `guardrailVersion`, though the Smithy model does not.
  Whether a request can ask for the trace of an account or organization enforced guardrail without
  naming one is unchecked, and `guardrailOutcome` reading such a guardrail's trace is tested only
  against a stubbed fixture.
- A masked answer finishes as `"content-filter"`, so Effect does not run the tool handlers of that
  response.
- Contextual grounding, content filters, denied topics, PII entities, and guarded images cost money
  per evaluation, so no live run covers them. Only the `wordPolicy` and regex
  `sensitiveInformationPolicy` paths have run live.
- What `trace: "enabled_full"` adds is undocumented and unobserved.
- Whether Converse rejects or ignores `streamProcessingMode` is unknown. The provider never sends it
  to Converse.
- A guarded assistant text part fails with `InvalidUserInputError`. AWS documents `guardContent`
  only in user and system content, and nobody has tried an assistant one.

## How `generateObject` chooses its path

`getModelCapabilities` in `AmazonBedrockLanguageModel.ts` reads the model ID and decides between
native `outputConfig.textFormat`, a forced object tool, and an unforced one.
`Config.structuredOutputs` and `Config.forcedToolChoice` override each decision, and a prompt
that holds tool calls while no tools go out takes the object tool on every model. The forced tool
goes out with `toolChoice` `{ any: {} }`.

The decision comes from `capabilitiesByProvider`, a table keyed by the provider that the model ID
names. The provider is the first dot-separated part of the ID, or the second when the first is a
geo prefix such as `eu` or `global`. A foundation model ARN or an inference profile ARN names its
model after the `/`. The table has these rows:

- `anthropic` gets native structured output, except the Claude 3 models and Claude Sonnet 4 and
  Opus 4, which get the forced tool. Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 get the
  unforced tool when they take the tool path.
- `meta` and `writer` get the unforced tool.
- Any other provider gets the forced tool.
- An ARN that does not name its model, such as an application inference profile, a provisioned
  model, or a prompt router, gets native structured output and the forced tool, as every model
  did in 0.2.0.

Probes on 2026-10-17 sent one Converse request per path to 17 Claude inference profiles through
the `eu-west-1` endpoint, and to the models of other providers that "Models from other providers"
lists. The rows follow what they saw. These parts of the rule they could not check:

- The Claude models without native structured output come from Anthropic's table. Claude 3
  Haiku, Claude 3 Sonnet, and Sonnet 4 have reached end of life in `eu-west-1`, and the probe did
  not try the others.
- Fable 5.1 and Mythos 5.1 are treated as rejecting a forced `toolChoice`, as Opus 5.5 and Sonnet
  5.5 did in the probe. Nobody has checked them on Bedrock.
- The `meta` and `writer` rows rest on Llama 3.1, 3.3, and 4 and Palmyra X4 and X5 in
  `us-east-1`. A newer model from either provider may accept a forced tool and still get the
  unforced one.
- The row for other providers sends no model `outputConfig.textFormat`, though gpt-5.5, grok,
  Gemma 3 27B, MiniMax, Nemotron, Qwen3 32B, GLM 4.7 Flash, DeepSeek V3.2, and Mistral Large 3
  accepted it. The forced tool returned the object on each of them.
- The row for unnamed ARNs assumes that most of them wrap a Claude model. An ARN that wraps Nova,
  Llama, or another model that rejects `outputConfig` gets a 400 from `generateObject` until the
  caller sets `structuredOutputs: false`.

## Fable 5 and 5.1 need an account data retention mode

In the same probe, Bedrock answered every request to `global.anthropic.claude-fable-5` and
`global.anthropic.claude-fable-5-1` with a `ValidationException`: `The model returned the following
errors: data retention mode 'default' is not available for this model`. AWS's
[data retention guide](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)
says these models need the account's mode in the region to be `aws_review` or `provider_data_share`,
and that the Converse API takes no mode in the request. The mode is set with the control-plane
`PutAccountDataRetention` operation, which is in the Bedrock Smithy model in `.repos/refs/api-models-aws`.
The provider adds a pointer to that setting to the error. These gaps remain:

- No probe has run on an account with `aws_review`, so the provider's assumption that Fable 5.1
  rejects a forced `toolChoice` is unchecked.
- The hint matches the AWS message text, which AWS can change. A changed message loses the hint,
  and the `InvalidRequestError` still carries the AWS message.

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
`searchResult`, `toolAddition`, `toolRemoval`. So are the `web` and
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

The 0.2.0 ways to authenticate have run against real Bedrock too, on 2026-10-17. AWS accepts
a SigV4 signature from credentials that a function or an `Effect` provider returned, over
Converse and ConverseStream. After AWS rejected a provider's first credentials as
`InvalidKey`, the next request asked the provider again with `forceRefresh` and succeeded.
A short-term Bedrock API key, made from the same STS credentials, authenticates a request as a
bearer token.

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

`guardrail_intervened` is observed too, on 2026-10-18, for a blocked input, a blocked output, and a
masked output, over Converse and over ConverseStream in both processing modes. A blocked input
came back with zero usage and the guardrail's blocked message as the text. In `sync` streaming the
only text delta was the blocked message. In `async` streaming the blocked word arrived as a delta,
and only the finish part reported the block. A wrong guardrail version is a
`ValidationException`, "The guardrail identifier or version provided in the request does not
exist.", which the provider reports as `InvalidRequestError`.

**Still open.** The remaining five stop reasons stay mapped from the Smithy model alone. `stop_sequence`
is provokable and shares its target (`stop`) with `end_turn`; `content_filtered` is undefined by
AWS and reported elsewhere as a refusal by the model's own classifier, which no guardrail causes;
the two `malformed_*` reasons need a model that misbehaves on demand. `generateObject` sends one of three request shapes. The live
suite has a check for two of them, which has not run since Opus 5.5 moved to the native path:
native `outputConfig.textFormat` on Sonnet 4.5 and Opus 5.5, and an unforced `{ auto: {} }` object
tool on Opus 5.5 with `structuredOutputs: false`, since Opus 5.5 rejects a forced `toolChoice` on
Bedrock. The third, a forced `{ any: {} }` object tool, has run live only through
`probe-models.ts`, on Claude Haiku 4.5 and Opus 4.8 and on the models of other providers. No live
suite checks it. The provider sends it to the models of providers other than Anthropic, Meta, and
Writer, and to the Claude models that `getModelCapabilities` lists as lacking native structured
output, which are the Claude 3 models and Claude Sonnet 4 and Opus 4 but not Opus 4.1, unless
`Config.forcedToolChoice` is `false`. With `structuredOutputs: false` it also sends it to every model that
`getModelCapabilities` or `Config.forcedToolChoice` says accepts a forced `toolChoice`. The same
models, the default Sonnet 4.5, Opus 4.8 and Sonnet 5 among them, get it when the prompt holds tool
calls and no tools go out. No live run covers that fallback. Anthropic rejects a forced
tool while budget thinking (`thinking.type: "enabled"`) is on, which the AI SDK's Anthropic
provider accounts for (`packages/anthropic/src/anthropic-language-model.ts` in `vercel/ai` treats
`thinkingType === 'enabled'` as rejecting forced tool use). So an agent loop that runs with budget
thinking may get a 400 on the fallback; `forcedToolChoice: false` avoids it. The provider does not
detect this case. The `{ any: {} }` that `toolChoice: "required"` sends with the caller's tools
has also run live only through `probe-models.ts`. Image and document `s3Location` sources are untested — they
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
