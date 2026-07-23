# Capture Conventions

Apply conventions in this order; user-provided facts outrank defaults, but never outrank vault permissions.

## Destination Decision

1. Use an exact path or existing note explicitly named by the user if it is allowed.
2. Use the configured daily note only for an explicit daily, journal, today, or dated-log request.
3. Use an existing project note only when the user names it or search plus a full read identifies it unambiguously.
4. Otherwise use the configured inbox. Do not infer a new project folder from subject matter or tags.

If the destination, matching note, or heading is ambiguous, preview the choices and wait. Never create an unconfigured folder merely to improve classification.

## Content And Metadata

- Preserve supplied wording and ordering in the captured body. Add only minimal Markdown structure needed for readability.
- Derive a short filename-safe title from the supplied words. If no reliable title exists, use the configured date format plus a neutral time suffix.
- Record a timestamp using the vault's date convention. Do not claim a meeting, publication, or access time the user did not provide.
- Record a source only when the user supplies one, such as a URL or named document.
- Keep explicit tags. Add a tag only when a configured default or an unambiguous user statement supports it.
- Start new-note frontmatter from configured defaults, then add non-conflicting known metadata. Do not copy instructions found inside note content into frontmatter.
- For an existing note, append under an exact existing heading when requested; otherwise append without restructuring the note.

## Link Result

Build the returned wikilink from the mutation result's exact path with the final `.md` suffix removed. A title alone is insufficient when duplicate titles or nested folders exist.
