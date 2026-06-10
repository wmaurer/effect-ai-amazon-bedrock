import { AmazonBedrockEventStream, AmazonBedrockSchema } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { concat, encodeFrame, eventFrame, exceptionFrame, happyPathFrames } from "./utils.ts"

const textEncoder = new TextEncoder()

const decodeAll = (chunks: ReadonlyArray<Uint8Array>) =>
  Stream.fromIterable(chunks).pipe(
    Stream.pipeThroughChannel(
      AmazonBedrockEventStream.makeChannel(AmazonBedrockSchema.ConverseResponseStreamEvent)
    ),
    Stream.runCollect,
    Effect.map((chunk) => globalThis.Array.from(chunk))
  )

describe("AmazonBedrockEventStream", () => {
  it.effect("decodes a sequence of event frames", () =>
    Effect.gen(function*() {
      const events = yield* decodeAll(happyPathFrames)
      assert.deepStrictEqual(events.map((event) => event.type), [
        "messageStart",
        "contentBlockDelta",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata"
      ])
    }))

  it.effect("decodes frames split across arbitrary chunk boundaries", () =>
    Effect.gen(function*() {
      const all = concat(happyPathFrames)
      // Split at awkward boundaries: mid-prelude, mid-headers, mid-payload.
      const chunks = [all.subarray(0, 3), all.subarray(3, 17), all.subarray(17, 80), all.subarray(80)]
      const events = yield* decodeAll(chunks)
      assert.strictEqual(events.length, happyPathFrames.length)
      assert.strictEqual(events[events.length - 1]!.type, "metadata")
    }))

  it.effect("decodes multiple frames arriving in a single chunk", () =>
    Effect.gen(function*() {
      const events = yield* decodeAll([concat(happyPathFrames)])
      assert.strictEqual(events.length, happyPathFrames.length)
    }))

  it.effect("routes exception frames into the event union", () =>
    Effect.gen(function*() {
      const events = yield* decodeAll([
        eventFrame("messageStart", { role: "assistant" }),
        exceptionFrame("throttlingException", { message: "Too many requests" })
      ])
      const event = events[1]!
      assert.strictEqual(event.type, "throttlingException")
      if (event.type === "throttlingException") {
        assert.strictEqual(event.throttlingException.message, "Too many requests")
      }
    }))

  it.effect("fails loud on transport-level error frames", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(decodeAll([
        encodeFrame({
          ":message-type": "error",
          ":error-code": "InternalError",
          ":error-message": "Connection reset"
        }, undefined)
      ]))
      assert.instanceOf(error, AmazonBedrockEventStream.EventStreamError)
      if (error instanceof AmazonBedrockEventStream.EventStreamError) {
        assert.strictEqual(error.code, "InternalError")
        assert.strictEqual(error.message, "Connection reset")
      }
    }))

  it.effect("skips non-string header value types while staying aligned", () =>
    Effect.gen(function*() {
      // Hand-build a frame with a timestamp header (type 8) before the string
      // headers to verify the cursor advances correctly over non-string values.
      const stringHeaders = encodeFrame({
        ":message-type": "event",
        ":event-type": "messageStop"
      }, { stopReason: "end_turn" })
      const name = textEncoder.encode(":ts")
      const tsHeader = new Uint8Array(1 + name.length + 1 + 8)
      tsHeader[0] = name.length
      tsHeader.set(name, 1)
      tsHeader[1 + name.length] = 8 // timestamp type
      const oldView = new DataView(stringHeaders.buffer)
      const oldTotal = oldView.getUint32(0, false)
      const oldHeadersLen = oldView.getUint32(4, false)
      const frame = new Uint8Array(oldTotal + tsHeader.length)
      const view = new DataView(frame.buffer)
      frame.set(stringHeaders.subarray(0, 12), 0)
      frame.set(tsHeader, 12)
      frame.set(stringHeaders.subarray(12), 12 + tsHeader.length)
      view.setUint32(0, oldTotal + tsHeader.length, false)
      view.setUint32(4, oldHeadersLen + tsHeader.length, false)

      const events = yield* decodeAll([frame])
      assert.strictEqual(events[0]!.type, "messageStop")
    }))

  it.effect("tolerates non-text deltas (AWS models the delta as a union)", () =>
    Effect.gen(function*() {
      const events = yield* decodeAll([
        eventFrame("contentBlockDelta", {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "thinking..." } }
        })
      ])
      assert.strictEqual(events[0]!.type, "contentBlockDelta")
    }))

  it.effect("tolerates contentBlockStart frames", () =>
    Effect.gen(function*() {
      const events = yield* decodeAll([
        eventFrame("contentBlockStart", {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t1", name: "search" } }
        })
      ])
      assert.strictEqual(events[0]!.type, "contentBlockStart")
    }))

  it.effect("decodes every documented stopReason value", () =>
    Effect.gen(function*() {
      for (
        const stopReason of [
          "end_turn",
          "tool_use",
          "max_tokens",
          "stop_sequence",
          "guardrail_intervened",
          "content_filtered",
          "malformed_model_output",
          "malformed_tool_use",
          "model_context_window_exceeded"
        ]
      ) {
        const events = yield* decodeAll([eventFrame("messageStop", { stopReason })])
        assert.strictEqual(events[0]!.type, "messageStop")
      }
    }))
})
