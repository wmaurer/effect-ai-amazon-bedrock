import type * as Schema from "effect/Schema"
import type { FinishMetadata, GuardrailAction, GuardrailOutcome } from "../AmazonBedrockLanguageModel.ts"

const strength: Record<GuardrailAction, number> = { none: 0, masked: 1, blocked: 2 }

const stronger = (a: GuardrailAction, b: GuardrailAction): GuardrailAction => strength[b] > strength[a] ? b : a

const isObject = (value: unknown): value is Schema.MutableJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const actionOf = (value: string): GuardrailAction =>
  value === "BLOCKED" ? "blocked" : value === "ANONYMIZED" ? "masked" : "none"

// Every string at a key named `action`, at any depth, so that a policy AWS
// adds later is read without a list of policies to keep in step with Smithy.
const strongestAction = (value: Schema.MutableJson): GuardrailAction => {
  let action: GuardrailAction = "none"
  if (Array.isArray(value)) {
    for (const item of value) {
      action = stronger(action, strongestAction(item))
    }
  } else if (isObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      action = stronger(
        action,
        key === "action" && typeof member === "string" ? actionOf(member) : strongestAction(member)
      )
    }
  }
  return action
}

const assessSide = (assessments: ReadonlyArray<Schema.MutableJson>, policies: Array<string>): GuardrailAction => {
  let side: GuardrailAction = "none"
  for (const assessment of assessments) {
    if (!isObject(assessment)) {
      continue
    }
    for (const [policy, member] of Object.entries(assessment)) {
      const action = strongestAction(member)
      if (action !== "none" && !policies.includes(policy)) {
        policies.push(policy)
      }
      side = stronger(side, action)
    }
  }
  return side
}

/**
 * Reads what the guardrails did from a Converse trace.
 *
 * **Details**
 *
 * `inputAssessment` maps each guardrail to one assessment, and
 * `outputAssessments` maps each guardrail to one assessment per chunk. A
 * member that is missing or has another type counts as nothing found.
 * Returns `null` only when the trace has no `guardrail` object.
 *
 * @internal
 */
export const guardrailOutcome = (trace: Schema.MutableJson | undefined): GuardrailOutcome | null => {
  const guardrail = isObject(trace) ? trace.guardrail : undefined
  if (!isObject(guardrail)) {
    return null
  }
  const inputAssessment = guardrail.inputAssessment
  const outputAssessments = guardrail.outputAssessments
  const policies: Array<string> = []
  const input = assessSide(isObject(inputAssessment) ? Object.values(inputAssessment) : [], policies)
  const output = assessSide(
    isObject(outputAssessments)
      ? Object.values(outputAssessments).flatMap((chunks) => Array.isArray(chunks) ? chunks : [])
      : [],
    policies
  )
  return { input, output, policies }
}

/**
 * Builds the Amazon Bedrock metadata of a finish part, on both response paths.
 *
 * @internal
 */
export const finishMetadata = (stopReason: string | null, trace: Schema.MutableJson | undefined): FinishMetadata => ({
  stopReason,
  guardrail: guardrailOutcome(trace),
  trace: trace ?? null
})

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `generateObject` fails with `ContentPolicyError` instead of decoding
 * the text.
 *
 * **Details**
 *
 * A blocked response holds the guardrail's blocked message, which is not
 * JSON, so the rule needs no trace. The decoder would fail with a
 * `StructuredOutputError`, which is retryable, and a retry pays again for the
 * same block. A masked object is still JSON and goes on to the decoder.
 *
 * @internal
 */
export const blocksObject = (stopReason: string, text: string): boolean =>
  stopReason === "guardrail_intervened" && !isJson(text)
