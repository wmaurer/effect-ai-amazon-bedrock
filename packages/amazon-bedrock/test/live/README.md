# Run the live Bedrock checks

The suites in this directory call real Amazon Bedrock, and each run costs money. They are the only tests in the package that decode bytes AWS sent. The unit tests stub `HttpClient` and build their event-stream frames from the same reading of the AWS specification as `AmazonBedrockEventStream.ts`, so a misreading that both share passes both. The "Verification gaps" section of `docs/TODO.md` records what the live runs have settled.

The suites stay in this repository. An upstream pull request to Effect leaves the `test/live` directory out.

## Before you start

- Run every command in this guide from the repository root. `pnpm test:live` is a script in the root `package.json`. In `packages/amazon-bedrock`, pnpm stops with `Command "test:live" not found`.
- Get temporary AWS credentials. AWS STS issues them for a session, for example when you assume an IAM role or sign in through IAM Identity Center. They are three values: an access key id that starts with `ASIA`, a secret access key, and a session token. They stop working when the session expires.
- Do not use a long-lived IAM user key, whose id starts with `AKIA`. It has no session token, and one test in the errors suite needs AWS to reject a request that leaves the token out.
- Check that the IAM policy behind the credentials allows `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, and `bedrock:CallWithBearerToken`. The credentials suite makes a short-term Bedrock API key from the credentials, and the last permission lets that key call Bedrock. The default models are EU geo inference profiles, so the policy must allow the `inference-profile` ARN and also the `foundation-model` ARN in every region that the profile sends requests to.

## Run the suites

1. Install the dependencies:

   ```sh
   pnpm install
   ```

2. Export the credentials. These lines are bash and zsh syntax:

   ```sh
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_SESSION_TOKEN=...
   ```

   The suites read only these environment variables. They ignore `~/.aws/credentials` and AWS profiles.

3. Run the suites:

   ```sh
   pnpm test:live
   ```

   Every file and every test passes. With the current suites, the summary is:

   ```text
   Test Files  7 passed (7)
        Tests  27 passed (27)
   ```

## Two gates keep the suites from running by accident

1. The root `vitest.config.ts` excludes every `*.integration.test.ts` file unless `EFFECT_INTEGRATION_TESTS=1`. `pnpm test` does not set the variable, so it never collects these files. `pnpm test:live` sets it, which opens the first gate.
2. Each suite skips itself when `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is unset. A variable set to an empty string counts as set.

## Choose the region and the model

`helpers.ts` holds the defaults. `REGION` is the region, and `AWS_REGION` replaces it. `MODEL` is the model, and `BEDROCK_MODEL_ID` replaces it. Some `generateObject` tests also call `OPUS_5_5`, and `BEDROCK_MODEL_ID` does not change those tests. Both default models are EU geo inference profiles, so if you set `AWS_REGION`, set it to an EU region.

## Run one suite

Put the start of the suite's file name after `test/live`, up to and including `.integration`:

```sh
EFFECT_INTEGRATION_TESTS=1 pnpm vitest run --no-file-parallelism test/live/AmazonBedrockErrors.integration
```

vitest matches the filter against any part of the path. Every file name starts with `AmazonBedrock`, so `test/live/AmazonBedrock` matches all seven files. To run only the core suite, use `test/live/AmazonBedrock.integration`. `pnpm test:live` always runs every file, even with a file name after it.

Keep `--no-file-parallelism` whenever the filter can match more than one file. Without the flag, vitest runs the files at the same time. Each suite declares `{ concurrent: false }`, but that orders only the tests inside one file. The burst of calls can exceed the account's on-demand tokens-per-minute quota, and then some tests fail with `RateLimitError`.

## Read a failed run

- Every file is skipped and the exit code is 0. `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is unset in this shell. A skipped run is not a pass.
- Most tests fail with `AuthenticationError` of kind `InvalidKey`, HTTP status 403, and `x-amzn-errortype` `UnrecognizedClientException`. AWS does not know the access key id, or the session token does not belong to it. Export all three values again from one session. If AWS does not know the key id, "classifies a bad signature as InvalidKey" fails too, with `UnrecognizedClientException` where it expects `InvalidSignatureException`. The test pairs your access key id with a wrong secret, so it passes only with a key id that AWS knows.
- Most tests fail with `AuthenticationError` of kind `ExpiredKey` and `x-amzn-errortype` `ExpiredTokenException`. The session has expired. Get new credentials.
- Only "signs without a session token when none is configured" fails, because its request succeeds. The credentials are a long-lived `AKIA` key.
- Tests fail with `AuthenticationError` of kind `InsufficientPermissions` and `x-amzn-errortype` `AccessDeniedException`. The IAM policy or the account's model access does not cover a model or a region that the run uses.
- Some tests fail with `RateLimitError`. If you ran vitest yourself, add `--no-file-parallelism`. Otherwise wait a minute and run again.

## A full run makes about 25 Bedrock calls

AWS rejects every call of the errors suite before it reaches a model, so those calls cost nothing. The other prompts are short. Two groups of tests cost more:

- The cache tests send a system prompt of more than a thousand lines and pay for two cache writes.
- The reasoning tests allow up to a few thousand output tokens per call.

## What each suite checks

| File                                           | What it checks                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AmazonBedrock.integration.test.ts`            | `generateText`, `generateObject` on the native and the object-tool paths, the `max_tokens` stop reason, cache checkpoints at both TTLs, the usage arithmetic                        |
| `AmazonBedrockStream.integration.test.ts`      | Text deltas over several event-stream frames, and a tool call whose input JSON is split across frames                                                                               |
| `AmazonBedrockContent.integration.test.ts`     | Image blocks, document blocks, and citations                                                                                                                                        |
| `AmazonBedrockErrors.integration.test.ts`      | The `x-amzn-errortype` values behind `AuthenticationError.kind`, and signing with no session token                                                                                  |
| `AmazonBedrockTools.integration.test.ts`       | A `toolResult` sent back against its `toolUse`, and `generateObject` with tool history in the prompt                                                                                |
| `AmazonBedrockCredentials.integration.test.ts` | A function and an `Effect` credential provider, a refetch with `forceRefresh` after AWS rejects the provider's credentials, and a short-term Bedrock API key, accepted and tampered |
| `AmazonBedrockReasoning.integration.test.ts`   | Extended thinking through `additionalModelRequestFields`, the signed reasoning block sent back in a later turn, and reasoning deltas over the stream                                |
