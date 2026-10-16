---
"@effect/ai-amazon-bedrock": minor
---

Add image and document support to the Amazon Bedrock provider.

- User `file` prompt parts are now converted into Converse `image` and `document` content blocks. They previously failed with `Unsupported user content part of type 'file' - this provider is text-only`.
- Converse takes a format enum rather than a media type, so only the media types it has a format for are accepted: `image/jpeg`, `image/png`, `image/gif`, `image/webp` (and `image/*`, resolved to jpeg) for images; pdf, csv, doc, docx, xls, xlsx, html, txt and md for documents. Any other media type still fails with `AiError.InvalidUserInputError`, naming the media type.
- File data given as a base64 string is passed through untouched and a `Uint8Array` is base64 encoded. A URL is sent as an S3 location; Converse accepts no other remote source, so a non-`s3://` url fails rather than being fetched.
- Document blocks require a name, which Bedrock restricts to alphanumerics, single runs of whitespace, hyphens, parentheses and square brackets. The file name is sanitized to that alphabet with its extension dropped, and an unnamed document is numbered within the request.
