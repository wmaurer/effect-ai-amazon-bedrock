---
"@effect/ai-amazon-bedrock": minor
---

Add reasoning support to the Amazon Bedrock provider.

- Converse `reasoningContent` blocks now decode on both paths. `generateText` surfaces them as `reasoning` parts; `streamText` surfaces them as `reasoning-start`, `reasoning-delta`, and `reasoning-end`. They were previously decoded as empty blocks and silently dropped.
- Reasoning blocks round-trip into later turns: an assistant `reasoning` prompt part is encoded back as a `reasoningContent` block when it carries the Bedrock payload on its `amazonBedrock` provider options. Bedrock verifies that payload, so a reasoning part without it is dropped rather than sent and rejected.
- Both the `signature` that accompanies reasoning text and the `redactedContent` blob of encrypted reasoning are carried on provider metadata (`ReasoningPartMetadata`, `ReasoningDeltaPartMetadata`) and provider options (`ReasoningPartOptions`). Converse streams the signature as its own trailing delta, which surfaces as metadata on a delta with no text.
