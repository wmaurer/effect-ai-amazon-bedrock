#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pkg=$repo/packages/amazon-bedrock
name=@wmaurer/effect-ai-amazon-bedrock

if [ $# -gt 0 ]; then
  if [ -e "$1" ]; then
    echo "smoke-consumer: $1 exists, give a path that does not" >&2
    exit 2
  fi
  mkdir -p "$1"
  work=$(cd "$1" && pwd)
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi

pnpm --dir "$pkg" run prepublishOnly

pnpm --dir "$pkg" pack --pack-destination "$work"
tarball=$(ls "$work"/*.tgz)

consumer=$work/consumer
mkdir "$consumer"
cd "$consumer"
printf '{ "name": "consumer", "private": true, "type": "module" }\n' > package.json
pnpm add --ignore-workspace "$tarball" effect@4.0.5

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "lib": ["ESNext", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true
  },
  "files": ["main.ts"]
}
EOF

awk '/^## Generate text/ { section = 1 } section && /^```ts$/ { code = 1; next } code && /^```$/ { exit } code' \
  "$pkg/README.md" > main.ts
if ! grep -q "$name" main.ts; then
  echo "smoke-consumer: no example found under \"## Generate text\" in README.md" >&2
  exit 1
fi

modules=$(node --input-type=module -e "
const root = await import('$name')
const languageModel = await import('$name/AmazonBedrockLanguageModel')
console.log(Object.keys(root).sort().join(','), typeof languageModel.model)
")
expected="AmazonBedrockClient,AmazonBedrockConfig,AmazonBedrockEventStream,AmazonBedrockLanguageModel,AmazonBedrockSchema function"
if [ "$modules" != "$expected" ]; then
  echo "smoke-consumer: the package exports \"$modules\", expected \"$expected\"" >&2
  exit 1
fi
echo "exports: $modules"

"$repo/node_modules/.bin/tsc" -p tsconfig.json

cat > fetch-stub.mjs <<'EOF'
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  if (!/^https:\/\/bedrock-runtime\.eu-west-1\.amazonaws\.com\/model\/[^/]+\/converse$/.test(request.url)) {
    throw new Error(`unexpected URL ${request.url}`)
  }
  const authorization = request.headers.get("authorization") ?? ""
  const signed = /^AWS4-HMAC-SHA256 Credential=AKIDSMOKE\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/
    .exec(authorization)
  const signedHeaders = signed?.[1].split(";") ?? []
  if (!signedHeaders.includes("host") || !signedHeaders.includes("x-amz-date") || !request.headers.has("x-amz-date")) {
    throw new Error(`request is not signed for eu-west-1 bedrock with the smoke credentials: ${authorization}`)
  }
  return Response.json({
    output: { message: { role: "assistant", content: [{ text: "Stub answer from the smoke test." }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 }
  })
}
EOF

answer=$(env -u AWS_SESSION_TOKEN AWS_ACCESS_KEY_ID=AKIDSMOKE AWS_SECRET_ACCESS_KEY=smoke AWS_REGION=eu-west-1 \
  node --import ./fetch-stub.mjs main.ts)
if [ "$answer" != "Stub answer from the smoke test." ]; then
  echo "smoke-consumer: node main.ts printed \"$answer\"" >&2
  exit 1
fi
echo "node main.ts: $answer"
