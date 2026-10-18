import type * as Schema from "effect/Schema"
import type { FinishMetadata, GuardrailAction, GuardrailOutcome } from "../AmazonBedrockLanguageModel.ts"

const strength: Record<GuardrailAction, number> = { none: 0, masked: 1, blocked: 2 }

const stronger = (a: GuardrailAction, b: GuardrailAction): GuardrailAction => strength[b] > strength[a] ? b : a

const isObject = (value: unknown): value is Schema.MutableJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const actionOf = (value: string): GuardrailAction =>
  value === "BLOCKED" ? "blocked" : value === "ANONYMIZED" ? "masked" : "none"

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

/** @internal */
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

/** @internal */
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
 * Bedrock stops with `guardrail_intervened` both when a guardrail blocks,
 * replacing the text with the guardrail's blocked message, and when it masks,
 * leaving the object JSON.
 *
 * @internal
 */
export const blocksObject = (stopReason: string, text: string): boolean =>
  stopReason === "guardrail_intervened" && !isJson(text)
