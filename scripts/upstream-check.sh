#!/usr/bin/env bash
set -uo pipefail
# The fork's vitest config loads the live suites when this is 1, and they bill when AWS credentials are set.
unset EFFECT_INTEGRATION_TESTS

summary=/dev/null
created=0
ready=0

finish() {
  [ "$created" = 1 ] && git -C "$fork" worktree remove --force "$wt" >/dev/null 2>&1
  if [ "$ready" = 1 ]; then echo "UPSTREAM-READY"; else echo "NOT-READY"; fi | tee -a "$summary"
}
trap finish EXIT
trap 'echo "interrupted by SIGINT" | tee -a "$summary"; exit 130' INT
trap 'echo "interrupted by SIGTERM" | tee -a "$summary"; exit 143' TERM

usage="usage: FORK_REPO=<effect-checkout> upstream-check.sh <standalone-checkout> <log-dir>"
: "${1:?$usage}" "${2:?$usage}"
standalone=$(realpath "$1")
logs=$(realpath -m "$2")
mkdir -p "$logs"
summary="$logs/upstream-summary.log"
: >"$summary"
fork=${FORK_REPO:?set FORK_REPO to a git checkout of effect-ts/effect}
ref=${FORK_REF:-bbff465e30}
wt="$logs/fork-wt"
pkg=packages/ai/amazon-bedrock

step() {
  local name=$1
  shift
  (cd "$wt" && "$@") >"$logs/upstream-$name.log" 2>&1
  local code=$?
  echo "$name exit=$code" | tee -a "$summary"
  return $code
}

copies() {
  local code=0 p
  cmp "$standalone/packages/tools/oxc/LICENSE" LICENSE || code=1
  for p in packages/tools/oxc/package.json packages/tools/oxc/oxlintrc.json packages/tools/oxc/tsconfig.json \
    tsconfig.base.json vitest.setup.ts scripts/repos.js; do
    cmp "$standalone/$p" "$p" || code=1
  done
  diff -r "$standalone/packages/tools/oxc/src" packages/tools/oxc/src || code=1
  return $code
}

copy_package() {
  rm -rf "$pkg/src" "$pkg/test" &&
    cp -r "$standalone/packages/amazon-bedrock/src" "$standalone/packages/amazon-bedrock/test" "$pkg/"
}

# The fork's CI test job sets EFFECT_INTEGRATION_TESTS=1 with no AWS credentials, so the live suites load and skip.
vitest_ci() {
  local v
  for v in $(compgen -e); do
    case $v in AWS_*) unset "$v" ;; esac
  done
  EFFECT_INTEGRATION_TESTS=1 pnpm exec vitest run --project @effect/ai-amazon-bedrock --max-concurrency=10
}

# The fork's tsconfig.base.json keeps Effect diagnostics out of tsc's exit code, so any diagnostic line fails the step.
tsc_clean() {
  local out code
  out=$("$@" 2>&1)
  code=$?
  echo "$out"
  [ "$code" = 0 ] && ! echo "$out" | grep -qE '(error|warning|message) TS[0-9]+|effect\([A-Za-z]+\)'
}

# The fork's jsdocs check reads the whole fork, and the fork branch itself has findings outside the
# package. A nonzero exit passes only when the output is a completed report whose findings are all
# outside the package.
jsdocs() {
  local out code
  out=$(pnpm exec effect-jsdocs --check 2>&1)
  code=$?
  echo "$out"
  local lines=$(echo "$out" | grep -cv '^$')
  local reports=$(echo "$out" | grep -cE '^(Wrote|Skipped) \.data/jsdocs\.json$')
  local findings=$(echo "$out" | grep -cE '^packages/[^:]+\.ts: .')
  local own=$(echo "$out" | grep -cE "^$pkg/[^:]+\.ts: .")
  echo "jsdocs: $((findings - own)) findings outside $pkg, from the fork branch itself, are informational" >>"$summary"
  [ "$own" = 0 ] || return 1
  [ "$code" = 0 ] && return 0
  [ "$code" -lt 128 ] && [ "$reports" = 1 ] && [ "$findings" -gt 0 ] && [ $((reports + findings)) = "$lines" ]
}

if [ -e "$wt" ]; then
  echo "$wt already exists. Remove it or pass another log dir." | tee -a "$summary"
  exit 1
fi
git -C "$fork" worktree add --detach "$wt" "$ref" >"$logs/upstream-worktree.log" 2>&1 || {
  echo "worktree add failed" | tee -a "$summary"
  exit 1
}
created=1

cat >"$wt/tsconfig.bedrock-tests.json" <<'EOF'
{
  "extends": "./tsconfig.tests.json",
  "references": [],
  "compilerOptions": { "composite": false, "incremental": false, "declarationMap": false },
  "include": ["./packages/ai/amazon-bedrock/test/**/*.ts"]
}
EOF

fail=0
step copies copies || fail=1
step install pnpm install --frozen-lockfile --offline || fail=1
step copy copy_package || fail=1

renamed=$(cd "$wt" && grep -rl '@wmaurer/effect-ai-amazon-bedrock' "$pkg/src" "$pkg/test")
echo "$renamed" >"$logs/upstream-renamed-files.log"
if [ -n "$renamed" ]; then
  step pre-rename-dprint pnpm exec dprint check $renamed || fail=1
  (cd "$wt" && echo "$renamed" | xargs sed -i 's#@wmaurer/effect-ai-amazon-bedrock#@effect/ai-amazon-bedrock#g')
  step reverse-fmt pnpm exec dprint fmt $renamed || fail=1
fi
# git diff ignores untracked files, so mark the copied files as intent-to-add
# to make src-diff and test-diff show added files.
(cd "$wt" && git add -N "$pkg/src" "$pkg/test")
step src-diff git diff --stat --exit-code "$ref" -- "$pkg/src" || echo "src-diff is informational" >>"$summary"
step test-diff git diff --stat --exit-code "$ref" -- "$pkg/test" || echo "test-diff is informational" >>"$summary"
step oxlint pnpm exec oxlint -f unix "$pkg" || fail=1
step dprint pnpm exec dprint check "$pkg/**/*.ts" || fail=1
step tsc-src tsc_clean pnpm exec tsc -b "$pkg/tsconfig.json" || fail=1
step tsc-test tsc_clean pnpm exec tsc -p tsconfig.bedrock-tests.json --noEmit || fail=1
step jsdocs jsdocs || fail=1
step vitest pnpm exec vitest run --project @effect/ai-amazon-bedrock || fail=1
step vitest-ci vitest_ci || fail=1
step doctest pnpm exec vitest run --config vitest.docs.ts "$pkg/src" || fail=1
step circular node -e '
  import("madge").then(({ default: madge }) =>
    madge(process.argv[1], { fileExtensions: ["ts"], detectiveOptions: { ts: { skipTypeImports: true } } })
  ).then((res) => {
    const circular = res.circular()
    console.log("files", Object.keys(res.obj()).length, "cycles", circular.length)
    if (circular.length) { console.error(circular); process.exit(1) }
  })' "$pkg/src" || fail=1
cp "$wt/$pkg/src/index.ts" "$logs/upstream-index.before.ts"
step codegen pnpm --filter @effect/ai-amazon-bedrock run codegen || fail=1
step barrel cmp "$logs/upstream-index.before.ts" "$pkg/src/index.ts" || fail=1

[ "$fail" = 0 ] && ready=1
exit $fail
