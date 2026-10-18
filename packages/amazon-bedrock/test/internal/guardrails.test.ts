import { assert, describe, it } from "@effect/vitest"
import * as Guardrails from "@wmaurer/effect-ai-amazon-bedrock/internal/guardrails"
import { inputBlockedTrace, outputMaskedTrace } from "../utils.ts"

const customWord = (action: string) => ({ customWords: [{ match: "zorptangle", action, detected: action !== "NONE" }] })

const regex = (action: string) => ({
  regexes: [{ name: "ticket", match: "TKT-123456", regex: "TKT-[0-9]{6}", action, detected: action !== "NONE" }]
})

const enforced = {
  guardrailId: "gr-org",
  guardrailVersion: "1",
  guardrailOrigin: ["ACCOUNT_ENFORCED"],
  guardrailOwnership: "SELF"
}

describe("guardrailOutcome", () => {
  it("reads a blocked input", () => {
    assert.deepStrictEqual(Guardrails.guardrailOutcome(inputBlockedTrace), {
      input: "blocked",
      output: "none",
      policies: ["wordPolicy"]
    })
  })

  it("reads a masked output", () => {
    assert.deepStrictEqual(Guardrails.guardrailOutcome(outputMaskedTrace), {
      input: "none",
      output: "masked",
      policies: ["sensitiveInformationPolicy"]
    })
  })

  it("prefers blocked over masked on one side", () => {
    const trace = {
      guardrail: {
        outputAssessments: {
          "gr-1": [{ sensitiveInformationPolicy: regex("ANONYMIZED"), wordPolicy: customWord("BLOCKED") }]
        }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), {
      input: "none",
      output: "blocked",
      policies: ["sensitiveInformationPolicy", "wordPolicy"]
    })
  })

  it("reads every guardrail, an account enforced one included", () => {
    const trace = {
      guardrail: {
        inputAssessment: {
          "gr-1": { wordPolicy: customWord("NONE") },
          "gr-org": {
            topicPolicy: { topics: [{ name: "Finance", type: "DENY", action: "BLOCKED", detected: true }] },
            appliedGuardrailDetails: enforced
          }
        }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), {
      input: "blocked",
      output: "none",
      policies: ["topicPolicy"]
    })
  })

  it("reads the output assessments of every chunk", () => {
    const trace = {
      guardrail: {
        outputAssessments: {
          "gr-1": [
            { wordPolicy: customWord("NONE") },
            { sensitiveInformationPolicy: regex("ANONYMIZED") },
            { wordPolicy: customWord("BLOCKED") }
          ]
        }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), {
      input: "none",
      output: "blocked",
      policies: ["sensitiveInformationPolicy", "wordPolicy"]
    })
  })

  it("lists a policy once when it acts on both sides", () => {
    const trace = {
      guardrail: {
        inputAssessment: { "gr-1": { wordPolicy: customWord("BLOCKED") } },
        outputAssessments: { "gr-1": [{ wordPolicy: customWord("BLOCKED") }] }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), {
      input: "blocked",
      output: "blocked",
      policies: ["wordPolicy"]
    })
  })

  it("counts NONE entries as nothing found", () => {
    const trace = {
      guardrail: {
        inputAssessment: { "gr-1": { wordPolicy: customWord("NONE"), sensitiveInformationPolicy: regex("NONE") } },
        outputAssessments: { "gr-1": [{ wordPolicy: customWord("NONE") }] }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), { input: "none", output: "none", policies: [] })
  })

  it("tells a trace in which nothing acted from no trace", () => {
    assert.deepStrictEqual(Guardrails.guardrailOutcome({ guardrail: {} }), {
      input: "none",
      output: "none",
      policies: []
    })
    assert.strictEqual(Guardrails.guardrailOutcome(undefined), null)
  })

  it("returns null for a trace without a guardrail member", () => {
    assert.strictEqual(Guardrails.guardrailOutcome({ promptRouter: { invokedModelId: "m" } }), null)
    assert.strictEqual(Guardrails.guardrailOutcome({ guardrail: "enabled" }), null)
    assert.strictEqual(Guardrails.guardrailOutcome(null), null)
  })

  it("reads a policy key that the Smithy model does not have today", () => {
    const trace = {
      guardrail: {
        inputAssessment: { "gr-1": { futurePolicy: { findings: [{ nested: { action: "BLOCKED" } }] } } }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), {
      input: "blocked",
      output: "none",
      policies: ["futurePolicy"]
    })
  })

  it("counts members of an unexpected type as nothing found", () => {
    const trace = {
      guardrail: {
        inputAssessment: ["gr-1"],
        outputAssessments: {
          "gr-1": { wordPolicy: customWord("BLOCKED") },
          "gr-2": [7, "BLOCKED", null, { wordPolicy: { customWords: [{ action: 1 }, { action: ["BLOCKED"] }] } }]
        }
      }
    }
    assert.deepStrictEqual(Guardrails.guardrailOutcome(trace), { input: "none", output: "none", policies: [] })
  })
})

describe("finishMetadata", () => {
  it("carries the stop reason, the outcome, and the trace", () => {
    assert.deepStrictEqual(Guardrails.finishMetadata("guardrail_intervened", inputBlockedTrace), {
      stopReason: "guardrail_intervened",
      guardrail: { input: "blocked", output: "none", policies: ["wordPolicy"] },
      trace: inputBlockedTrace
    })
  })

  it("gives null for a missing trace and a missing stop reason", () => {
    assert.deepStrictEqual(Guardrails.finishMetadata(null, undefined), {
      stopReason: null,
      guardrail: null,
      trace: null
    })
  })
})

describe("blocksObject", () => {
  it("blocks a guardrail response whose text is not JSON", () => {
    assert.strictEqual(Guardrails.blocksObject("guardrail_intervened", "BLOCKED_INPUT_MESSAGE"), true)
    assert.strictEqual(Guardrails.blocksObject("guardrail_intervened", ""), true)
  })

  it("lets a masked JSON object through", () => {
    assert.strictEqual(Guardrails.blocksObject("guardrail_intervened", "{\"ticket\":\"{TICKET}\"}"), false)
  })

  it("leaves text after any other stop reason to the decoder", () => {
    assert.strictEqual(Guardrails.blocksObject("end_turn", "not json"), false)
    assert.strictEqual(Guardrails.blocksObject("content_filtered", "not json"), false)
  })
})
