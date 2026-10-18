import type { AmazonBedrockClient, AmazonBedrockSchema } from "@wmaurer/effect-ai-amazon-bedrock"
import { AmazonBedrockLanguageModel } from "@wmaurer/effect-ai-amazon-bedrock"

declare const client: AmazonBedrockClient.Service

const streamRequest: typeof AmazonBedrockSchema.ConverseStreamRequest.Encoded = {
  modelId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  messages: [],
  guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "DRAFT", streamProcessingMode: "async" }
}

// The two wire shapes

export const streamed = client.converseStream({ payload: streamRequest })

export const converse = client.converse({
  payload: { modelId: "m", messages: [], guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1" } }
})

// @ts-expect-error a ConverseStream request does not fit Converse until the mode is removed
export const streamToConverse = client.converse({ payload: streamRequest })

// Config

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
