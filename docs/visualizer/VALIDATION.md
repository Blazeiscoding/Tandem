# Atlas validation

These checks validate the project atlas. Creating the atlas changes
documentation, generation/preview tools and root commands; it does not change application runtime source.

## Generator and embedded source

Six focused Node checks pass:

- Every tracked input except the generated page is indexed, with unrelated
  audit directories, ignored dependencies and build outputs excluded.
- Every embedded text file equals its complete current source, with normalized
  LF line endings. Sizes and SHA-256 values match actual file bytes. Binary
  assets retain metadata.
- Counts, declaration positions, import links, reverse references and the
  aggregate digest agree. All 176 app/package runtime files have reviewed
  explanations; all guide, flow and improvement file/evidence paths exist.
- Workspace subpath exports and literal dynamic imports resolve to their actual
  repository modules.
- The HTML contains one JSON snapshot and one executable atlas script. Source
  dollar tokens, template markers and closing-script text remain safely embedded
  and byte-correct; application source is never executed by the reader.
- A disposable Git fixture accepts identical source after capture metadata and
  HEAD/tracked status change, rejects changed source, and leaves stale output
  untouched. It does not mutate the real repository's HEAD or output.

`pnpm visualizer:check` passes against the final inputs. Node syntax checks,
Prettier on the changed supported files and `git diff --check` pass.

## Browser checks, 6 October 2026

The redesigned page was driven with Playwright in Chromium, from the file itself
with no server, at 1440 × 900 and at 390 × 844 as a touch phone, in both themes.

- axe-core reports no violations on Overview, Files (tree, explanation, source,
  declarations, connections), How it works, an expanded improvement and Scope &
  limits, in Onyx and in White. That includes colour contrast for text, chart
  labels and syntax colours.
- Search typed into the search dialog or the tree filter as HTML creates no
  elements and runs nothing.
- The search dialog opens with Ctrl K and closes with Escape. Arrow keys move
  through the tree and open folders.
- A line number puts that line's address in the URL and on the clipboard; go to
  line, find in file, Back to the previous tab and a file's link to its journey
  step all land where they say.
- The measured filter shows 12 records and the open filter 13. The Contract layer
  link lists its 14 files.
- The theme choice survives a reload.
- The page makes no network requests and logs no errors.
- No view is wider than a 390-pixel screen.

A screen reader and printed output were not tried.
