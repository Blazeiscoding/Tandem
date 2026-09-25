# Hosted workspace registry: design (roadmap C1)

September 25, 2026. This is the design the roadmap's first sprint asked for in ticket 5, before any code. It covers how the desktop app finds the data of a workspace it hosts. Steps 1 to 4 of the order of work are now built. Where the build differs from the first draft, the text below says what was built and why.

## The problem

The desktop app keeps each hosted workspace's data in a folder under `<userData>/hosted/`. It picks the folder from the name typed into Start hosting ([hosting.ts](../apps/desktop/src/main/hosting.ts), `start`):

```ts
const slug =
  requested.workspaceName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "") || "workspace";
```

Different names therefore land in the same folder:

| Typed name              | Folder      |
| ----------------------- | ----------- |
| Team A, Team-A, team a! | `team-a`    |
| Café, Caf               | `caf`       |
| 日本, Команда, ???      | `workspace` |

The server then makes it worse. Every start passes the typed name, and the server writes it over the stored one ([server.ts](../packages/server/src/server.ts), `store.setMeta("workspace_name", opts.workspaceName)`). Someone who hosts "Team-A" after "Team A" gets no second workspace. They get Team A's accounts, messages and files, renamed to Team-A. Everyone signed in to Team A sees the new name. Two non-Latin workspaces are always the same one.

`apps/desktop/test/hosting.test.ts` pins this behaviour ("keeps the folder names earlier versions used") on purpose, so that upgrades reopen existing folders. The fix must keep that promise for folders that already exist and stop making new collisions.

## What already exists

- **A permanent workspace ID.** On first start the server stores a ULID as `workspace_id` in its database meta table and never changes it ([server.ts](../packages/server/src/server.ts)). The ready snapshot sends it to clients (`workspaceId` in [events.ts](../packages/protocol/src/events.ts)), and Slack-compatible payloads use it as `team_id`. A backup restored elsewhere keeps it.
- **Client storage already keyed by it.** Drafts, the outbox and scheduling requests use `workspaceStorageKey(baseUrl, workspaceId, selfId, …)`. Nothing in this design changes those scopes.
- **An atomic settings file.** `createSettingsStorage` ([settings.ts](../apps/desktop/src/main/settings.ts)) writes `settings.json` through a temporary file and a rename, one write at a time. `lastHosted` (name and port) lives there today.

## Design

### A registry in the settings file

`settings.json` gains one key, `hostedWorkspaces`:

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "01J8…",
      "folder": "rocket-team",
      "name": "Rocket Team",
      "port": 8543,
      "lastHostedAt": 1727222400000
    },
    {
      "id": "01J9…",
      "folder": "w-3f9c…",
      "name": "日本",
      "port": 8544,
      "lastHostedAt": 1727308800000
    }
  ]
}
```

- `id` is the server's `workspace_id`. It is `null` only for an adopted folder whose database has not recorded one yet (see adoption below).
- `folder` is a name relative to `<userData>/hosted/`. It has to be a single path segment matching `^[a-z0-9-]{1,64}$`. Anything else is refused on read, so a hand-edited file cannot point the app outside `hosted/`.
- `name` and `port` are a cache of what the server reported on its last start. The server remains the authority for the name.
- The most recent entry is the one with the latest `lastHostedAt`, so no separate pointer is needed. The first draft kept `lastHosted` as a pointer, `{ id, port }`. As built, it is read only once, when this version first finds no registry (see the migration). It is still written in its old form, `{ workspaceName, port }`, for earlier versions, which reopen by name. It names a workspace only when the entry's folder is the one an earlier version would work out from that name, and is null otherwise. A downgraded app then offers nothing rather than the wrong folder.

### New workspaces get new folders

Start hosting with a new name always creates a new entry. The folder is `w-` plus 32 random hexadecimal digits, so it has nothing to do with the name. The order:

1. Validate the name as today (1–80 characters, no control characters).
2. Create the folder, and fail if it already exists. Then write the registry entry with `id: null`. If the registry cannot be written, delete the empty folder and refuse to start. A workspace the app cannot find again must never exist.
3. Start the server in that folder. It creates `workspace_id`.
4. Record the ID and the port the server bound in the entry. If this write fails, hosting keeps running with the warning shown today for `lastHosted`, and adoption finds the ID on the next launch.
5. If the server does not start, take the entry back out and delete the folder, so trying again leaves no empty workspaces in the list.

Reopening an existing workspace goes by entry, never by name. `start` accepts either `{ folder }`, for an existing entry, or `{ workspaceName }`, which always means a new workspace. Nothing will look up a workspace by its name. The first draft used `{ id }`. The folder was chosen because an adopted entry can lack an ID until it starts, and a folder never changes once an entry has it. An existing workspace is started without a name, so the server keeps the one it has. Before starting an entry with an ID, the app reads the ID in its database, and refuses if the folder is missing or holds another workspace.

### Adopting the folders earlier versions made

When the hosting controller is created, before anything can start, it lists `hosted/`. For each folder holding a `workspace.db` that no registry entry names, it adds an entry:

- It opens the database read-only with `node:sqlite` and reads `workspace_id` and `workspace_name` from the meta table. The server is not running yet, so nothing else has the file open. If the read fails, the folder is left out and a warning names it without its path.
- It never moves, renames or merges a folder. The slug folders keep their names, so an older build that reopens by slug still finds them.
- A database from before `workspace_id` existed gets `id: null`. The server writes an ID on its next start, and the controller records it then.
- Folders already merged by the old naming stay one workspace. There is no reliable way to split them, and the registry says what the database now says.

Adoption runs once per launch and never runs while a server is started. A second launch finds the entries and does nothing.

Old `lastHosted` values, `{ workspaceName, port }`, are converted by working out the slug exactly as the old code did. The pointer then goes to the entry adopted from that folder. The resume offer therefore reopens the same data after an upgrade.

### What the interface shows

- The host dialog's name field starts a new workspace. If an entry with the same name exists, the dialog says so and offers to reopen that one. It never reopens it silently.
- The host dialog lists every entry, with the most recent first. Each item has its name, its port and a Start button, and a missing folder is shown as missing with the button disabled. The join screen's resume offer still names only the most recent entry, and now starts it by its folder.
- Renaming stays out of this change. A later rename only updates the server's `workspace_name` and the registry's cached name; the folder does not move.
- A new IPC call, `hosting:list`, returns `{ workspaces, unreadable }`. Each workspace is `{ folder, name, port, lastHostedAt, running, missing }`, and `unreadable` names the folders adoption could not read. `hosting:start` accepts `{ folder, port? }` or `{ workspaceName, port? }`. `hosting:lastHosted` answers from the registry with `{ folder, workspaceName, port }`.
- The name field no longer fills in the last workspace's name. It only ever makes a new workspace.

### Failure cases

| Case                                        | Behaviour                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `settings.json` unreadable                  | Existing entries cannot be listed. Starting a new workspace is refused, so nothing gets orphaned; the error says so.      |
| Registry entry points at a missing folder   | Listed as missing and cannot be started. The folder is never recreated empty. Removing it from the list is not built yet. |
| Entry's database has a different ID         | Refuse to start it, and say the folder holds another workspace. This is what a copied or swapped folder looks like.       |
| Two entries claim one folder                | Keep the first and drop the other on read, with a warning.                                                                |
| Folder name in the file is not a plain name | Drop the entry on read. It may not point outside `hosted/`.                                                               |
| Downgrade to an older build                 | Slug folders reopen as before. `w-` folders are invisible to it but untouched, and they reappear after upgrading again.   |

## What stays the same

The server, its database, the protocol and client storage scopes. Browser clients and the standalone server are not affected. `dataDir` for a server started outside the desktop app still means whatever path it is given.

## Tests

The cases below are in the suites named, as built.

In `apps/desktop/test/hosting.test.ts`, over the existing fake servers and a temporary `hosted/` folder:

- "Team A" then "Team-A" start two servers in two folders, and neither renames the other.
- "日本" and "Команда" get different folders, and both reopen by ID after a restart.
- Folders `rocket-team` and `workspace` holding databases are adopted with their IDs and names. Resuming the old `lastHosted: { workspaceName: "Rocket Team", port }` opens `rocket-team`.
- Adoption does not open a database while a server runs, and a second launch adds nothing.
- A registry that cannot be written refuses a new workspace and leaves no folder behind.
- A folder whose database ID differs from its entry is refused.
- A hand-edited entry with `folder: "../x"` is ignored.

The packaged desktop suite (`tests/e2e/desktop.spec.ts`) adds a second workspace whose name differs from the first only by punctuation, and checks that each keeps its own messages.

## Order of work

1. Registry read/write and validation in a module beside `hosting.ts`, with its unit tests.
2. Adoption and the `lastHosted` conversion, tested against real SQLite files in a temp folder.
3. `start({ id } | { workspaceName })`, and new folders named by ULID.
4. `hosting:list`, then the host dialog and resume list in the renderer.
5. C2's backup and restore use the registry to name what they are backing up. That is its own change.

Estimate: the roadmap's M (4–10 days), most of it in adoption and the renderer. It touches the desktop app, so `desktop.yml` runs on each pull request, and `pnpm test:desktop` runs locally before each push.
