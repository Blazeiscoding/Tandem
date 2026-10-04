# Tandem project atlas

Open [PROJECT-VISUALIZER.html](../PROJECT-VISUALIZER.html) in a browser. It is one
offline HTML file containing the inventory, reviewed runtime explanations,
complete text source, declaration/import indexes, guided flows and improvement
evidence. No server, CDN, login or application data is needed.

For a browser preview through a local server:

```sh
pnpm visualizer:build
pnpm visualizer:serve
```

Open `http://127.0.0.1:4178`. `VISUALIZER_PORT` changes the loopback port. The server
serves only the generated page and does not expose arbitrary repository files.

Use **File explorer** to search file paths and explanations. Enable **Search source**
to search the embedded code as well. Filter by area and file kind; select a file
to inspect its explanation, source, symbols, named tests and dependency links.
Source is paged in 240-line sections; line links and the jump control go directly
to a declaration. Navigation and selection are encoded in the URL hash, so
browser Back and Forward and copied deep links work. Press `/` to focus file
search. On narrow screens the explorer and reader stack vertically.

**How it works** follows real code paths. **Improvements** distinguishes
implemented changes, measured historical effects and open follow-ups. Each
claim links to embedded reports or original evidence. **Evidence & limits**
explains validation scope, measurement limits and index coverage.

## Maintaining the atlas

The generator reads `git ls-files` plus its explicitly owned atlas inputs. It
never scans ignored builds, dependencies, user data or unrelated untracked
directories. The generated output excludes itself to avoid recursive embedding.
Binary files retain size/hash metadata; text files are embedded in full.

The reviewed runtime narratives live in `content/client.json`, `server.json` and
`desktop.json`. `content/optimizations.json` records before/after behavior,
mechanisms, evidence and limits. `content/guide.json` provides the architecture,
reading guide and scope. Update these alongside a changed runtime file. Keep
unimplemented findings marked `follow-up`; do not turn a plan or diagnostic into
a completed optimization.

```sh
pnpm exec prettier --write scripts/generate-project-visualizer.mjs scripts/serve-project-visualizer.mjs docs/visualizer
pnpm visualizer:build
pnpm visualizer:check
pnpm visualizer:test
```

The generator requires a reviewed entry for every `apps/*/src` and
`packages/*/src` runtime file, validates referenced paths and unique guide IDs,
and uses TypeScript's parser to extract declarations and literal imports.
Remaining file descriptions use structural metadata. Imports are a source
dependency map, not a dynamic call graph or proof of test execution.

`--check` compares the deterministic output to current inputs while preserving
the capture's base revision, date and tracked count, so committing the generated
file does not make identical inputs stale. The page shows the
checkout's base commit and an aggregate input SHA-256. It does not claim that
local modifications belong to the base commit. Runtime inputs are always the
actual current files, not an older commit's source. The page embeds source as
escaped JSON and renders text safely; it never executes embedded application
code. The generated HTML is intentionally excluded from Prettier because its
embedded source and data are deterministic generator output.

The [atlas validation record](VALIDATION.md) covers its generator and browser
interactions. It is separate from the application's historical validation.
