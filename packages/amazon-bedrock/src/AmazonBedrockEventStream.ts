/**
 * The `AmazonBedrockEventStream` module decodes the AWS binary event-stream
 * framing used by the Bedrock `converse-stream` endpoint into typed events.
 *
 * **Wire format**
 *
 * Each frame is laid out as
 * `[totalLen u32be][headersLen u32be][preludeCrc u32][headers...][payload...][msgCrc u32]`.
 *
 * Headers are a sequence of `[nameLen u8][name][valueType u8][value...]` entries.
 * We only need the string headers (`:message-type`, `:event-type`,
 * `:content-type`), but must still advance correctly over non-string value
 * types. Event payloads are JSON, wrapped under their `:event-type` key to match
 * the Converse stream event schema.
 *
 * See the [AWS Documentation](https://docs.aws.amazon.com/lexv2/latest/dg/event-stream-encoding.html)
 * for more information.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import type * as Pull from "effect/Pull"
import * as Schema from "effect/Schema"

const textDecoder = new TextDecoder()

/**
 * Raised when the event stream carries a transport-level error frame
 * (`:message-type: error`). These frames have no JSON body; the error is
 * described by the `:error-code` and `:error-message` headers.
 *
 * @category errors
 * @since 4.0.0
 */
export class EventStreamError extends Schema.TaggedError<EventStreamError>(
  "@effect/ai-amazon-bedrock/AmazonBedrockEventStream/EventStreamError"
)("EventStreamError", {
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
}) {}

interface DecodedFrame {
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

/**
 * Parses a single AWS event-stream frame.
 *
 * Returns only string-typed headers (other header value types are skipped while
 * still advancing the cursor) and the raw payload bytes. CRC validation is
 * skipped.
 *
 * @internal
 */
const decodeFrame = (frame: Uint8Array): DecodedFrame => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const totalLength = view.getUint32(0, false)
  const headersLength = view.getUint32(4, false)

  const headersStart = 12
  const headersEnd = headersStart + headersLength
  const payloadEnd = totalLength - 4

  const headers: Record<string, string> = {}
  let offset = headersStart
  while (offset < headersEnd) {
    const nameLength = view.getUint8(offset)
    offset += 1
    const name = textDecoder.decode(frame.subarray(offset, offset + nameLength))
    offset += nameLength
    const valueType = view.getUint8(offset)
    offset += 1
    switch (valueType) {
      // bool true / bool false — no value bytes
      case 0:
      case 1: {
        break
      }
      // byte
      case 2: {
        offset += 1
        break
      }
      // short
      case 3: {
        offset += 2
        break
      }
      // integer
      case 4: {
        offset += 4
        break
      }
      // long
      case 5: {
        offset += 8
        break
      }
      // byte array
      case 6: {
        const valueLength = view.getUint16(offset, false)
        offset += 2 + valueLength
        break
      }
      // string
      case 7: {
        const valueLength = view.getUint16(offset, false)
        offset += 2
        headers[name] = textDecoder.decode(frame.subarray(offset, offset + valueLength))
        offset += valueLength
        break
      }
      // timestamp
      case 8: {
        offset += 8
        break
      }
      // uuid
      case 9: {
        offset += 16
        break
      }
    }
  }

  return { headers, body: frame.subarray(headersEnd, payloadEnd) }
}

/**
 * Builds a channel that decodes AWS event-stream frames into values of the
 * provided schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeChannel = <A, I, RD, IE, Done>(
  schema: Schema.Codec<A, I, RD>
): Channel.Channel<
  NonEmptyReadonlyArray<A>,
  IE | Schema.SchemaError | EventStreamError,
  Done,
  NonEmptyReadonlyArray<Uint8Array>,
  IE,
  Done,
  RD
> =>
  Channel.fromTransform((upstream: Pull.Pull<NonEmptyReadonlyArray<Uint8Array>, IE, Done>, _scope) =>
    Effect.gen(function*() {
      const context = yield* Effect.context<RD>()
      const decodeMessage = Schema.decodeUnknownEffect(schema)

      let buffer = new Uint8Array(0)
      let out: Array<A> = []

      const pump = Effect.flatMap(
        upstream,
        (arrays) =>
          Effect.gen(function*() {
            for (const chunk of arrays) {
              const next = new Uint8Array(buffer.length + chunk.length)
              next.set(buffer)
              next.set(chunk, buffer.length)
              buffer = next

              while (buffer.length >= 4) {
                const totalLength = new DataView(
                  buffer.buffer,
                  buffer.byteOffset,
                  buffer.byteLength
                ).getUint32(0, false)

                if (buffer.length < totalLength) {
                  break
                }

                const frame = buffer.subarray(0, totalLength)
                buffer = buffer.slice(totalLength)

                const { body, headers } = decodeFrame(frame)
                // Normal events carry their member name in `:event-type`; AWS
                // serializes `@error`-trait members (throttling/validation/model
                // stream errors) as `:message-type: exception` with the name in
                // `:exception-type`. Both route into the same union, so the LM's
                // exception cases (-> { type: "error" }) fire instead of the
                // stream silently truncating.
                const messageType = headers[":message-type"]
                if (messageType === "event" || messageType === "exception") {
                  const memberName = messageType === "exception"
                    ? headers[":exception-type"]
                    : headers[":event-type"]
                  if (memberName !== undefined) {
                    const message = yield* decodeMessage({
                      [memberName]: JSON.parse(textDecoder.decode(body))
                    }).pipe(Effect.provide(context))
                    out.push(message)
                  }
                } else if (messageType === "error") {
                  // Transport-level error frame (no JSON body): the error is
                  // carried in the `:error-code` / `:error-message` headers.
                  // Fail loud rather than silently ending the stream.
                  return yield* new EventStreamError({
                    code: headers[":error-code"],
                    message: headers[":error-message"]
                  })
                }
              }
            }
          })
      )

      return Effect.suspend(
        function loop(): Pull.Pull<NonEmptyReadonlyArray<A>, IE | Schema.SchemaError | EventStreamError, Done> {
          if (Arr.isArrayNonEmpty(out)) {
            const result = out
            out = []
            return Effect.succeed(result)
          }
          return Effect.flatMap(pump, loop)
        }
      )
    })
  )
