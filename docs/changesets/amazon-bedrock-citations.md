---
"@effect/ai-amazon-bedrock": minor
---

Add document citations to the Amazon Bedrock provider.

- Opt a document into citations through the `amazonBedrock` provider options of a file part: `options: { amazonBedrock: { citations: { enabled: true } } }`. This sets `citations` on the Converse `document` block.
- Model the `citationsContent` response block and the `citation` stream delta, which previously decoded with every field undefined and were ignored. Both are now surfaced as `Response.DocumentSourcePart`s.
- Once a document has citations enabled, Converse returns the answer text inside `citationsContent` rather than as plain `text` blocks, so that text is emitted as well — without this, an answer with citations enabled came back empty on the non-streaming path.
- Each source part carries `amazonBedrock` metadata with the cited span: the `location` unit (`documentChar`, `documentPage` or `documentChunk`), the `citedText` reported for it, its `start` / `end`, and the originating `source`.
- Citation locations index the documents of the request, so the documents are tracked in order while encoding the prompt and used to resolve the cited document's media type, name and file name. A citation that indexes outside them, or that carries a `web` / `searchResultLocation` (which accompany search results this provider cannot send), is dropped rather than attributed to the wrong document.
