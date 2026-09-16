# Live Bedrock checks — TEMPORARY, DELETE BEFORE SQUASHING

**This entire directory comes out before the branch is squashed for the upstream PR.**
`rm -rf packages/ai/amazon-bedrock/test/live` removes every trace; nothing outside it
refers to it, and no build, config or CI file needs editing afterwards.

## What these are

Every other test in this package runs against a stubbed `HttpClient`. These run against
real Amazon Bedrock and cost real money. They exist to break the circularity noted under
"Verification gaps" in the repo-root `TODO.md`: the event-stream parser and its unit-test
frames were both written from the same reading of the AWS spec, so the unit tests cannot
catch a shared misreading. Only bytes AWS actually produced can.

They replace the earlier throwaway `smoke-bedrock.ts`.

| File                                         | Covers                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AmazonBedrock.integration.test.ts`          | `generateText`, `generateObject`, the `max_tokens` stop reason, cache checkpoints at both TTLs, the usage-disjointness oracle                     |
| `AmazonBedrockStream.integration.test.ts`    | real `vnd.amazon.eventstream` bytes: multi-frame text deltas, a tool call whose input JSON is split across frames                                 |
| `AmazonBedrockContent.integration.test.ts`   | image blocks, document blocks, citations                                                                                                          |
| `AmazonBedrockErrors.integration.test.ts`    | the `x-amzn-errortype` -> `AuthenticationError.kind` table, against exceptions AWS actually sent, plus the signing path with no session token     |
| `AmazonBedrockTools.integration.test.ts`     | the tool round-trip: a `toolResult` sent back to Converse against the `toolUse` it answers                                                        |
| `AmazonBedrockReasoning.integration.test.ts` | extended thinking via `additionalModelRequestFields`: the `reasoningContent` decode, the `signature` round-trip, reasoning deltas over the stream |

They have already earned their keep twice. The document suite caught Converse rejecting
every uncited `text/*` document, because a `text` document source is only accepted alongside
a citations config — the Smithy model lists `text` as an unconditional member of the union,
so neither the model nor a stubbed test could have shown it. The error suite then found that
a request with no `Authorization` header comes back as `AccessDeniedException`, not the
`MissingAuthenticationTokenException` the documentation implies.

## Why they never run by accident

The filenames end in `.integration.test.ts`, which `vitest.config.ts:51` excludes unless
`EFFECT_INTEGRATION_TESTS=1`. As a second guard, each suite skips itself when
`AWS_ACCESS_KEY_ID` is unset, so an integration run on a machine without AWS credentials
reports skips rather than failures. Both guards must open before a single billable call
is made.

## Running them

Credentials come from the environment. With the `with-aws` fish function:

```fish
with-aws -r eu-west-1 env EFFECT_INTEGRATION_TESTS=1 \
  pnpm vitest run --project @effect/ai-amazon-bedrock --no-file-parallelism
```

Without `with-aws`, export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` (only for temporary `ASIA…` credentials) and `AWS_REGION` yourself.

`--no-file-parallelism` is not optional. Each suite is declared `{ sequential: true }`, but vitest
still runs the files concurrently, and the resulting burst exceeds the on-demand
tokens-per-minute quota for Sonnet 4.5 in `eu-west-1` — runs without it fail two or three
tests with `RateLimitError`, at random. That is an account quota, not a provider defect.

`BEDROCK_MODEL_ID` overrides the model. The default is the EU geo inference profile —
Sonnet 4.5 has no in-region support in any region, so the bare foundation-model id is
rejected with "Invocation of model ID … with on-demand throughput isn't supported."
Any IAM policy therefore needs `inference-profile` ARNs, not just `foundation-model` ones.

## Cost

Roughly twenty calls per full run, five of which are rejected before they reach a
model and so cost nothing. The prompts are tiny except the cache-point suite,
which deliberately sends a >1024-token prefix twice (Sonnet 4.5's minimum checkpoint
size) and pays one cache write per run — a few cents. The prefix carries a per-run nonce
so the first call is always a genuine write; without it a warm 5-minute cache from a
previous run would turn it into a read and the write-side assertion would be vacuous.
