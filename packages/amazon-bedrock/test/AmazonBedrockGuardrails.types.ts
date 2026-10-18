import type { AmazonBedrockClient, AmazonBedrockSchema } from "@wmaurer/effect-ai-amazon-bedrock"
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"
import { Effect, Schema } from "effect"
import { LanguageModel, Prompt, type Response } from "effect/ai"

declare const client: AmazonBedrockClient.Service

const streamRequest: typeof AmazonBedrockSchema.ConverseStreamRequest.Encoded = {
  modelId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  messages: [],
  guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "DRAFT", streamProcessingMode: "async" }
}

export const streamed = client.converseStream({ payload: streamRequest })

export const converse = client.converse({
  payload: { modelId: "m", messages: [], guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1" } }
})

// @ts-expect-error a ConverseStream request does not fit Converse until the mode is removed
export const streamToConverse = client.converse({ payload: streamRequest })

type Config = typeof AmazonBedrockLanguageModel.Config.Service

export const accepted: ReadonlyArray<Config> = [
  { guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1", trace: "enabled" } },
  { guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "DRAFT", streamProcessingMode: "async" } },
  { guardrailConfig: undefined }
]

export const model = AmazonBedrockLanguageModel.model("eu.anthropic.claude-sonnet-4-5-20250929-v1:0", {
  guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1", trace: "enabled" }
})

export const rejected: ReadonlyArray<Config> = [
  // @ts-expect-error guardrailVersion is required
  { guardrailConfig: { guardrailIdentifier: "gr-1" } },
  // @ts-expect-error guardrailIdentifier is required
  { guardrailConfig: { guardrailVersion: "1" } },
  // @ts-expect-error a trace value outside the Smithy enum
  { guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1", trace: "on" } },
  // @ts-expect-error a stream processing mode outside the Smithy enum
  { guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1", streamProcessingMode: "batch" } }
]

export const guardedPrompt = Prompt.make([
  { role: "system", content: "Answer from the documents.", options: { amazonBedrock: { guardContent: true } } },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "Refunds within 30 days.",
        options: { amazonBedrock: { guardContent: { qualifiers: ["grounding_source"] } } }
      },
      {
        type: "text",
        text: "Refund after 45 days?",
        options: { amazonBedrock: { guardContent: { qualifiers: ["query"] } } }
      },
      {
        type: "file",
        mediaType: "image/png",
        data: new Uint8Array(),
        options: { amazonBedrock: { guardContent: true } }
      }
    ]
  }
])

export const rejectedOptions = {
  // @ts-expect-error an image takes no qualifiers
  file: { amazonBedrock: { guardContent: { qualifiers: ["query"] } } } satisfies Prompt.FilePartOptions,
  // @ts-expect-error a qualifier outside the Smithy enum
  text: { amazonBedrock: { guardContent: { qualifiers: ["question"] } } } satisfies Prompt.TextPartOptions,
  // @ts-expect-error guardContent is true or qualifiers, never false
  system: { amazonBedrock: { guardContent: false } } satisfies Prompt.SystemMessageOptions
}

export const finishOutcome = LanguageModel.generateText({ prompt: guardedPrompt }).pipe(
  Effect.map((response) => {
    const bedrock = response.content.find((part) => part.type === "finish")?.metadata.amazonBedrock
    return bedrock?.stopReason === "guardrail_intervened" && bedrock.guardrail?.input === "blocked"
  })
)

export const objectOutcome = LanguageModel.generateObject({
  prompt: guardedPrompt,
  schema: Schema.Struct({ refund: Schema.Boolean })
}).pipe(
  Effect.catchReason(
    "AiError",
    "ContentPolicyError",
    (reason) => Effect.succeed(reason.metadata.amazonBedrock?.guardrail?.policies ?? [])
  )
)

export const metadata: Response.FinishPartMetadata = {
  amazonBedrock: {
    stopReason: "guardrail_intervened",
    guardrail: { input: "none", output: "masked", policies: ["sensitiveInformationPolicy"] },
    trace: { guardrail: { actionReason: "Guardrail masked." } }
  }
}
