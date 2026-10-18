// Configuration for scripts/repos.js, read from the repo root.
//
//   pnpm refs:fetch     references  -> .repos/refs/<name>, refreshed to tip
//   pnpm deps:fetch     dependencies -> .repos/deps/<name>, pinned
//   pnpm deps:check     offline: fail if any dep source drifted
//
// `.repos/` is git-ignored, and hidden, so ripgrep/glob tooling skips it by
// default — pass the path explicitly:
//
//   rg --hidden --no-ignore 'ConverseStream' .repos/refs/api-models-aws
//
// See docs/features/repos.md in https://github.com/wmaurer/project-setup for
// the full field reference.

export default {
  // REFERENCE repos: read for prior art and API shapes, not built against, so
  // tracking the branch tip is what we want — newer is strictly better.
  refs: [
    // Authoritative Smithy models for the Bedrock Runtime Converse API: the
    // source of truth behind AmazonBedrockSchema.ts. The Converse request /
    // response / stream-event shapes live in
    //   models/bedrock-runtime/service/2023-09-30/bedrock-runtime-2023-09-30.json
    {
      name: "api-models-aws",
      url: "https://github.com/aws/api-models-aws.git"
    },
    // Generated TypeScript clients for the same API: concrete types where the
    // Smithy models are abstract. Large clone (~750MB working tree).
    //   clients/client-bedrock-runtime/src/models/
    //   clients/client-bedrock-runtime/src/schemas/
    {
      name: "aws-sdk-js-v3",
      url: "https://github.com/aws/aws-sdk-js-v3.git"
    },
    // The reference vnd.amazon.eventstream codec that AmazonBedrockEventStream.ts
    // reimplements — prelude/headers/payload framing and the CRC checks. Lives
    // here rather than in aws-sdk-js-v3, which only consumes it.
    //   packages/eventstream-codec/src/
    //   packages/eventstream-serde-universal/src/
    {
      name: "smithy-typescript",
      url: "https://github.com/awslabs/smithy-typescript.git"
    },
    // The AI SDK's own Amazon Bedrock provider, as prior art for feature
    // coverage and edge cases (tool choice, stop reasons, streaming deltas).
    //   packages/amazon-bedrock/src/
    {
      name: "vercel-ai",
      url: "https://github.com/vercel/ai.git"
    },
    // Pydantic AI's Bedrock model, a second Converse client, as prior art for
    // which model families accept which tool choices and output formats.
    //   pydantic_ai_slim/pydantic_ai/models/bedrock.py
    //   pydantic_ai_slim/pydantic_ai/providers/bedrock.py
    {
      name: "pydantic-ai",
      url: "https://github.com/pydantic/pydantic-ai.git"
    }
  ],

  // DEPENDENCY source repos: the things this project is built against, pinned
  // so the source never shows an API we do not have.
  deps: [
    // Tag scheme verified with `git ls-remote --tags`: plain v-prefixed
    // versions, e.g. v1.0.20.
    //
    // pnpm does not hoist aws4fetch to <repoRoot>/node_modules, so the npm
    // probe reads the version from the range in
    // packages/amazon-bedrock/package.json. scripts/repos.js requires `seed`
    // but uses it only when the probe finds no version.
    {
      name: "aws4fetch",
      url: "https://github.com/mhart/aws4fetch.git",
      probe: { kind: "npm", pkg: "aws4fetch" },
      tag: "v{v}",
      seed: "1.0.20"
    }
  ]
}
