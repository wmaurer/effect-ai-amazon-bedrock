---
"@effect/ai-amazon-bedrock": patch
---

Model `additionalModelRequestFields` on the Converse request.

Converse carries model-specific inference parameters in
`additionalModelRequestFields`, a free-form JSON object alongside the base
`inferenceConfig`. It was not modelled, so parameters outside the base set were
unreachable — most visibly extended thinking on Anthropic models, which is
enabled only through this field.

The field goes on `ConverseRequest`, which `converse` and `converse-stream`
share, so both paths gain it at once. `Config` is derived from that schema, so
it is settable per request through `withConfigOverride` with no further
plumbing:

```ts
LanguageModel.generateText({ prompt }).pipe(
  AmazonBedrockLanguageModel.withConfigOverride({
    additionalModelRequestFields: {
      thinking: { type: "enabled", budget_tokens: 1024 }
    },
    inferenceConfig: { maxTokens: 4096 }
  })
)
```

The payload is deliberately left free-form rather than typed per model: its
shape is defined by the target model, not by Converse, so a typed surface here
would mean the provider owning a model-to-spelling table it cannot keep
current. Note that the thinking budget is drawn from the same ceiling as the
visible answer, so `inferenceConfig.maxTokens` must exceed `budget_tokens`.
