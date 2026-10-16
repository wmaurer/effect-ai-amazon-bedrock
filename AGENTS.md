# AGENTS.md

Instructions for coding agents working in this repository.

`CLAUDE.md` is a symlink to this file, so both names resolve to the same rules.

## The package (`packages/amazon-bedrock/`)

`@wmaurer/effect-ai-amazon-bedrock` is an Amazon Bedrock provider for Effect AI. `AmazonBedrockLanguageModel` talks to the Bedrock Runtime Converse and ConverseStream APIs. `AmazonBedrockClient` signs each request with SigV4 through `aws4fetch`, and `AmazonBedrockEventStream` decodes the `vnd.amazon.eventstream` frames of a streamed response. `AmazonBedrockSchema` holds the Converse wire shapes.

The package started as `packages/ai/amazon-bedrock` in a fork of `effect-ts/effect` and may go back there as a pull request. For that reason it follows Effect's own lint, format, and tsconfig rules, and its tests keep importing `@effect/ai-amazon-bedrock`, the name the package has in the fork. `tsconfig.tests.json` maps that name to `packages/amazon-bedrock/src`.

`effect` is a peer dependency (`^4.0.5`) and a dev dependency pinned to the version the tests run on. The `overrides` entry in `pnpm-workspace.yaml` pins the same version for the whole workspace. To upgrade Effect, bump the `effect` dev pin in `packages/amazon-bedrock/package.json`, the `@effect/vitest` dev pin in the root `package.json`, and the override together.

`src/index.ts` comes from the `effect-utils codegen` command of the Effect monorepo, which this repository does not have. When you add a module, add an export block in the same form as the others, a `@since` JSDoc comment and an `export * as` line. The `barrel` step of `scripts/upstream-check.sh` runs the codegen and fails if its output differs from the file.

`docs/TODO.md` lists the Converse capabilities the provider does not model yet. Read it before you add one. `docs/design/` holds the design records for earlier features, and `docs/changesets/` holds the changeset entries an upstream pull request needs. They are copied verbatim from the Effect fork, so oxlint and dprint skip `docs/`.

## Tooling

The tooling is the Effect monorepo's, run outside the monorepo.

| Command         | What it does                                        |
| --------------- | --------------------------------------------------- |
| `pnpm lint`     | Run oxlint with Effect's rules, then `dprint check` |
| `pnpm lint-fix` | Run `oxlint --fix`, then `dprint fmt`               |
| `pnpm check`    | Type-check the package and the tests with `tsc -b`  |
| `pnpm test`     | Run the unit tests with vitest                      |

To build the package, run `pnpm build` in `packages/amazon-bedrock`. It emits `dist/` with `tsc -b`, and Babel adds `__PURE__` annotations to the output.

`pnpm install` runs `effect-tsgo patch`, which patches the installed TypeScript so that `tsc` also reports Effect diagnostics such as `effect(floatingEffect)`. `tsconfig.base.json` tells `tsc` to leave them out of its exit code, so `pnpm check` exits 0 even when it prints one. `@effect/tsgo` supports only some TypeScript versions. To bump `typescript`, bump `@effect/tsgo` to a version that supports it, or the patch fails during install.

`packages/tools/oxc/` is a copy of Effect's private `@effect/oxc` package, which holds the custom oxlint rules. The root `tsconfig.base.json` and `vitest.setup.ts` are copies of Effect's files. `scripts/repos.js` is a generated bundle from `wmaurer/project-setup` that the fork also carries. Do not edit any of them by hand. `packages/tools/oxc/PROVENANCE.md` names where each copy comes from and the commands that refresh all of them. The `copies` step of `scripts/upstream-check.sh` fails if a copy differs from the fork.

## Tests

`pnpm test` runs the unit tests from the root vitest config. They stub `HttpClient`, so they make no network calls.

The suites in `packages/amazon-bedrock/test/live/` call real Bedrock and cost money. Two gates keep them from running by accident. `vitest.config.ts` skips every `*.integration.test.ts` file unless `EFFECT_INTEGRATION_TESTS=1`, and each suite skips itself when `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is unset. Run them only when the user asks:

```sh
EFFECT_INTEGRATION_TESTS=1 AWS_REGION=eu-west-1 pnpm vitest run --no-file-parallelism packages/amazon-bedrock/test/live
```

Keep `--no-file-parallelism`. If the files run at the same time, the burst exceeds the account's tokens-per-minute quota and some tests fail with `RateLimitError`.

## Effect source and docs (`node_modules/`)

Effect is the exception to the usual rule of not reading `node_modules/`. Every Effect package ships its TypeScript source in `src/` next to the build output, so the installed copy is the source at exactly the version in the lockfile. Do not clone Effect into `.repos/deps/`, and do not read it on GitHub, where `main` shows APIs this lockfile does not have.

Each Effect package also ships agent documentation, and it is the first place to look:

- `AGENTS.md` covers how to write Effect code: `Effect.gen` and `Effect.fn`, services with `Context.Service` and `Layer`, tagged errors, `Schema`, streams, HTTP clients, and testing with `@effect/vitest`. Follow its conventions.
- `ai-docs/src/` holds the runnable examples that `AGENTS.md` links to, one file per topic.
- `src/` is the source itself. The provider implements the interfaces in `src/ai/`.

pnpm does not hoist the packages to the root `node_modules/`. Reach `effect` through `packages/amazon-bedrock/node_modules/effect/` and `@effect/vitest` through `node_modules/@effect/vitest/`. They are symlinks into `node_modules/.pnpm/`, and the version in that path tells you which build you are reading.

## Upstream source (`.repos/`)

`.repos/` holds upstream source that `scripts/repos.js` clones from the entries in `repos.config.js`. Read it instead of guessing at AWS wire formats or recalling APIs from memory.

| Command           | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `pnpm refs:fetch` | Clone or refresh every reference repo to its branch tip        |
| `pnpm deps:fetch` | Clone or check out every dependency repo at its pinned version |
| `pnpm deps:check` | Offline check that fails if a dependency checkout drifted      |

`.repos/` is git-ignored and hidden, so ripgrep and glob tools skip it by default. Pass the path and turn off the ignore rules:

```sh
rg --hidden --no-ignore 'ConverseStream' .repos/refs/api-models-aws
```

`scripts/repos.js` treats the parent of its own directory as the repository root. It reads `repos.config.js` from that root and writes `.repos/` there, so `pnpm deps:fetch` run in a worktree creates `<worktree>/.repos/`. Run the three commands from the main checkout. To read the main checkout's `.repos/` from a worktree, do not use `git rev-parse --show-toplevel`, which returns the worktree. The parent of the shared `.git` directory is the main checkout:

```sh
"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.repos"
```

Keep `--path-format=absolute`. Without it, git answers relative to the current directory, and the path breaks once you store it or pass it on.

### References (`.repos/refs/`)

References are read for prior art and API shapes, not built against, so they track the branch tip.

| Name                | Upstream                                                                  | Read it for                                                                                                                                                | Key paths                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-models-aws`    | [aws/api-models-aws](https://github.com/aws/api-models-aws)               | The Smithy models for the Bedrock Runtime Converse API. They are the source of truth for `AmazonBedrockSchema.ts`.                                         | `models/bedrock-runtime/service/2023-09-30/bedrock-runtime-2023-09-30.json`                                                                                                                                                              |
| `aws-sdk-js-v3`     | [aws/aws-sdk-js-v3](https://github.com/aws/aws-sdk-js-v3)                 | The generated TypeScript client for the same API, with concrete types where the Smithy models are abstract. The clone is about 750 MB.                     | `clients/client-bedrock-runtime/src/models/models_0.ts` (the unions for every `ContentBlock` and stream event), `clients/client-bedrock-runtime/src/commands/Converse{,Stream}Command.ts`, `clients/client-bedrock-runtime/src/schemas/` |
| `smithy-typescript` | [awslabs/smithy-typescript](https://github.com/awslabs/smithy-typescript) | The reference `vnd.amazon.eventstream` codec that `AmazonBedrockEventStream.ts` reimplements: the prelude, header, and payload framing and the CRC checks. | `packages/eventstream-codec/src/`, `packages/eventstream-serde-universal/src/`                                                                                                                                                           |
| `vercel-ai`         | [vercel/ai](https://github.com/vercel/ai)                                 | The AI SDK's own Amazon Bedrock provider, as prior art for tool choice, stop reasons, and streaming deltas.                                                | `packages/amazon-bedrock/src/`                                                                                                                                                                                                           |

### Dependencies (`.repos/deps/`)

Dependencies are what the package builds against, pinned to a version so the source never shows an API the package cannot use. The pin is the lower bound of the range in `packages/amazon-bedrock/package.json`, not the version in the lockfile. If you raise the range, run `pnpm deps:fetch`.

| Name        | Upstream                                              | Pin        | Notes                                                                                                                                       |
| ----------- | ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws4fetch` | [mhart/aws4fetch](https://github.com/mhart/aws4fetch) | tag `v{v}` | The SigV4 signer that `AmazonBedrockClient` uses. The npm probe reads the version from the range in `packages/amazon-bedrock/package.json`. |

## Before you claim work is done

Run these four commands. Each must exit 0, and `pnpm check` must print no diagnostic, because its exit code ignores Effect diagnostics.

```sh
pnpm lint
pnpm check
pnpm test
FORK_REPO=<effect checkout> bash scripts/upstream-check.sh . <log dir>
```

`scripts/upstream-check.sh` checks the copied tooling files against the Effect fork. Then it copies `packages/amazon-bedrock/src` and `test` into a throwaway worktree of the fork at `<log dir>/fork-wt`. It runs `dprint check` on each file that names `@wmaurer/effect-ai-amazon-bedrock`, reverses the rename, and runs `dprint fmt` on the file to restore the import order. Then it runs the fork's oxlint, dprint, `tsc`, vitest, doctest, cycle, and codegen steps on the package. Vitest runs twice. The second run matches the fork's CI test job, with `EFFECT_INTEGRATION_TESTS=1` and every `AWS_*` variable unset, so the live suites load and skip. The last line of the output is `UPSTREAM-READY` only when the check runs every step and each one passes. The last line is `NOT-READY` when a step fails, when the check stops early, and when a signal such as SIGINT, SIGTERM, or SIGHUP ends it. SIGKILL ends the check before it can print a verdict, so a summary with no verdict line counts as not ready. The check refuses to start if `<log dir>/fork-wt` exists, and it removes only the worktree that it created. The `src-diff` and `test-diff` steps only report how the package differs from the fork, and they do not change the result. The check runs only part of the fork's CI. It skips `deno check`, `pnpm test-types`, `pnpm ai-docgen`, `pnpm build`, `pnpm check-dist-types`, the bundle job, and the Deno and Bun test runs. The fork's doctest finds no examples in this package, so the `doctest` step passes without running a test. `FORK_REPO` must point at a git checkout of `effect-ts/effect` that has the fork commit. `FORK_REF` selects another commit.

A published npm version can never be reused, even after an unpublish. Publish only when the user asks.
