# Atlas validation — 4 October 2026

These checks validate the project atlas. The application's N01–N12 validation
record remains [the implementation evidence](../IMPLEMENTATION-2026-10-04.md).
Creating the atlas changes documentation, generation/preview tools and root
commands; it does not change application runtime source.

## Generator and embedded source

Six focused Node checks pass:

- Every tracked input except the generated page is indexed, with unrelated
  audit directories, ignored dependencies and build outputs excluded.
- Every embedded text file equals its complete current source, with normalized
  LF line endings. Sizes and SHA-256 values match actual file bytes. Binary
  assets retain metadata.
- Counts, declaration positions, import links, reverse references and the
  aggregate digest agree. All 168 app/package runtime files have reviewed
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

## Collaborative browser

The standalone page was opened through the T3 collaborative browser against the
loopback-only preview server. Controls verify:

- Path/symbol search, optional complete-source search, empty results and retained
  search focus. An HTML-shaped query creates no elements or executable scripts.
- A reviewed file opens with related flows, implemented repairs and open
  findings. Symbol links navigate to the indexed declaration line.
- Source paging moves from lines 1–240 to 241–480; the selected displayed source
  line exactly matches the embedded original. Find next reports and navigates
  matching lines.
- Dependency links include the real `@slackoss/server/backup` export, while
  `node:worker_threads` remains external.
- The measured filter shows 12 records; the open filter shows all 13 Q findings
  as follow-ups. Q01 deep links expand its actual evidence and proposed boundary.
- All 15 walkthroughs display their expected title, steps and linked files.
- All five sections and the long source reader fit a 390-pixel viewport without
  document overflow. Desktop layouts were checked at 1280 and 1440 pixels.
- Skip to content focuses the main region without changing the selected route;
  a missing file receives an explicit empty state.

The checked journeys produce no browser errors or unhandled rejections. No
external resources are requested: styling, source, data and atlas logic are
embedded in the page. This demonstrates the offline structure; the preview run
itself uses HTTP on loopback. Binary assets are indexed rather than embedded as
previews. A real screen-reader pass and print-output review were not performed.
