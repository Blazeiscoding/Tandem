// Research fixture only. Uses an in-memory database and never opens workspace data.
// Run from the repository root: node docs/research/2026-09-25/retrieval-probe.mjs
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE VIRTUAL TABLE words USING fts5(text);
    CREATE VIRTUAL TABLE substrings USING fts5(text, tokenize='trigram');
  `);
  const examples = [
    {
      id: 1,
      label: "English word",
      text: "The project meeting is tomorrow",
      queries: ["meeting", "meet"],
    },
    {
      id: 2,
      label: "Chinese without spaces",
      text: "我们明天在北京开会",
      queries: ["北京", "北京开会", "我们明天在北京开会"],
    },
    {
      id: 3,
      label: "Japanese without spaces",
      text: "日本語の会議予定です",
      queries: ["会議", "会議予定", "日本語の会議予定です"],
    },
    { id: 4, label: "Latin diacritics", text: "Café résumé", queries: ["cafe", "resume"] },
    {
      id: 5,
      label: "Hindi spaced words",
      text: "कल दिल्ली में बैठक है",
      queries: ["दिल्ली", "बैठक"],
    },
    { id: 6, label: "Decomposed Latin accent", text: "cafe\u0301", queries: ["café", "cafe"] },
  ];
  for (const example of examples) {
    for (const table of ["words", "substrings"]) {
      db.prepare(`INSERT INTO ${table}(rowid, text) VALUES (?, ?)`).run(example.id, example.text);
    }
  }
  // Mirrors the literal-phrase quoting in Store.searchMessages for a single term.
  const literal = (query) => `"${query.replaceAll('"', '""')}"`;
  const results = examples.flatMap((example) =>
    example.queries.map((query) => {
      const matches = (table) =>
        db
          .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`)
          .all(literal(query))
          .some((row) => row.rowid === example.id);
      return {
        label: example.label,
        text: example.text,
        query,
        defaultFtsMatch: matches("words"),
        trigramFtsMatch: matches("substrings"),
        literalSubstringPresent: example.text.includes(query),
      };
    }),
  );
  // Separate diagnostic discovered while developing the fixture. Tandem's
  // current search uses an outer ordinary-table rowid IN subquery, not this shape.
  db.exec(
    "CREATE VIRTUAL TABLE binding_probe USING fts5(text); INSERT INTO binding_probe(rowid,text) VALUES(4,'cafe'),(6,'cafe');",
  );
  const bindingCases = [
    ["number", 4],
    ["bigint", 4n],
    ["string", "4"],
  ].map(([bindingType, id]) => ({
    bindingType,
    returnedRowids: db
      .prepare(
        "SELECT rowid FROM binding_probe WHERE rowid = ? AND binding_probe MATCH ? ORDER BY rowid",
      )
      .all(id, "cafe")
      .map((row) => row.rowid),
  }));
  bindingCases.push({
    bindingType: "number explicitly cast to integer in SQL",
    returnedRowids: db
      .prepare(
        "SELECT rowid FROM binding_probe WHERE rowid = CAST(? AS INTEGER) AND binding_probe MATCH ? ORDER BY rowid",
      )
      .all(4, "cafe")
      .map((row) => row.rowid),
  });
  console.log(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        node: process.version,
        sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
        scope:
          "Synthetic in-memory FTS5 tokenization probe; not the Tandem API, a language-quality evaluation, or a performance benchmark.",
        results,
        bindingProbe: {
          expectedRowidsForEachCase: [4],
          cases: bindingCases,
          scope:
            "Separate observed query/binding anomaly. Cause and production applicability are not established.",
        },
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
