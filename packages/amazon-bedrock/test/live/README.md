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
  pnpm vitest run --project @effect/ai-amazon-bedrock
```

Without it, export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
(only for temporary `ASIA…` credentials) and `AWS_REGION` yourself.

`BEDROCK_MODEL_ID` overrides the model. The default is the EU geo inference profile —
Sonnet 4.5 has no in-region support in any region, so the bare foundation-model id is
rejected with "Invocation of model ID … with on-demand throughput isn't supported."
Any IAM policy therefore needs `inference-profile` ARNs, not just `foundation-model` ones.

## Cost

Roughly a dozen calls per full run. The prompts are tiny except the cache-point suite,
which deliberately sends a >1024-token prefix twice (Sonnet 4.5's minimum checkpoint
size) and pays one cache write per run — a few cents. The prefix carries a per-run nonce
so the first call is always a genuine write; without it a warm 5-minute cache from a
previous run would turn it into a read and the write-side assertion would be vacuous.
