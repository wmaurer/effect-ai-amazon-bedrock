---
"@effect/ai-amazon-bedrock": minor
---

Add `@effect/ai-amazon-bedrock`, an Amazon Bedrock provider for the Effect AI SDK.

The provider targets the Bedrock Converse API (`converse` and `converse-stream`) with SigV4 request signing (via `aws4fetch`) and a dependency-free decoder for the AWS binary event-stream framing. The initial release is scoped to text generation (`generateText` / `streamText`); the request/response schemas tolerate the full AWS content unions so non-text blocks never fail decoding.
