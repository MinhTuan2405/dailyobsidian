# Production Asset Placeholders

No binary brand or screenshot asset is committed for Phase 8. `assets/manifest.json` records each required file as `placeholder`; the release verifier confirms a placeholder path does not contain a fake binary. Public release is blocked until an owner supplies approved originals, verifies rights, changes each status to `ready`, and reruns `pnpm verify:release`.

Do not create a solid-color, generated text, stock, or AI-generated stand-in just to satisfy packaging. Do not use real vault names, note content, account IDs, device IDs, URLs containing credentials, pairing codes, tokens, email addresses, or other personal data in screenshots.

## Global Production Requirements

- PNG files must use standard 8-bit-per-channel sRGB and contain no embedded private metadata, author paths, thumbnails, comments, GPS, or editing history.
- Preserve an editable owner-approved source outside packaged runtime assets. Record source, creator, rights/license, approver, and approval date in the release issue.
- Use the exact pixel dimensions and maximum encoded size in `assets/manifest.json`; no upscaled raster source.
- Verify at 100% and high-DPI display, light and dark surrounding UI, Windows/macOS, and color-vision/contrast checks.
- Keep essential marks/text inside the specified safe area. Avoid text below readable size.
- Run image metadata stripping and malware scanning through the owner-approved release process.
- Supply alt text/captions in marketplace/release metadata; do not bake explanatory paragraphs into images.

## Required Files

### `assets/icon.png`

- Purpose: square Workbench product/plugin icon for listings and release pages.
- Exact canvas: 128 x 128 pixels.
- Format: transparent PNG, RGBA, sRGB.
- Maximum size: 204,800 bytes (200 KiB).
- Safe area: all essential artwork within the centered 104 x 104 pixels (12-pixel inset each edge).
- Appearance: recognizable at 32 x 32 pixels; no small text, screenshot detail, drop shadow clipped at edges, or Obsidian trademark imitation.
- To-do: owner approves symbol, trademark clearance, light/dark previews, source file, and export.

### `assets/logo.png`

- Purpose: horizontal Workbench wordmark/hero on release documentation.
- Exact canvas: 1200 x 300 pixels.
- Format: transparent PNG, RGBA, sRGB.
- Maximum size: 512,000 bytes (500 KiB).
- Safe area: 48 pixels on all sides; mark and wordmark vertically centered.
- Appearance: readable on light and dark checkerboard previews; no tagline or unapproved legal claim.
- To-do: owner approves naming/typography, trademark clearance, source file, and export.

### `assets/screenshots/vault-selector.png`

- Purpose: desktop overview showing active vault, connection state, roots/scopes, and navigation.
- Exact canvas: 1600 x 1000 pixels.
- Format: opaque PNG, RGB/RGBA, sRGB.
- Maximum size: 1,536,000 bytes (1.5 MB).
- Content: synthetic disposable vault, online/read-only state, no browser/OS chrome unless listing guidelines require it.
- To-do: capture final production build in a compatible MCP Apps host, review every visible string, provide alt text.

### `assets/screenshots/diff-confirmation.png`

- Purpose: demonstrate dry-run unified diff, exact vault/path, revision/risk summary, and explicit Apply/Edit/Cancel controls.
- Exact canvas: 1600 x 1000 pixels.
- Format: opaque PNG, RGB/RGBA, sRGB.
- Maximum size: 1,536,000 bytes (1.5 MB).
- Content: synthetic non-sensitive note; show a confirmation-required mutation without a token or account data.
- To-do: capture final production build, verify additions/deletions and buttons are legible, provide alt text.

### `assets/screenshots/mobile-companion.png`

- Purpose: document companion settings/status on a narrow/mobile layout and substantiate the manifest's non-desktop-only claim.
- Exact canvas: 900 x 1600 pixels.
- Format: opaque PNG, RGB/RGBA, sRGB.
- Maximum size: 1,536,000 bytes (1.5 MB).
- Content: synthetic gateway hostname such as `wss://gateway.example.invalid/v1/gateway`; token fields must not be visible; show minimum scopes and no pairing code.
- To-do: validate the plugin on an actually supported mobile Obsidian build before capture; otherwise change platform claims instead of fabricating the screenshot.

## Approval and State Transition

For each asset:

1. Resolve product name, legal entity, trademark, and distribution rights.
2. Create against the final build using only synthetic data.
3. Export to the exact path/specification and strip metadata.
4. Review accessibility, confidentiality, UI accuracy, and platform/listing rules.
5. Record SHA-256 and approvals in the release issue.
6. Change only that entry's `status` from `placeholder` to `ready` in `assets/manifest.json`.
7. When all entries are ready, change top-level status to `ready` and run `pnpm verify:release`.

The verifier checks PNG signature, IHDR dimensions, size cap, manifest version/status, and placeholder absence. It does not replace visual, rights, privacy, accessibility, or legal review.
