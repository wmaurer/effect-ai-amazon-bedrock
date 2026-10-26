# AGENTS.md

Instructions for coding agents working in this repository.

`CLAUDE.md` is a symlink to this file, so both names resolve to the same rules.

## The package (`packages/amazon-bedrock/`)

`@wmaurer/effect-ai-amazon-bedrock` is an Amazon Bedrock provider for Effect AI. `AmazonBedrockLanguageModel` talks to the Bedrock Runtime Converse and ConverseStream APIs. `AmazonBedrockClient` signs each request with SigV4 through `aws4fetch`, and `AmazonBedrockEventStream` decodes the `vnd.amazon.eventstream` frames of a streamed response. `AmazonBedrockSchema` holds the Converse wire shapes.

The package started as `packages/ai/amazon-bedrock` in a fork of `effect-ts/effect` and may go back there as a pull request. For that reason it follows Effect's own lint, format, and tsconfig rules. Its imports, JSDoc examples, service keys, and schema identifiers use `@wmaurer/effect-ai-amazon-bedrock`, and `tsconfig.tests.json` maps that name to `packages/amazon-bedrock/src`. `scripts/upstream-check.sh` reverses the rename to the fork's package name with one `sed`, then runs `dprint fmt` to restore the import order.

`effect` is a peer dependency (`^4.0.5`) and a dev dependency pinned to the version the tests run on. The `overrides` entry in `pnpm-workspace.yaml` pins the same version for the whole workspace. To upgrade Effect, bump the `effect` dev pin in `packages/amazon-bedrock/package.json`, the `@effect/vitest` dev pin in the root `package.json`, and the override together.

A `@since` tag names the version of this package that added the API, such as `0.1.0`. Effect tags the Effect release instead, so `scripts/upstream-check.sh` rewrites every `@since` in the copy to `UPSTREAM_SINCE`, which defaults to `4.0.0`.

`src/index.ts` comes from the `effect-utils codegen` command of the Effect monorepo, which this repository does not have. When you add a module, add an export block in the same form as the others, a JSDoc comment with `@stability unstable` and `@since`, and an `export * as` line. The new module's own JSDoc and each of its exports need a `@stability` tag too, because the fork's `tsc` and its JSDoc check require one. The `barrel` step of `scripts/upstream-check.sh` runs the codegen and fails if its output differs from the file.

The open [GitHub issues](https://github.com/wmaurer/effect-ai-amazon-bedrock/issues) list the work to do, such as the Converse capabilities that the provider does not model yet. `docs/TODO.md` records what probes and live runs found, the assumptions that no live run has checked, and the features left out on purpose. Read both before you add a capability. File new work as an issue, not as an entry in `docs/TODO.md`. `docs/design/` holds the design records for features. The records dated 2026-08 are copied verbatim from the Effect fork. Oxlint and dprint skip `docs/`. `docs/design/2026-10-17-bedrock-credentials-design.md` is the design and plan for 0.2.0, which is not implemented yet.

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

The suites in `packages/amazon-bedrock/test/live/` call real Bedrock and cost money. Two gates keep them from running by accident. `vitest.config.ts` skips every `*.integration.test.ts` file unless `EFFECT_INTEGRATION_TESTS=1`, and each suite skips itself when `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is unset. Run them only when the user asks, and run them from the repository root:

```sh
pnpm test:live
```

The script sets `EFFECT_INTEGRATION_TESTS=1` and passes `--no-file-parallelism`. Keep that flag if you run vitest yourself. If the files run at the same time, the burst can exceed the account's tokens-per-minute quota and some tests fail with `RateLimitError`. `packages/amazon-bedrock/test/live/README.md` says which credentials the suites need, how to choose the region and the model, and how to read a failed run.

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

| Name                | Upstream                                                                  | Read it for                                                                                                                                                                            | Key paths                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-models-aws`    | [aws/api-models-aws](https://github.com/aws/api-models-aws)               | The Smithy models for the Bedrock Runtime Converse API. They are the source of truth for `AmazonBedrockSchema.ts`.                                                                     | `models/bedrock-runtime/service/2023-09-30/bedrock-runtime-2023-09-30.json`                                                                                                                                                              |
| `aws-sdk-js-v3`     | [aws/aws-sdk-js-v3](https://github.com/aws/aws-sdk-js-v3)                 | The generated TypeScript client for the same API, with concrete types where the Smithy models are abstract. The clone is about 750 MB.                                                 | `clients/client-bedrock-runtime/src/models/models_0.ts` (the unions for every `ContentBlock` and stream event), `clients/client-bedrock-runtime/src/commands/Converse{,Stream}Command.ts`, `clients/client-bedrock-runtime/src/schemas/` |
| `smithy-typescript` | [awslabs/smithy-typescript](https://github.com/awslabs/smithy-typescript) | The reference `vnd.amazon.eventstream` codec that `AmazonBedrockEventStream.ts` reimplements: the prelude, header, and payload framing and the CRC checks.                             | `packages/eventstream-codec/src/`, `packages/eventstream-serde-universal/src/`                                                                                                                                                           |
| `vercel-ai`         | [vercel/ai](https://github.com/vercel/ai)                                 | The AI SDK's own Amazon Bedrock provider, as prior art for tool choice, stop reasons, and streaming deltas.                                                                            | `packages/amazon-bedrock/src/`                                                                                                                                                                                                           |
| `pydantic-ai`       | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai)           | Pydantic AI's Bedrock model, a second Converse client in Python. Its per-family model profiles are prior art for which models accept which tool choices, thinking fields, and caching. | `pydantic_ai_slim/pydantic_ai/providers/bedrock.py` (the profiles), `pydantic_ai_slim/pydantic_ai/models/bedrock.py`                                                                                                                     |

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

`scripts/upstream-check.sh` checks the copied tooling files against the Effect fork. Then it copies `packages/amazon-bedrock/src` and `test` into a throwaway worktree of the fork at `<log dir>/fork-wt`. It runs `dprint check` on each file that names `@wmaurer/effect-ai-amazon-bedrock`, reverses the rename, and runs `dprint fmt` on the file to restore the import order. Then it runs the fork's oxlint, dprint, `tsc`, JSDoc, vitest, doctest, cycle, and codegen steps on the package. The fork's `tsconfig.base.json` keeps Effect diagnostics out of the `tsc` exit code, so the `tsc-src` and `tsc-test` steps fail when their log holds any diagnostic line, as `pnpm check` must print none here. The `jsdocs` step runs the fork's `effect-jsdocs --check`, which reads the whole fork. A finding in the package fails the step. The fork branch has findings of its own outside the package, in `packages/effect/src/ai/Prompt.ts` from fork commit `c7e0817fae`, so the tool exits nonzero there. The step then passes only when the output is the tool's completed report and every finding is outside the package, and the summary counts those findings as informational. Any other output, and an exit from a signal, fails the step. Vitest runs twice. The second run matches the fork's CI test job, with `EFFECT_INTEGRATION_TESTS=1` and every `AWS_*` variable unset, so the live suites load and skip. The last line of the output is `UPSTREAM-READY` only when the check runs every step and each one passes. The last line is `NOT-READY` when a step fails, when the check stops early, and when a signal such as SIGINT, SIGTERM, or SIGHUP ends it. SIGKILL ends the check before it can print a verdict, so a summary with no verdict line counts as not ready. The check refuses to start if `<log dir>/fork-wt` exists, and it removes only the worktree that it created. The `src-diff` and `test-diff` steps only report how the package differs from the fork, and they do not change the result. The check runs only part of the fork's CI. It skips `deno check`, `pnpm test-types`, `pnpm ai-docgen`, `pnpm build`, `pnpm check-dist-types`, the bundle job, and the Deno and Bun test runs. The fork's doctest finds no examples in this package, so the `doctest` step passes without running a test. `FORK_REPO` must point at a git checkout of `effect-ts/effect` that has the fork commit. `FORK_REF` selects another commit.

Commit messages must not carry a `Co-Authored-By` line naming Claude, and pull request descriptions must not carry a "Generated with Claude Code" line.

## Release a version

Only the operator publishes. Never run `pnpm publish` without `--dry-run`, and never run `npm login`. npm never accepts a published version again, even after an unpublish, so a wrong publish uses up its version number.

To prepare a release, do these steps on `main`:

1. Set `version` in `packages/amazon-bedrock/package.json`, and add the version's entry to `packages/amazon-bedrock/CHANGELOG.md`.
2. Run `pnpm install`. After a `package.json` change, the `verifyDepsBeforeRun` setting in `pnpm-workspace.yaml` makes every `pnpm` script fail with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` until the install runs.
3. Run `bash scripts/smoke-consumer.sh`. It must exit 0.
4. Run `pnpm publish --dry-run --no-git-checks` in `packages/amazon-bedrock`, and check that it names the new version. The dry run does not print the access level. `publishConfig.access` in `package.json` sets it to `public`.
5. Commit the changed files, and push `main` to `origin`.
6. Run `git status`, and check that it shows no changed and no untracked files.

`scripts/smoke-consumer.sh` runs the package's `prepublishOnly` script, which builds `dist/` from scratch as a publish does. It packs the package outside `packages/amazon-bedrock` and installs the tarball and `effect@4.0.5` in a new project. It imports `.` and `./AmazonBedrockLanguageModel` with Node, and fails unless `.` exports exactly the five `AmazonBedrock*` modules and `model` is a function. Then it copies the "Generate text" example from the README into `main.ts`, type-checks it with `tsc`, and runs it with Node, fake credentials, and a stubbed `fetch`, so no request leaves the machine. The stub fails the run unless the request goes to the `eu-west-1` Converse URL and its SigV4 signature uses the fake key, the `eu-west-1` region, and the `bedrock` service, and signs `host` and `x-amz-date`. The script deletes the project when it exits. Give it a directory that does not exist yet, as in `bash scripts/smoke-consumer.sh <dir>`, to keep the project there.

The operator publishes with this command:

```sh
git fetch origin
cd packages/amazon-bedrock && pnpm publish
```

Publish with `pnpm`, never with `npm publish`. `pnpm publish` replaces `exports` with `publishConfig.exports`, which point into `dist/`. npm ignores `publishConfig.exports` and warns `Unknown publishConfig config "exports"`, so its tarball would point `exports` at the `.ts` files in `src/`.

`pnpm publish` stops with `ERR_PNPM_GIT_UNCLEAN` if the checkout has a changed or untracked file. It stops with `ERR_PNPM_GIT_NOT_LATEST` if the upstream of `main`, `origin/main`, has a commit that `main` does not have. It does not stop when `main` is only ahead of `origin/main`. `pnpm publish` compares `main` with the `origin/main` ref that the last `git fetch` wrote, and it does not fetch. Without the `git fetch origin`, it misses commits that reached `origin` since the last fetch. If `main` has no upstream, it never stops with `ERR_PNPM_GIT_NOT_LATEST`. Step 5 pushes `main` so that the published version is a commit on GitHub, where the package's `repository` and `homepage` links point.

The `prepublishOnly` script deletes `dist/` and `tsconfig.tsbuildinfo`, then runs `pnpm build`. `pnpm build` alone is incremental. It leaves the output of a deleted module in `dist/`, where the `./*` export would publish it, and it does not emit again a `dist/` file that someone deleted. The package sets no `publishConfig.provenance`, because a publish from a local machine has no OIDC identity to sign the provenance with.
