# Amazon Bedrock `DocumentSource.text` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send `text/*` documents to the Bedrock Converse API as `source.text` instead of base64 `source.bytes`.

**Architecture:** Add a `DocumentSource` schema struct that extends the existing `MediaSource` (`bytes | s3Location`) with an optional `text` member, and point `DocumentBlock.source` at it. In the prompt converter, add a `documentSource` resolver that delegates to the existing `fileSource` and then upgrades an inline `bytes` result to `text` when the media type starts with `text/`. Image parts keep using `fileSource` untouched.

**Tech Stack:** TypeScript, Effect v4 (`effect/Schema`, `effect/Encoding`, `effect/Result`, `effect/Predicate`), `@effect/vitest`, pnpm, changesets.

## Global Constraints

- Package under change: `packages/ai/amazon-bedrock` (`@effect/ai-amazon-bedrock`).
- `MediaSource` in `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts` is NOT modified — it stays `bytes | s3Location` for `ImageBlock` and the future `VideoBlock`.
- `content` is NOT implemented. `DocumentSource` has exactly three members: `bytes`, `s3Location`, `text`.
- The routing rule is `part.mediaType.startsWith("text/")`. Do not add a second lookup table of textual media types.
- `fileSource` (`AmazonBedrockLanguageModel.ts:644`) is NOT modified; URL handling and its `InvalidUserInputError` for non-`s3:` URLs stay there and are not duplicated.
- Base64 decode failure raises `AiError.InvalidUserInputError` from `prepareMessages` naming the document and its media type — never silently drops content.
- Run every command from the worktree root: `/home/mrwe1@office.begasoft.ch/projects/effect-ts/effect/.worktrees/feat-ai-amazon-bedrock`.
- Test command for this package: `pnpm vitest run --project @effect/ai-amazon-bedrock`. Single file: append the test file path. Single test: append `-t "<test name>"`.
- Typecheck command: `pnpm --filter @effect/ai-amazon-bedrock check`.
- Repo lint/format gate before each commit: `pnpm lint --fix` (dprint + eslint).

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts` | Converse wire schemas | Add `DocumentSource`; `DocumentBlock.source` uses it |
| `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts` | Schema encode/decode tests | Add a `DocumentSource` round-trip test |
| `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` | Prompt → Converse conversion | Add `documentSource` resolver; call it from the document branch of `prepareMessages` |
| `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts` | Request-body assertions | Add five routing/error tests |
| `TODO.md` | Deferred-work log | Rewrite the entry as `DocumentSource.content` |
| `.changeset/amazon-bedrock-document-text.md` | Release note | Create |

---

### Task 1: Schema — `DocumentSource`

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts` (after `MediaSource`, around line 181; and `DocumentBlock` at line 218-224)
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`

**Interfaces:**
- Consumes: `MediaSource` (existing, `Schema.Struct` with `bytes: Schema.optional(Schema.String)` and `s3Location: Schema.optional(S3Location)`).
- Produces: `export const DocumentSource` — a `Schema.Struct` with fields `bytes`, `s3Location`, `text`, all optional. Task 2 refers to its encoded type as `typeof DocumentSource.Encoded`, which is `{ bytes?: string; s3Location?: { uri: string; bucketOwner?: string }; text?: string }`. Exported from the package as `AmazonBedrockSchema.DocumentSource`.

- [ ] **Step 1: Write the failing test**

Append this test inside the top-level `describe("AmazonBedrockSchema", ...)` block in `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`, next to the other encode tests:

```ts
  it.effect("round-trips a document block carrying a text source", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.DocumentBlock)(
        new AmazonBedrockSchema.DocumentBlock({
          format: "txt",
          name: "notes",
          source: { text: "hello world" }
        })
      )
      assert.deepStrictEqual(encoded.source, { text: "hello world" })

      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.DocumentBlock)(encoded)
      assert.strictEqual(decoded.source.text, "hello world")
      assert.isUndefined(decoded.source.bytes)
    }))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts -t "round-trips a document block carrying a text source"`

Expected: FAIL — `MediaSource` has no `text` field, so encoding rejects the `{ text: "hello world" }` source (a schema/type error mentioning `text`).

- [ ] **Step 3: Add the `DocumentSource` schema**

In `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts`, insert this immediately after the `MediaSource` declaration (which ends at line 181 with `})`), before the `ImageBlock` doc comment:

```ts
/**
 * The source of a document content block.
 *
 * **Details**
 *
 * `DocumentSource` is a Smithy union, so every member is optional here. It
 * adds `text` to the `bytes` / `s3Location` pair `MediaSource` carries: a
 * textual document travels as a plain string rather than base64, which is
 * about a quarter smaller on the wire. The union's fourth member, `content`,
 * is not modelled.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DocumentSource = Schema.Struct({
  ...MediaSource.fields,
  text: Schema.optional(Schema.String)
})
```

- [ ] **Step 4: Point `DocumentBlock.source` at it**

In the same file, in the `DocumentBlock` class (around line 218), change the `source` field:

```ts
export class DocumentBlock extends Schema.Class<DocumentBlock>(makeIdentifier("DocumentBlock"))({
  format: Schema.Literals(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]),
  name: Schema.String,
  source: DocumentSource,
  citations: Schema.optional(CitationsConfig)
}) {}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`

Expected: PASS, all tests in the file green.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @effect/ai-amazon-bedrock check`

Expected: no errors. `MediaSource.Encoded` is assignable to `DocumentSource.Encoded`, so the existing `fileSource` call in `AmazonBedrockLanguageModel.ts` still typechecks against the widened `source`.

- [ ] **Step 7: Lint and commit**

```bash
pnpm lint --fix
git add packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts
git commit -m "feat(amazon-bedrock): model DocumentSource.text"
```

---

### Task 2: Conversion — route `text/*` documents through `source.text`

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` (imports near line 21-28; new resolver after `fileSource`, which ends at line 660; document branch of `prepareMessages` at lines 736-750)
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`

**Interfaces:**
- Consumes: `DocumentSource` from Task 1 (`./AmazonBedrockSchema.ts`); the existing `fileSource(data): Effect.Effect<typeof MediaSource.Encoded, AiError.AiError>`; the existing `documentName(fileName, position): string`.
- Produces: `documentSource(mediaType: string, name: string, data: typeof Prompt.FilePart.Type["data"]): Effect.Effect<typeof DocumentSource.Encoded, AiError.AiError>` — module-private, no later task depends on it.

**Context the tests need:** the test file already has a `captureUserContent(parts)` helper that runs `generateText` against a mocked HTTP handler and returns `body.messages[0].content` — the serialized Converse content blocks. Use it exactly as the existing image/document tests do. `Prompt.makePart("file", { mediaType, data, fileName? })` builds a file part; string `data` is base64 per the `Prompt.FilePart` contract.

- [ ] **Step 1: Write the failing tests**

In `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`, insert these five tests immediately after the existing `it.effect("generates a document name when the file part has none", ...)` test (which ends around line 707), before `it.effect("encodes an s3 file url as an s3Location source", ...)`:

```ts
    it.effect("sends a text document as a text source", () =>
      Effect.gen(function*() {
        // "aGVsbG8gd29ybGQ=" is base64 for "hello world"; string file part data
        // is base64 per the `Prompt.FilePart` contract.
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/plain",
            fileName: "notes.txt",
            data: "aGVsbG8gd29ybGQ="
          })
        ])

        assert.deepStrictEqual(content, [{
          document: { format: "txt", name: "notes", source: { text: "hello world" } }
        }])
      }))

    it.effect("decodes Uint8Array data for a text document as utf-8", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "text/markdown",
            fileName: "readme.md",
            data: new TextEncoder().encode("# Title")
          })
        ])

        assert.deepStrictEqual(content, [{
          document: { format: "md", name: "readme", source: { text: "# Title" } }
        }])
      }))

    it.effect("keeps a binary document as a bytes source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "application/pdf", data: new Uint8Array([1, 2, 3]) })
        ])

        assert.deepStrictEqual(content[0].document.source, { bytes: "AQID" })
      }))

    it.effect("keeps an s3 text document as an s3Location source", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", { mediaType: "text/csv", data: new URL("s3://bucket/rows.csv") })
        ])

        assert.deepStrictEqual(content[0].document.source, {
          s3Location: { uri: "s3://bucket/rows.csv" }
        })
      }))

    it.effect("fails on text document data that is not base64", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          captureUserContent([
            Prompt.makePart("file", { mediaType: "text/plain", fileName: "notes.txt", data: "not base64!!" })
          ])
        )

        assert.strictEqual((error as any).reason._tag, "InvalidUserInputError")
        assert.include((error as any).message, "notes")
        assert.include((error as any).message, "text/plain")
      }))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`

Expected: the three new `text`-source tests FAIL (the source comes back as `{ bytes: "aGVsbG8gd29ybGQ=" }` etc.), and "fails on text document data that is not base64" FAILS because no error is raised — `Effect.flip` reports the effect succeeded. The two "keeps ..." tests already PASS; that is expected, they are regression guards for behaviour the change must not alter.

- [ ] **Step 3: Add the `Result` import**

In `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts`, the imports are alphabetically ordered. Add, after the `import * as Predicate from "effect/Predicate"` line:

```ts
import * as Result from "effect/Result"
```

`Encoding` and `Predicate` are already imported; no other import changes are needed.

- [ ] **Step 4: Import the `DocumentSource` schema**

The schema module is imported as `import type { ... } from "./AmazonBedrockSchema.ts"` at lines 41-57 — a type-only import, which is all `typeof DocumentSource.Encoded` needs, exactly as the existing `typeof MediaSource.Encoded` uses. Add `DocumentSource` to that list, keeping it alphabetically sorted — immediately after `DocumentBlock` on line 49:

```ts
  DocumentBlock,
  DocumentSource,
  ImageBlock,
```

- [ ] **Step 5: Write the `documentSource` resolver**

In the same file, insert this immediately after the `fileSource` declaration (which ends at line 660 with `})`), before the `documentName` doc comment:

```ts
/**
 * Resolves file part data into a Converse document source.
 *
 * **Details**
 *
 * A textual document travels as `text` rather than base64 `bytes`: base64
 * inflates the payload by about a third, and Converse accepts the plain
 * string. That applies only to inline data - an s3 location stays a reference,
 * and a binary format like pdf stays base64. `Prompt.FilePart` string data is
 * base64, so it is decoded rather than forwarded; invalid base64 fails here
 * instead of drawing an opaque 400 from Bedrock.
 */
const documentSource: (
  mediaType: string,
  name: string,
  data: typeof Prompt.FilePart.Type["data"]
) => Effect.Effect<typeof DocumentSource.Encoded, AiError.AiError> = Effect.fnUntraced(
  function*(mediaType, name, data) {
    const source = yield* fileSource(data)
    // `bytes` is undefined for an s3 location, which stays a reference.
    if (!mediaType.startsWith("text/") || Predicate.isUndefined(source.bytes)) {
      return source
    }
    if (typeof data !== "string") {
      return { text: new TextDecoder().decode(data) }
    }
    const decoded = Encoding.decodeBase64String(data)
    if (Result.isFailure(decoded)) {
      return yield* AiError.make({
        module: "AmazonBedrockLanguageModel",
        method: "prepareMessages",
        reason: new AiError.InvalidUserInputError({
          description:
            `Invalid base64 data for document '${name}' of media type '${mediaType}' - string file part data must be base64`
        })
      })
    }
    return { text: decoded.success }
  }
)
```

Note on the `typeof data !== "string"` branch: `fileSource` returns `bytes` only for inline data, and inline data is either a base64 `string` or a `Uint8Array`. The `Uint8Array` branch decodes the original bytes directly rather than round-tripping through the base64 `fileSource` just produced.

- [ ] **Step 6: Call it from the document branch**

In `prepareMessages`, the document branch currently reads (around lines 736-750):

```ts
                    const documentFormat = documentFormats[part.mediaType]
                    if (Predicate.isNotUndefined(documentFormat)) {
                      const name = documentName(part.fileName, documents.length + 1)
                      const citations = part.options.amazonBedrock?.citations
                      documents.push({ name, mediaType: part.mediaType, fileName: part.fileName })
                      content.push({
                        document: {
                          format: documentFormat,
                          name,
                          source: yield* fileSource(part.data),
                          ...(Predicate.isNullish(citations) ? {} : { citations })
                        }
                      })
```

Change the one `source:` line to:

```ts
                          source: yield* documentSource(part.mediaType, name, part.data),
```

Leave the image branch above it calling `fileSource` unchanged.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`

Expected: PASS, every test in the file green — including the pre-existing "generates a document name when the file part has none" test, which sends `text/plain` and `text/csv` parts but asserts only on `name` and `format`.

- [ ] **Step 8: Run the full package suite and typecheck**

```bash
pnpm vitest run --project @effect/ai-amazon-bedrock
pnpm --filter @effect/ai-amazon-bedrock check
```

Expected: all tests pass, no type errors.

- [ ] **Step 9: Lint and commit**

```bash
pnpm lint --fix
git add packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts
git commit -m "feat(amazon-bedrock): send text documents as source.text"
```

---

### Task 3: Documentation — TODO entry and changeset

**Files:**
- Modify: `TODO.md` (the `## \`DocumentSource.text\` and \`.content\`` section, lines 15-19)
- Create: `.changeset/amazon-bedrock-document-text.md`

**Interfaces:**
- Consumes: nothing. This task is prose only and touches no source file.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Rewrite the TODO entry**

Replace lines 15-19 of `TODO.md` — the whole section that currently reads:

```markdown
## `DocumentSource.text` and `.content`

Only `bytes` and `s3Location` are modelled. Converse also accepts a document as plain `text`, or as
structured `content` blocks. Sending a text document as text rather than base64 bytes avoids a
pointless encode round-trip; the vercel-ai provider does exactly that for text media types.
```

with:

```markdown
## `DocumentSource.content`

`bytes`, `s3Location` and `text` are modelled; `content` is not. It carries a document as a list of
pre-chunked `{ text }` blocks, and it is what makes chunk-granular citations meaningful:
`DocumentChunkLocation.start` and `.end` are chunk indices, so a `documentChunk` citation has
nothing to index into unless the request supplied chunks. `Prompt.FilePart` carries a single `data`
and cannot express "this document is these five sections", so modelling it means a new
`amazonBedrock` file-part option carrying document payload rather than configuration — the first
option in this repo to do so. That is the decision to make before implementing it.
```

- [ ] **Step 2: Verify the surrounding sections are intact**

Run: `sed -n '1,30p' TODO.md`

Expected: the `## Video blocks` section above and the `## \`ImageBlock.error\`` section below are unchanged, and the rewritten section sits between them.

- [ ] **Step 3: Write the changeset**

Create `.changeset/amazon-bedrock-document-text.md`:

```markdown
---
"@effect/ai-amazon-bedrock": minor
---

Send text documents to the Amazon Bedrock Converse API as `source.text`.

`DocumentSource` now models the union's `text` member alongside `bytes` and `s3Location`, and a file
part whose media type starts with `text/` — `text/plain`, `text/markdown`, `text/csv`, `text/html` —
is sent as a plain string rather than base64. Base64 inflates a payload by about a third, so this is
a meaningfully smaller request for text documents. Binary formats such as pdf, Word and Excel still
go as `bytes`, and an `s3://` url still becomes an `s3Location` reference. Because `Prompt.FilePart`
string data is base64, it is now decoded rather than forwarded: data that is not valid base64 fails
with `AiError.InvalidUserInputError` naming the document, instead of drawing an opaque 400 from
Bedrock.
```

- [ ] **Step 4: Lint and commit**

```bash
pnpm lint --fix
git add TODO.md .changeset/amazon-bedrock-document-text.md
git commit -m "docs(amazon-bedrock): record DocumentSource.text and scope content"
```

Note: `TODO.md` is untracked at the repo root today. If `git add TODO.md` reports it is ignored, leave it untracked and commit only the changeset — the rewrite still stands on disk.

---

## Verification

After Task 3, from the worktree root:

```bash
pnpm vitest run --project @effect/ai-amazon-bedrock
pnpm --filter @effect/ai-amazon-bedrock check
pnpm lint
```

All three must be clean before the branch is finished.
