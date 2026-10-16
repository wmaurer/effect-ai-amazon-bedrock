# Provenance

This directory is a copy of `packages/tools/oxc` from the Effect fork that this package came from, at commit `56c259e20ddc242591c478b44fed55b6f64f1052` on the `feat/ai-amazon-bedrock` branch of `github.com/wmaurer/effect`. The branch was rebased onto Effect 4.0.3, and the copied files have not changed since its manifest commit `68508ea309`. It is the private `@effect/oxc` package, which holds Effect's oxlint rules. Effect does not publish it to npm.

Upstream [Effect-TS/effect](https://github.com/Effect-TS/effect) does not have the fork commit. The merge base of the fork commit and upstream `main` is `cea74c92ac839009c6ba112504689d8726f648d7`. At that upstream commit, `cmp` finds every file copied here, the root `tsconfig.base.json`, and the root `vitest.setup.ts` identical to the fork's.

The copy holds four paths: `package.json`, `oxlintrc.json`, `tsconfig.json`, and `src/`. Each is byte-identical to the fork's file. Nobody has edited them. The fork's `test/` directory is not copied. `LICENSE` is a byte copy of the fork's root `LICENSE`, Effect's MIT license, which covers this code.

The root `tsconfig.base.json` and `vitest.setup.ts` are byte copies from the same commit, under the same license. `scripts/repos.js` is also a byte copy of the fork's file, but it is not Effect code. It is the generated bundle of the `repos` feature of `github.com/wmaurer/project-setup`, identical to `assets/scripts/repos.js` at project-setup commit `4a4a594`, and fork commit `3d74054d94` added it to the branch. The `copies` step of `scripts/upstream-check.sh` compares every copy with the fork at the commit that `FORK_REF` names.

## Refresh the copy

To take the files from a newer fork commit, run these commands from the repository root. Set `fork` to a checkout of the fork at that commit.

```sh
fork=/path/to/effect
rm -rf packages/tools/oxc/src
cp -r "$fork"/packages/tools/oxc/{package.json,oxlintrc.json,tsconfig.json,src} packages/tools/oxc/
cp "$fork"/LICENSE packages/tools/oxc/
cp "$fork"/tsconfig.base.json "$fork"/vitest.setup.ts .
cp "$fork"/scripts/repos.js scripts/
pnpm install
```

Then replace the fork commit in this file and the `FORK_REF` default in `scripts/upstream-check.sh`. The `copies` step compares the tooling copies, and the `src-diff` and `test-diff` steps compare the package, all at that one commit, so `FORK_REF` must name a commit that holds both the tooling copies and the package's latest fork commit. Check the upstream paragraph again with `cmp`, or delete it. Compare the `@oxlint/plugins` override in `pnpm-workspace.yaml` and the tool versions in the root `package.json` with the new commit's lockfile. Run `pnpm lint`, `pnpm check`, `pnpm test`, and `scripts/upstream-check.sh`.
