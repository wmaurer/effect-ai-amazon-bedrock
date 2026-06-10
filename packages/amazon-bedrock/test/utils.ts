const textEncoder = new TextEncoder()

/** Encodes a single AWS event-stream frame with string-typed headers. */
export const encodeFrame = (headers: Record<string, string>, payload: unknown): Uint8Array => {
  const headerChunks: Array<Uint8Array> = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = textEncoder.encode(name)
    const valueBytes = textEncoder.encode(value)
    const chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    const view = new DataView(chunk.buffer)
    let offset = 0
    view.setUint8(offset, nameBytes.length)
    offset += 1
    chunk.set(nameBytes, offset)
    offset += nameBytes.length
    view.setUint8(offset, 7) // string value type
    offset += 1
    view.setUint16(offset, valueBytes.length, false)
    offset += 2
    chunk.set(valueBytes, offset)
    headerChunks.push(chunk)
  }
  const headersLength = headerChunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const payloadBytes = payload === undefined ? new Uint8Array(0) : textEncoder.encode(JSON.stringify(payload))
  const totalLength = 12 + headersLength + payloadBytes.length + 4

  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, 0, false) // prelude CRC (skipped by the decoder)
  let offset = 12
  for (const chunk of headerChunks) {
    frame.set(chunk, offset)
    offset += chunk.length
  }
  frame.set(payloadBytes, offset)
  // trailing message CRC left as zeroes (skipped by the decoder)
  return frame
}

export const eventFrame = (eventType: string, payload: unknown): Uint8Array =>
  encodeFrame({
    ":message-type": "event",
    ":event-type": eventType,
    ":content-type": "application/json"
  }, payload)

export const exceptionFrame = (exceptionType: string, payload: unknown): Uint8Array =>
  encodeFrame({
    ":message-type": "exception",
    ":exception-type": exceptionType,
    ":content-type": "application/json"
  }, payload)

export const concat = (frames: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = frames.reduce((acc, frame) => acc + frame.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

export const happyPathFrames: ReadonlyArray<Uint8Array> = [
  eventFrame("messageStart", { role: "assistant" }),
  eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
  eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: ", world" } }),
  eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
  eventFrame("messageStop", { stopReason: "end_turn" }),
  eventFrame("metadata", {
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 123 }
  })
]
