(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("project-data").textContent);
  const files = data.files;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const main = document.getElementById("main");
  const state = {
    query: "",
    area: "all",
    kind: "all",
    sourceSearch: false,
    limit: 80,
    improvementFilter: "all",
    improvementQuery: "",
  };
  const pageSize = 240;
  const labels = {
    overview: "Overview",
    files: "File explorer",
    flows: "How it works",
    improvements: "Improvements",
    evidence: "Evidence & limits",
  };
  const number = (value) => value.toLocaleString("en-US");
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  const size = (bytes) =>
    bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(2)} MB`
      : bytes >= 1_000
        ? `${(bytes / 1_000).toFixed(1)} kB`
        : `${bytes} B`;
  const href = (path, tab = "explain", line) =>
    `#files?${new URLSearchParams({ path, tab, ...(line ? { line: String(line) } : {}) })}`;
  const fileLink = (path, label, tab = "explain", line) =>
    `<a class="file-link" href="${escape(href(path, tab, line))}" title="${escape(path)}"><span aria-hidden="true">↳</span>${escape(label ?? path)}</a>`;
  const fileChips = (paths = []) =>
    `<div class="file-chips">${paths.map((path) => fileLink(path, path.split("/").pop())).join("")}</div>`;
  const areaTitle = (id) => data.guide.areas.find((area) => area.id === id)?.title ?? id;
  const tag = (text, tone = "") => `<span class="tag ${escape(tone)}">${escape(text)}</span>`;
  const statusName = (status) =>
    status === "follow-up"
      ? "Open follow-up"
      : status === "measured"
        ? "Measured historically"
        : "Implemented";
  const empty = (title, text) =>
    `<div class="empty-state"><span aria-hidden="true">⌕</span><h3>${escape(title)}</h3><p>${escape(text)}</p></div>`;
  function route() {
    const [view, query = ""] = location.hash.slice(1).split("?");
    return {
      view: Object.hasOwn(labels, view) ? view : "overview",
      params: new URLSearchParams(query),
    };
  }
  function pageHead(eyebrow, title, text, extra = "") {
    return `<div class="page-heading"><div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(title)}</h1><p class="page-intro">${escape(text)}</p></div>${extra}</div>`;
  }
  function architecture() {
    const node = (name, sub, path, cls) =>
      `<a class="arch-node ${cls}" href="${escape(href(path))}"><span class="node-kicker">${escape(sub)}</span><strong>${escape(name)}</strong><span class="node-path">${escape(path.replace(/\/src\/.+$/, ""))} <span aria-hidden="true">↗</span></span></a>`;
    return `<div class="architecture card"><div class="section-heading"><div><p class="eyebrow">01 / THE SHARED ARCHITECTURE</p><h2>Two ways in. One workspace.</h2></div><span class="subtle">Click a block to explore its code</span></div><div class="arch-grid">
      ${node("Browser", "VITE ENTRY", "apps/web/src/main.tsx", "arch-web")}
      ${node("Desktop", "ELECTRON ENTRY", "apps/desktop/src/main/index.ts", "arch-desktop")}
      <div class="arch-connector arch-in"><span>shared renderer</span><b aria-hidden="true">↓</b></div>
      ${node("Interface + client replica", "REACT · LOCAL WORK · SOCKET STATE", "packages/client-core/src/workspace.ts", "arch-client")}
      ${node("Protocol", "TYPES & PERMISSIONS", "packages/protocol/src/index.ts", "arch-protocol")}
      <div class="arch-connector arch-wire"><span>HTTP + ordered WebSocket events</span><b aria-hidden="true">⇅</b></div>
      ${node("Workspace server", "AUTH · TRANSACTIONS · PUBLICATION", "packages/server/src/server.ts", "arch-server")}
      <div class="arch-connector arch-disk"><span>durable workspace truth</span><b aria-hidden="true">↓</b></div>
      ${node("SQLite + media folder", "DATA · FILES · RECOVERY", "packages/server/src/store.ts", "arch-store")}
      <div class="arch-note"><span class="live-dot"></span><p>The desktop can host the same server locally. The CLI and Docker can host it independently.</p>${fileLink("apps/desktop/src/main/hosting.ts", "Host ownership")}</div>
    </div></div>`;
  }
  function overview() {
    const m = data.meta;
    return `${pageHead("YOUR GUIDE TO THE PROJECT", data.guide.title, data.guide.intro, `<div class="hero-seal"><span>t.</span><small>CODE → CONTEXT</small></div>`)}
      <div class="stats-grid"><div class="stat"><strong>${number(m.fileCount)}</strong><span>files in this snapshot</span><small>${m.trackedCount} tracked + atlas inputs</small></div><div class="stat"><strong>${m.explainedRuntime}/${m.runtimeCount}</strong><span>runtime files explained</span><small>Apps + shared packages</small></div><div class="stat"><strong>${data.flows.length}</strong><span>guided code journeys</span><small>From intent to durable result</small></div><div class="stat"><strong>${data.optimizations.filter((item) => item.status === "follow-up").length}</strong><span>open findings, kept visible</span><small>Evidence is separate from a fix</small></div></div>
      ${architecture()}
      <div class="section-heading"><div><p class="eyebrow">02 / KNOW YOUR LAYERS</p><h2>Where each responsibility lives</h2></div><a class="text-link" href="#files">Browse every file <span aria-hidden="true">↗</span></a></div>
      <div class="area-grid">${data.guide.areas.map((area) => `<a href="${escape(href(area.entry))}" class="area-card card"><div>${tag(`${files.filter((file) => file.area === area.id).length} files`, area.color)}<span class="arrow" aria-hidden="true">↗</span></div><h3>${escape(area.title)}</h3><p>${escape(area.summary)}</p><code>${escape(area.id)}</code></a>`).join("")}</div>
      <div class="section-heading"><div><p class="eyebrow">03 / THE DESIGN PRINCIPLES</p><h2>The rules behind the code</h2></div></div><div class="principles">${data.guide.principles.map((principle, index) => `<article class="card principle"><span class="index-number">0${index + 1}</span><h3>${escape(principle.title)}</h3><p>${escape(principle.text)}</p>${fileChips(principle.files)}</article>`).join("")}</div>
      <div class="reading-guide card"><div><p class="eyebrow">A GOOD PLACE TO BEGIN</p><h2>Read the project as a story.</h2><p>Then follow any sentence back to its source.</p><a href="#flows" class="primary-link">Start a walkthrough <span aria-hidden="true">→</span></a></div><ol>${data.guide.reading.map((item) => `<li><h3>${escape(item.title)}</h3><p>${escape(item.text)}</p></li>`).join("")}</ol></div>`;
  }
  function options(values, selected, title) {
    return `<option value="all">${escape(title)}</option>${values.map((value) => `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(title === "All areas" ? areaTitle(value) : value)}</option>`).join("")}`;
  }
  function matchingFiles() {
    const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return files.filter((file) => {
      if (state.area !== "all" && file.area !== state.area) return false;
      if (state.kind !== "all" && file.kind !== state.kind) return false;
      const haystack = [
        file.path,
        file.summary,
        ...file.concepts,
        ...file.symbols.map((symbol) => symbol.name),
        ...(state.sourceSearch ? [file.source ?? ""] : []),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }
  function renderFileList() {
    const target = document.getElementById("file-list");
    if (!target) return;
    const matches = matchingFiles();
    const selected = route().params.get("path") ?? "packages/ui/src/App.tsx";
    document.getElementById("file-results").textContent =
      `${number(matches.length)} of ${number(files.length)} files`;
    let lastArea = "";
    target.innerHTML =
      matches
        .slice(0, state.limit)
        .map((file) => {
          const header =
            file.area !== lastArea
              ? `<div class="tree-area">${escape(areaTitle(file.area))}</div>`
              : "";
          lastArea = file.area;
          return `${header}<a href="${escape(href(file.path))}" class="tree-file ${selected === file.path ? "selected" : ""}" ${selected === file.path ? 'aria-current="true"' : ""} title="${escape(file.path)}"><span class="file-glyph ${file.curated ? "curated" : ""}" aria-hidden="true">${file.kind === "test" ? "✓" : file.kind === "documentation" || file.kind === "research" ? "≡" : "◇"}</span><span><strong>${escape(file.path.split("/").pop())}</strong><small>${escape(file.path.substring(0, file.path.lastIndexOf("/")) || "repository root")}</small></span></a>`;
        })
        .join("") +
      (matches.length > state.limit
        ? `<button class="more-button" type="button" data-action="more-files">Show next ${Math.min(80, matches.length - state.limit)} files</button>`
        : "") +
      (!matches.length
        ? empty("No matching files", "Try a shorter query or clear the area and kind filters.")
        : "");
  }
  function fileExplain(file) {
    const related = data.optimizations.filter((item) => item.files.includes(file.path));
    const journeys = data.flows.filter((flow) =>
      flow.steps.some((step) => step.files.includes(file.path)),
    );
    const directTests = file.usedBy.filter((path) => byPath.get(path).kind === "test");
    return `<div class="explanation-banner ${file.curated ? "reviewed" : ""}"><span>${file.curated ? "✓ REVIEWED FILE EXPLANATION" : "◇ STRUCTURAL FILE DESCRIPTION"}</span><p>${escape(file.summary)}</p></div>
      <div class="prose-block"><h3>What this file does</h3>${file.details.map((detail) => `<p>${escape(detail)}</p>`).join("")}</div>
      <div class="concepts">${file.concepts.map((concept) => tag(concept)).join("")}</div>
      ${
        file.symbols.length
          ? `<div class="prose-block"><h3>Start reading here</h3><p>Named declarations connect this explanation to the exact implementation. The complete index is in Symbols.</p><div class="symbol-preview">${file.symbols
              .filter(
                (symbol) =>
                  symbol.exported || symbol.kind === "class" || symbol.kind === "function",
              )
              .slice(0, 8)
              .map(
                (symbol) =>
                  `<a href="${escape(href(file.path, "source", symbol.line))}"><code>${escape(symbol.name)}</code><span>${escape(symbol.kind)} · line ${symbol.line}</span></a>`,
              )
              .join("")}</div></div>`
          : ""
      }
      ${
        file.checks.length
          ? `<div class="prose-block"><h3>What the named tests describe</h3><p>Static names are evidence of the assertions written here. Execution results belong to the dated validation records.</p><div class="test-names">${file.checks
              .slice(0, 16)
              .map(
                (check) =>
                  `<a href="${escape(href(file.path, "source", check.line))}" class="${check.group ? "test-group" : ""}">${check.skipped ? "○" : "✓"} ${escape(check.name)}<span>L${check.line}</span></a>`,
              )
              .join(
                "",
              )}</div>${file.checks.length > 16 ? `<p>${fileLink(file.path, `See all ${file.checks.length} named cases and groups`, "symbols")}</p>` : ""}</div>`
          : ""
      }
      ${directTests.length ? `<div class="prose-block"><h3>Direct regression imports</h3><p>These tests import this module. Indirect tests and adapter-driven coverage are not fully represented by this source map.</p>${fileChips(directTests)}</div>` : ""}
      ${journeys.length ? `<div class="prose-block"><h3>Its place in a journey</h3><div class="related-links">${journeys.map((flow) => `<a href="#flows?id=${encodeURIComponent(flow.id)}"><span aria-hidden="true">⇢</span>${escape(flow.title)}<span aria-hidden="true">↗</span></a>`).join("")}</div></div>` : ""}
      ${related.length ? `<div class="prose-block"><h3>Changes and remaining work</h3><div class="related-links">${related.map((item) => `<a href="#improvements?id=${encodeURIComponent(item.id)}">${tag(item.id, item.status === "follow-up" ? "orange" : "mint")}<span>${escape(item.title)}</span><small>${statusName(item.status)}</small></a>`).join("")}</div></div>` : ""}
      <div class="metadata-note"><span>SHA-256</span><code>${escape(file.hash)}</code></div>`;
  }
  function highlight(line) {
    const token =
      /\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:export|import|from|type|interface|class|function|const|let|return|async|await|if|else|throw|try|catch|finally|new|private|public|readonly|extends|implements|switch|case|true|false|null|undefined|for|while|void)\b|\b\d+(?:\.\d+)?\b/g;
    let result = "",
      position = 0;
    for (const match of line.matchAll(token)) {
      result += escape(line.slice(position, match.index));
      const word = match[0];
      const kind = word.startsWith("//")
        ? "comment"
        : /^["'`]/.test(word)
          ? "string"
          : /^\d/.test(word)
            ? "number"
            : "keyword";
      result += `<span class="syntax-${kind}">${escape(word)}</span>`;
      position = match.index + word.length;
    }
    return result + escape(line.slice(position));
  }
  function sourcePane(file, params) {
    if (file.source === null)
      return `<div class="binary-notice card"><h3>Binary asset</h3><p>This file is indexed by name, size and SHA-256. It has no text source to display.</p><code>${escape(file.path)}</code><p>${size(file.bytes)}</p></div>`;
    const lines = file.source.split("\n");
    const requested = Number(params.get("line")) || 1;
    const line = Math.min(lines.length, Math.max(1, Math.trunc(requested)));
    const start = Math.floor((line - 1) / pageSize) * pageSize;
    const end = Math.min(start + pageSize, lines.length);
    return `<div class="source-toolbar"><span>${number(lines.length)} lines · showing ${start + 1}–${end}</span><label>Jump to line <input id="line-number" type="number" min="1" max="${lines.length}" value="${line}" /></label><button class="small-button" type="button" data-action="jump-line">Go</button><button class="small-button" type="button" data-action="download-source">Download source</button></div>
      <div class="source-search"><label for="source-find">Find in this file</label><input id="source-find" type="search" placeholder="Text or symbol…" /><button class="small-button" type="button" data-action="find-source">Find next</button><span id="source-find-status" role="status"></span></div>
      <div class="code-window" tabindex="0" aria-label="Source code for ${escape(file.path)}"><ol class="code-lines" start="${start + 1}">${lines
        .slice(start, end)
        .map(
          (text, index) =>
            `<li id="line-${start + index + 1}" class="${line === start + index + 1 ? "line-selected" : ""}"><code>${highlight(text) || " "}</code></li>`,
        )
        .join("")}</ol></div>
      <div class="source-pagination">${start ? `<a class="small-button" href="${escape(href(file.path, "source", Math.max(1, start - pageSize + 1)))}">← Previous lines</a>` : "<span></span>"}<span>${Math.floor(start / pageSize) + 1} / ${Math.ceil(lines.length / pageSize)}</span>${end < lines.length ? `<a class="small-button" href="${escape(href(file.path, "source", end + 1))}">Next lines →</a>` : "<span></span>"}</div><p class="source-caption">Embedded source is read as text, never executed. Highlighting is a reading aid; declarations come from TypeScript's parser.</p>`;
  }
  function symbolsPane(file) {
    return `<div class="prose-block"><h3>Declarations in source order</h3><p>Functions, classes, interfaces, types, methods and top-level values. Click a declaration to read its implementation at the correct line.</p></div>${file.symbols.length ? `<div class="symbols-table">${file.symbols.map((symbol) => `<a class="symbol-row" href="${escape(href(file.path, "source", symbol.line))}"><div><code>${escape(symbol.name)}</code>${tag(symbol.kind)}${symbol.exported ? tag("export", "mint") : ""}<span class="symbol-line">L${symbol.line}–${symbol.end}</span></div><p>${escape(symbol.comment || symbol.signature)}</p></a>`).join("")}</div>` : empty("No indexed declarations", "Text, config, assets and anonymous entry code are still available in Source.")}
      ${file.checks.length ? `<div class="prose-block"><h3>Named tests and groups</h3></div><div class="test-names">${file.checks.map((check) => `<a class="${check.group ? "test-group" : ""}" href="${escape(href(file.path, "source", check.line))}">${check.skipped ? "○" : "✓"} ${escape(check.name)}<span>L${check.line}</span></a>`).join("")}</div>` : ""}`;
  }
  function connectionsPane(file) {
    const local = file.imports.filter((dependency) => dependency.path);
    const external = file.imports.filter((dependency) => !dependency.path);
    return `<div class="connection-stats"><div><strong>${local.length}</strong><span>local import references</span></div><div><strong>${file.usedBy.length}</strong><span>files importing this file</span></div><div><strong>${external.length}</strong><span>external / unresolved imports</span></div></div><p class="source-caption">These are static source dependencies, including type-only and literal dynamic imports. They do not describe every runtime call.</p>
      <div class="prose-block"><h3>Reads from / depends on</h3></div><div class="dependency-list">${local.length ? local.map((dependency) => `<div>${fileLink(dependency.path)}<span>${dependency.typeOnly ? "type only" : dependency.dynamic ? "dynamic" : "import"} · L${dependency.line}</span></div>`).join("") : "<p>No resolved repository import references.</p>"}</div>
      <div class="dependency-center"><span aria-hidden="true">⇅</span><code>${escape(file.path)}</code></div>
      <div class="prose-block"><h3>Used by</h3></div><div class="dependency-list">${file.usedBy.length ? file.usedBy.map((path) => `<div>${fileLink(path)}${tag(byPath.get(path).kind)}</div>`).join("") : "<p>No direct importer is indexed. An entry point, script or injected adapter can still use this file.</p>"}</div>
      ${external.length ? `<details class="external-imports"><summary>External and unresolved specifiers (${external.length})</summary>${external.map((dependency) => `<p><code>${escape(dependency.specifier)}</code><span>L${dependency.line}</span></p>`).join("")}</details>` : ""}`;
  }
  function filesPage(params) {
    const path = params.get("path") ?? "packages/ui/src/App.tsx";
    const file = byPath.get(path);
    const requestedTab = params.get("tab");
    const tab = ["explain", "source", "symbols", "connections"].includes(requestedTab)
      ? requestedTab
      : "explain";
    const details = !file
      ? empty(
          "File not in this snapshot",
          "Use the explorer to choose an indexed file. Regenerate the atlas after adding or renaming a file.",
        )
      : `<div class="file-heading"><p class="eyebrow">${escape(areaTitle(file.area))}</p><h2>${escape(file.path.split("/").pop())}</h2><div class="full-path">${escape(file.path)}</div><div class="file-facts">${tag(file.kind)}${tag(file.curated ? "reviewed" : "generated metadata", file.curated ? "mint" : "")}<span>${number(file.lines)} lines</span><span>${size(file.bytes)}</span></div></div><nav class="file-tabs" aria-label="File details">${[
          ["explain", "Explanation"],
          ["source", "Source"],
          ["symbols", `Symbols (${file.symbols.length})`],
          ["connections", "Connections"],
        ]
          .map(
            ([key, label]) =>
              `<a href="${escape(href(path, key))}" ${tab === key ? 'aria-current="page" class="active"' : ""}>${escape(label)}</a>`,
          )
          .join(
            "",
          )}</nav><div class="file-content">${tab === "source" ? sourcePane(file, params) : tab === "symbols" ? symbolsPane(file) : tab === "connections" ? connectionsPane(file) : fileExplain(file)}</div>`;
    return `${pageHead("THE WHOLE REPOSITORY", "Open a file. Follow the code.", "Search paths, explanations and symbols. Turn on source search to include every embedded line.")}<div class="explorer-grid"><aside class="explorer-sidebar card" aria-label="File search and results"><div class="explorer-controls"><label for="file-search">Find a file or symbol</label><div class="search-field"><span aria-hidden="true">⌕</span><input id="file-search" type="search" placeholder="workspace, drafts, backup…" value="${escape(state.query)}" /></div><div class="filter-row"><select id="area-filter" aria-label="Filter by area">${options([...new Set(files.map((file) => file.area))], state.area, "All areas")}</select><select id="kind-filter" aria-label="Filter by file kind">${options([...new Set(files.map((file) => file.kind))].sort(), state.kind, "All kinds")}</select></div><label class="checkbox-label"><input id="search-source" type="checkbox" ${state.sourceSearch ? "checked" : ""} /> Search source text</label><div class="results-heading"><span id="file-results" aria-live="polite"></span><button type="button" class="text-button" data-action="reset-filters">Reset</button></div></div><div id="file-list" class="file-tree"></div></aside><article class="file-detail card">${details}</article></div>`;
  }
  function flowsPage(params) {
    const flow = data.flows.find((item) => item.id === params.get("id")) ?? data.flows[0];
    return `${pageHead("FOLLOW THE HANDOFFS", "How an action becomes a result.", "A guided tour of the real modules involved, including persistence, cancellation and failure boundaries.")}<div class="journey-grid"><nav class="journey-menu card" aria-label="Code journeys">${data.flows.map((item, index) => `<a href="#flows?id=${encodeURIComponent(item.id)}" ${item.id === flow.id ? 'class="active" aria-current="page"' : ""}><span class="journey-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${escape(item.title)}</strong><small>${escape(item.area)} · ${item.steps.length} steps</small></span></a>`).join("")}</nav><article class="journey-detail"><div class="journey-head card">${tag(flow.area, "mint")}<h2>${escape(flow.title)}</h2><p>${escape(flow.summary)}</p></div><ol class="journey-steps">${flow.steps.map((step, index) => `<li><span class="step-number">${String(index + 1).padStart(2, "0")}</span><div class="step-card card"><h3>${escape(step.title)}</h3><p>${escape(step.description)}</p>${fileChips(step.files)}</div></li>`).join("")}</ol><div class="flow-end"><span aria-hidden="true">✓</span> Follow a file link to inspect the exact implementation and its related work.</div></article></div>`;
  }
  function metric(metric) {
    const before = Number(metric.before),
      after = Number(metric.after);
    const numeric = Number.isFinite(before) && Number.isFinite(after) && before > 0 && after >= 0;
    return `<div class="metric ${numeric && after > before ? "metric-increase" : ""}"><span>${escape(metric.label)}</span><div><strong>${escape(metric.before)} <small>${escape(metric.unit)}</small></strong><span aria-hidden="true">→</span><strong class="metric-after">${escape(metric.after)} <small>${escape(metric.unit)}</small></strong></div>${numeric ? `<div class="metric-bars" aria-label="Before ${escape(metric.before)}, after ${escape(metric.after)} ${escape(metric.unit)}"><span style="width:${(100 * before) / Math.max(before, after)}%"></span><span style="width:${(100 * after) / Math.max(before, after)}%"></span></div>` : ""}</div>`;
  }
  function improvementCard(item, open) {
    return `<article class="improvement-card card ${item.status === "follow-up" ? "pending" : ""}" id="improvement-${escape(item.id)}"><div class="improvement-heading"><div>${tag(item.id, item.status === "follow-up" ? "orange" : "mint")}${tag(item.category)}<h3>${escape(item.title)}</h3></div><span class="status-badge ${escape(item.status)}"><span aria-hidden="true">${item.status === "follow-up" ? "○" : "✓"}</span>${statusName(item.status)}</span></div><p class="improvement-summary">${escape(item.summary)}</p>${item.metrics?.length ? `<div class="metrics-row">${item.metrics.map(metric).join("")}</div>` : ""}<details ${open ? "open" : ""}><summary>Read the change, mechanism and evidence <span aria-hidden="true">＋</span></summary><div class="before-after"><div><p class="eyebrow">${item.status === "follow-up" ? "OBSERVED BEHAVIOR" : "BEFORE"}</p><p>${escape(item.before)}</p></div><div><p class="eyebrow">${item.status === "follow-up" ? "PROPOSED ACCEPTANCE" : "AFTER"}</p><p>${escape(item.after)}</p></div></div><div class="prose-block"><h4>How it works</h4><p>${escape(item.mechanism)}</p></div><div class="prose-block"><h4>Files involved</h4>${fileChips(item.files)}</div><div class="prose-block"><h4>Evidence to inspect</h4><div class="evidence-links">${(item.evidence ?? []).map((evidence) => fileLink(evidence.path, evidence.label, "source")).join("")}</div></div>${item.limits?.length ? `<div class="limits-note"><h4>What this evidence covers</h4><ul>${item.limits.map((limit) => `<li>${escape(limit)}</li>`).join("")}</ul></div>` : ""}</details><a class="permalink" href="#improvements?id=${encodeURIComponent(item.id)}" aria-label="Link to ${escape(item.title)}"># ${escape(item.id)}</a></article>`;
  }
  function renderImprovements() {
    const container = document.getElementById("improvement-list");
    if (!container) return;
    const id = route().params.get("id");
    const query = state.improvementQuery.toLowerCase();
    const matches = data.optimizations.filter(
      (item) =>
        (state.improvementFilter === "all" || item.status === state.improvementFilter) &&
        [item.id, item.title, item.summary, item.category, ...item.files]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
    container.innerHTML =
      matches.map((item) => improvementCard(item, item.id === id)).join("") ||
      empty("No matching improvements", "Try a different term or choose All changes.");
    document.getElementById("improvement-count").textContent = `${matches.length} records`;
    document.querySelectorAll("[data-improvement-filter]").forEach((button) => {
      const active = button.dataset.improvementFilter === state.improvementFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  function improvementsPage(params) {
    const selected = data.optimizations.find((item) => item.id === params.get("id"));
    if (selected) {
      state.improvementFilter = "all";
      state.improvementQuery = "";
    }
    return `${pageHead("WHAT CHANGED, AND WHY", "Improvements with a paper trail.", "Performance, size and reliability are different outcomes. Each record names the mechanism, source files, evidence and remaining limits.")}<div class="improvement-legend card"><div><span class="legend-dot mint"></span><strong>Implemented</strong><p>A scoped behavior or control is in the code.</p></div><div><span class="legend-dot blue"></span><strong>Measured historically</strong><p>A before/after result in a recorded workload.</p></div><div><span class="legend-dot orange"></span><strong>Open follow-up</strong><p>A reproduced finding still awaiting its fix.</p></div></div><div class="improvement-controls"><div class="segmented" aria-label="Filter improvement status">${[
      ["all", "All changes"],
      ["implemented", "Implemented"],
      ["measured", "Measured"],
      ["follow-up", "Open work"],
    ]
      .map(
        ([key, label]) =>
          `<button type="button" data-improvement-filter="${key}">${label} <span>${key === "all" ? data.optimizations.length : data.optimizations.filter((item) => item.status === key).length}</span></button>`,
      )
      .join(
        "",
      )}</div><label class="search-field"><span aria-hidden="true">⌕</span><input id="improvement-search" type="search" placeholder="Search changes…" aria-label="Search improvements" value="${escape(state.improvementQuery)}" /></label><span id="improvement-count"></span></div><div id="improvement-list" class="improvement-list"></div>`;
  }
  function evidencePage() {
    return `${pageHead("CLAIMS YOU CAN TRACE", "Evidence has a scope.", "These are recorded validation results and known boundaries. Opening this atlas does not rerun the project's test suites.")}<div class="validation-grid">${data.guide.validation.map((record) => `<article class="card validation-card"><strong>${escape(record.value)}</strong><h3>${escape(record.label)}</h3><p>${escape(record.detail)}</p>${fileLink(record.path, "Open the recorded evidence", "source")}</article>`).join("")}</div><div class="card evidence-note"><div>${tag("Merged baseline", "mint")}<h2>The latest repair batch</h2><p>N01–N12 cover safer logging, durable device storage, close preparation, mute intent, form ownership, content cleanup, callbacks, attachment invalidation and hosting cleanup. Schema 37 cleans active database copies. Q01–Q13 remain follow-ups with their own controlled reproductions.</p>${fileChips(["docs/IMPLEMENTATION-2026-10-04.md", "docs/MORE-IMPROVEMENTS-2026-10-04.md"])}</div><div class="evidence-revision"><span>PR #246</span><strong>4501593</strong><p>Merged source baseline<br />${escape(data.meta.revision.slice(0, 12))} is this checkout's base.</p><a class="text-link" href="${escape(data.meta.repository)}/pull/246" target="_blank" rel="noopener noreferrer">View the merged PR ↗</a></div></div><div class="section-heading"><div><p class="eyebrow">READ BEFORE GENERALIZING</p><h2>Scope, coverage and known limits</h2></div></div><ol class="scope-list">${data.guide.limits.map((limit, index) => `<li class="card"><span>${String(index + 1).padStart(2, "0")}</span><p>${escape(limit)}</p></li>`).join("")}</ol><div class="section-heading"><div><p class="eyebrow">A SMALL TECHNICAL DICTIONARY</p><h2>Terms used in this atlas</h2></div></div><dl class="glossary">${data.guide.glossary.map((item) => `<div class="card"><dt>${escape(item.term)}</dt><dd>${escape(item.meaning)}</dd></div>`).join("")}</dl><div class="snapshot-card card"><h3>Snapshot identity</h3><p>${number(data.meta.fileCount)} files · ${number(data.meta.textCount)} full-text files · ${number(data.meta.totalLines)} text lines · ${number(data.meta.symbols)} declarations · ${number(data.meta.edges)} local import references</p><p><strong>Base commit:</strong> <code>${escape(data.meta.revision)}</code></p><p><strong>Input SHA-256:</strong> <code>${escape(data.meta.inputDigest)}</code></p><p>${fileLink("docs/visualizer/README.md", "How to update or regenerate this page", "source")}</p></div>`;
  }
  function render() {
    const { view, params } = route();
    document.querySelectorAll("[data-view]").forEach((link) => {
      link.classList.toggle("active", link.dataset.view === view);
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.getElementById("breadcrumb").textContent = labels[view];
    document.title = `Tandem • ${labels[view]} • Project atlas`;
    main.innerHTML =
      view === "files"
        ? filesPage(params)
        : view === "flows"
          ? flowsPage(params)
          : view === "improvements"
            ? improvementsPage(params)
            : view === "evidence"
              ? evidencePage()
              : overview();
    if (view === "files") renderFileList();
    if (view === "improvements") renderImprovements();
    const line = params.get("line");
    const selected = params.get("id");
    if (view === "files" && params.get("tab") === "source" && line)
      requestAnimationFrame(() =>
        document
          .getElementById(
            `line-${Math.min(byPath.get(params.get("path"))?.lines ?? 1, Math.max(1, Math.trunc(Number(line)) || 1))}`,
          )
          ?.scrollIntoView({ block: "center" }),
      );
    else if (view === "improvements" && selected)
      requestAnimationFrame(() =>
        document.getElementById(`improvement-${selected}`)?.scrollIntoView({ block: "start" }),
      );
    else window.scrollTo(0, 0);
    document.getElementById("announcement").textContent =
      `${labels[view]} loaded${view === "files" ? `: ${params.get("path") ?? "packages/ui/src/App.tsx"}` : ""}`;
  }
  function searchFocus() {
    if (route().view !== "files") location.hash = "files";
    requestAnimationFrame(() => document.getElementById("file-search")?.focus());
  }
  document.getElementById("open-search").addEventListener("click", searchFocus);
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: "start" });
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) &&
      !event.target.isContentEditable
    ) {
      event.preventDefault();
      searchFocus();
    }
    if (event.key === "Enter" && event.target.id === "line-number") {
      event.preventDefault();
      jumpLine();
    }
    if (event.key === "Enter" && event.target.id === "source-find") {
      event.preventDefault();
      findSource();
    }
  });
  main.addEventListener("input", (event) => {
    if (event.target.id === "file-search") {
      state.query = event.target.value;
      state.limit = 80;
      renderFileList();
    }
    if (event.target.id === "improvement-search") {
      state.improvementQuery = event.target.value;
      renderImprovements();
    }
  });
  main.addEventListener("change", (event) => {
    if (event.target.id === "area-filter") state.area = event.target.value;
    else if (event.target.id === "kind-filter") state.kind = event.target.value;
    else if (event.target.id === "search-source") state.sourceSearch = event.target.checked;
    else return;
    state.limit = 80;
    renderFileList();
  });
  function currentFile() {
    return byPath.get(route().params.get("path") ?? "packages/ui/src/App.tsx");
  }
  function jumpLine() {
    const file = currentFile();
    if (!file) return;
    const line = Math.min(
      file.lines || 1,
      Math.max(1, Math.trunc(Number(document.getElementById("line-number").value)) || 1),
    );
    location.hash = href(file.path, "source", line);
  }
  let findState = { path: "", query: "", index: -1 };
  function findSource() {
    const file = currentFile(),
      input = document.getElementById("source-find");
    if (!file?.source || !input?.value) return;
    const query = input.value.toLowerCase();
    if (findState.path !== file.path || findState.query !== query)
      findState = { path: file.path, query, index: -1 };
    const matches = file.source
      .split("\n")
      .map((text, index) => (text.toLowerCase().includes(query) ? index + 1 : null))
      .filter(Boolean);
    if (!matches.length) {
      document.getElementById("source-find-status").textContent = "No matches";
      return;
    }
    findState.index = (findState.index + 1) % matches.length;
    const line = matches[findState.index];
    const value = input.value;
    const destination = href(file.path, "source", line);
    if (location.hash === destination) render();
    else {
      history.replaceState(null, "", destination);
      render();
    }
    document.getElementById("source-find").value = value;
    document.getElementById("source-find-status").textContent =
      `${findState.index + 1} / ${matches.length} matching lines`;
    document.getElementById("source-find").focus({ preventScroll: true });
  }
  main.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.improvementFilter) {
      state.improvementFilter = button.dataset.improvementFilter;
      renderImprovements();
    }
    if (button.dataset.action === "more-files") {
      state.limit += 80;
      renderFileList();
    }
    if (button.dataset.action === "reset-filters") {
      state.query = "";
      state.area = "all";
      state.kind = "all";
      state.sourceSearch = false;
      state.limit = 80;
      document.getElementById("file-search").value = "";
      document.getElementById("area-filter").value = "all";
      document.getElementById("kind-filter").value = "all";
      document.getElementById("search-source").checked = false;
      renderFileList();
    }
    if (button.dataset.action === "jump-line") jumpLine();
    if (button.dataset.action === "find-source") findSource();
    if (button.dataset.action === "download-source") {
      const file = currentFile();
      if (file?.source === null || !file) return;
      const url = URL.createObjectURL(
        new Blob([file.source], { type: "text/plain;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = file.path.split("/").pop();
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
  document.getElementById("nav-count").textContent = data.meta.fileCount;
  const revisionLink = document.getElementById("revision-link");
  revisionLink.textContent = data.meta.revision.slice(0, 7);
  revisionLink.href = `${data.meta.repository}/commit/${data.meta.revision}`;
  document.getElementById("snapshot-digest").textContent =
    `inputs ${data.meta.inputDigest.slice(0, 12)}`;
  document.getElementById("footer-hash").textContent =
    `${data.meta.runtimeCount} runtime explanations · ${data.meta.symbols} declarations`;
  window.addEventListener("hashchange", render);
  render();
})();
