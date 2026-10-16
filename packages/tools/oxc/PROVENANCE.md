# Provenance

This directory is a copy of `packages/tools/oxc` from the Effect fork that this package came from, at commit `848ad5935e4d3880d60fd9e5d0d17c8af84a5f05` on the `feat/ai-amazon-bedrock` branch of `github.com/wmaurer/effect`. It is the private `@effect/oxc` package, which holds Effect's oxlint rules. Effect does not publish it to npm.

Upstream [Effect-TS/effect](https://github.com/Effect-TS/effect) does not have the fork commit. The merge base of the fork commit and upstream `main` is `460272d30457f4697d8b8c52cad41caccbcace08`. At that upstream commit, `cmp` finds every file copied here, the root `tsconfig.base.json`, and the root `vitest.setup.ts` identical to the fork's.

The copy holds four paths: `package.json`, `oxlintrc.json`, `tsconfig.json`, and `src/`. Each is byte-identical to the fork's file. Nobody has edited them. The fork's `test/` directory is not copied. `LICENSE` is a byte copy of the fork's root `LICENSE`, Effect's MIT license, which covers this code.

The root `tsconfig.base.json` and `vitest.setup.ts` are byte copies from the same commit, under the same license.

## Refresh the copy

To take the files from a newer fork commit, run these commands from the repository root. Set `fork` to a checkout of the fork at that commit.

```sh
fork=/path/to/effect
rm -rf packages/tools/oxc/src
cp -r "$fork"/packages/tools/oxc/{package.json,oxlintrc.json,tsconfig.json,src} packages/tools/oxc/
cp "$fork"/LICENSE packages/tools/oxc/
cp "$fork"/tsconfig.base.json "$fork"/vitest.setup.ts .
pnpm install
```

Then replace the fork commit in this file. Check the upstream paragraph again with `cmp`, or delete it. Run `pnpm lint`, `pnpm check`, and `pnpm test`.
