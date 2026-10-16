---
"@effect/ai-amazon-bedrock": minor
---

Send cited text documents to the Amazon Bedrock Converse API as `source.text`.

`DocumentSource` now models the union's `text` member alongside `bytes` and `s3Location`. A file
part whose media type starts with `text/` — `text/plain`, `text/markdown`, `text/csv`, `text/html` —
is sent as a plain string rather than base64 when the part opts into citations. Base64 inflates a
payload by about a third, so this is a meaningfully smaller request for the documents that take it.

Converse accepts a `text` source only alongside a citations config, and rejects an uncited one with
"DocumentSource object … must set one of the following keys: bytes, s3Location", so an uncited text
document is still sent as `bytes`. The Smithy model does not express this restriction — it lists
`text` as an unconditional member of the union.

Binary formats such as pdf, Word and Excel always go as `bytes`, and an `s3://` url still becomes an
`s3Location` reference. Because `Prompt.FilePart` string data is base64, the cited path decodes it
rather than forwarding it: data that is not valid base64 fails with `AiError.InvalidUserInputError`
naming the document, instead of drawing an opaque 400 from Bedrock.
