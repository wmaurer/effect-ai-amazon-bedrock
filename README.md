# effect-ai-amazon-bedrock

This repository holds the source of [`@wmaurer/effect-ai-amazon-bedrock`](https://www.npmjs.com/package/@wmaurer/effect-ai-amazon-bedrock), an [Amazon Bedrock](https://aws.amazon.com/bedrock/) provider for the Effect AI modules in `effect/ai`. The package gives an Effect program a `LanguageModel` that calls the Bedrock Runtime Converse and ConverseStream APIs.

To use the package, read [its README](packages/amazon-bedrock/README.md). It explains how to install the package, authenticate, choose a model, and what the provider supports. This file is for working on the repository.

## Repository layout

| Path                      | What it holds                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/amazon-bedrock` | The published package, with its source in `src/`, its unit tests in `test/`, and its changelog                          |
| `packages/tools/oxc`      | A copy of Effect's private `@effect/oxc` package, which holds Effect's custom oxlint rules                              |
| `docs/TODO.md`            | What has been checked against real Bedrock, the assumptions that have not, and the features left out on purpose         |
| `docs/design`             | The design records for features                                                                                         |
| `scripts`                 | `upstream-check.sh`, which checks the package against the Effect fork, and `smoke-consumer.sh`, which tests the tarball |

## Set up the repository

The repository uses pnpm 11.20.0, as the `packageManager` field in `package.json` names.

```sh
pnpm install
```

The install also runs `effect-tsgo patch`, which patches the installed TypeScript so that `tsc` reports Effect diagnostics such as `effect(floatingEffect)`.

## Run the checks

| Command          | What it does                                                               |
| ---------------- | -------------------------------------------------------------------------- |
| `pnpm lint`      | Run oxlint with Effect's rules, then `dprint check`                        |
| `pnpm lint-fix`  | Run `oxlint --fix`, then `dprint fmt`                                      |
| `pnpm check`     | Type-check the package and the tests with `tsc -b`                         |
| `pnpm test`      | Run the unit tests, which stub the HTTP client and make no network calls   |
| `pnpm test:live` | Run the checks in `packages/amazon-bedrock/test/live` against real Bedrock |

`pnpm check` exits 0 even when it prints an Effect diagnostic, so read its output as well as its exit code. A change is ready when it prints none.

The live checks cost money and need AWS credentials. They run only when `EFFECT_INTEGRATION_TESTS=1` is set, which `pnpm test:live` does. [`test/live/README.md`](packages/amazon-bedrock/test/live/README.md) names the credentials and permissions they need and how to choose the region and the model.

## Read the upstream source

`pnpm refs:fetch` clones the AWS Smithy models, the AWS SDK for JavaScript, `smithy-typescript`, and the AI SDK into `.repos/refs/`. `pnpm deps:fetch` checks out `aws4fetch` at the version the package builds against into `.repos/deps/`. `repos.config.js` lists each repository and what it is read for.

## Where the package comes from

The provider started as `packages/ai/amazon-bedrock` in a fork of [`effect-ts/effect`](https://github.com/Effect-TS/effect), and it may go back to Effect as a pull request. For that reason it follows Effect's lint, format, and TypeScript rules rather than its own. `scripts/upstream-check.sh` copies the package into a worktree of the fork and runs the fork's own checks on it.

[`AGENTS.md`](AGENTS.md) holds the rules for coding agents, and it is also the most detailed reference for anyone working here. It covers the upstream check, the files copied from Effect that must not be edited by hand, and the steps to release a version.

## License

MIT. See [`packages/amazon-bedrock/LICENSE`](packages/amazon-bedrock/LICENSE).
