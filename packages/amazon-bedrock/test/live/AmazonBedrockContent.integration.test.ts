/**
 * Live checks for the non-text content blocks: images, documents and citations.
 *
 * These are the blocks whose wire shape the unit tests can only assert against a fixture
 * this repo wrote itself. Converse rejects a malformed `image` or `document` block with a
 * `ValidationException`, so reaching a decoded answer at all is most of the evidence here;
 * the assertions on the answer's content are what prove the bytes arrived intact rather
 * than being accepted and ignored.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Response } from "effect/unstable/ai"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { liveDisabled, modelLayer } from "./helpers.ts"

const TIMEOUT = 120_000

/**
 * A 96x96 solid red PNG, inlined so the suite needs no fixture file and no image library.
 * Regenerate with `node -e` + `zlib.deflateSync` over raw RGB scanlines if it ever needs to
 * change; the only property any assertion depends on is that every pixel is red.
 */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAApElEQVR4nO3QMQ0AMAzAsIEof2QDMwZ7m8NSAEQ+d0afzvpBPECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQIEDhAAECBAhQOECAAAECFA4QIECAAIUDBAgQoM0eq0WSHWx5IugAAAAASUVORK5CYII="

/**
 * Invented facts, so a correct answer cannot come from the model's own knowledge — it has
 * to have read the document block.
 */
const DOCUMENT_TEXT = `Meridian Freight - Internal Operations Note

The Kestrel depot processed 4,812 pallets in March.
The Harrier depot processed 1,207 pallets in March.
Depot capacity is reviewed whenever a depot exceeds 4,000 pallets in a single month.
`

const toBase64 = (text: string) => globalThis.btoa(globalThis.String.fromCharCode(...new TextEncoder().encode(text)))

describe.skipIf(liveDisabled)("Amazon Bedrock content blocks (live)", { sequential: true }, () => {
  it.effect("sends an image block that the model can actually read", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("file", {
                mediaType: "image/png",
                fileName: "swatch.png",
                data: RED_PNG_BASE64
              }),
              Prompt.makePart("text", {
                text: "What single colour fills this image? Reply with one word."
              })
            ]
          })
        ])
      })

      // A block Converse accepted but could not decode would still produce an answer, just
      // not one that names the colour actually encoded in those bytes.
      assert.include(response.text.toLowerCase(), "red")
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("sends a document block and reads an invented fact back out of it", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("file", {
                mediaType: "text/plain",
                fileName: "operations-note.txt",
                data: toBase64(DOCUMENT_TEXT),
                options: {
                  amazonBedrock: {
                    // `context` is a document-level field this provider models; sending it
                    // proves Converse accepts it alongside the source rather than rejecting
                    // the block. It is not otherwise observable in the answer.
                    context: "A depot throughput note. The pallet counts are authoritative."
                  }
                }
              }),
              Prompt.makePart("text", {
                text: "How many pallets did the Kestrel depot process in March? Reply with the number only."
              })
            ]
          })
        ])
      })

      assert.include(response.text.replace(/,/g, ""), "4812")
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)

  it.effect("surfaces citations as source parts pointing back at the document", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("file", {
                mediaType: "text/plain",
                fileName: "operations-note.txt",
                data: toBase64(DOCUMENT_TEXT),
                options: { amazonBedrock: { citations: { enabled: true } } }
              }),
              Prompt.makePart("text", {
                text: "Which depots are named in this note, and how many pallets did each process?" +
                  " Cite the note."
              })
            ]
          })
        ])
      })

      // With citations enabled the answer text arrives inside `citationsContent` rather
      // than a plain `text` block, so an empty `response.text` would mean the provider
      // dropped the answer on the floor.
      assert.isAtLeast(response.text.length, 1, "the answer text should survive the citations block")

      const sources = response.content.filter((part) => part.type === "source")
      assert.isAtLeast(sources.length, 1, "expected at least one citation")

      for (const source of sources) {
        // Converse can only cite documents here — a `url` source would mean the provider
        // attributed the citation to something the request never sent.
        assert.strictEqual(source.sourceType, "document")
        if (source.sourceType !== "document") continue

        assert.strictEqual(source.mediaType, "text/plain")
        assert.strictEqual(source.fileName, "operations-note.txt")

        // The `documentIndex` Converse sends is resolved against the documents of the
        // request in send order; a wrong index would attribute the citation to the wrong
        // file, or drop it. Both are invisible without a real citation to resolve.
        //
        // The cast is the module augmentation: `ProviderMetadata` carries an index
        // signature, so the declared `amazonBedrock` shape widens to arbitrary JSON here.
        const metadata = source.metadata?.amazonBedrock as
          | NonNullable<Response.DocumentSourcePartMetadata["amazonBedrock"]>
          | undefined
        assert.isDefined(metadata, "the citation should carry Bedrock metadata")
        assert.include(
          ["documentChar", "documentPage", "documentChunk"],
          metadata!.location
        )
        assert.isAtLeast(metadata!.citedText.length, 1, "the cited span should carry its source text")
      }
    }).pipe(Effect.provide(modelLayer())), TIMEOUT)
})
