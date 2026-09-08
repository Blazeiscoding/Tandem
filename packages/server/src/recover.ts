import { join } from "node:path";
import { existsSync } from "node:fs";
import { openDb } from "./db.js";
import { Store } from "./store.js";
import { hashPassword } from "./auth.js";
import { secretToken } from "./ids.js";

export interface RecoverableAccount {
  handle: string;
  displayName: string;
  role: string;
  deactivated: boolean;
  mustChangePassword: boolean;
}

/**
 * Emergency recovery runs on the machine holding the workspace, against the
 * database file directly. That is deliberately the only way in: whoever has the
 * file already has everything in it, so no new trust is granted, and a locked
 * out owner does not need a working sign-in to get back.
 *
 * The server must be stopped. SQLite would let a second writer in, and handing
 * out a password while the old sessions are still live is not a recovery.
 */
function openWorkspace(dataDir: string) {
  const path = join(dataDir, "workspace.db");
  if (!existsSync(path)) {
    throw new Error(`No workspace found at ${path}. Check --data points at the data directory.`);
  }
  return openDb(path);
}

export function listAccounts(dataDir: string): RecoverableAccount[] {
  const db = openWorkspace(dataDir);
  try {
    const store = new Store(db);
    return store
      .listUsers()
      .filter((user) => !user.isBot)
      .map((user) => ({
        handle: user.handle,
        displayName: user.displayName,
        role: user.role,
        deactivated: user.deactivated,
        mustChangePassword: store.mustChangePassword(user.id),
      }));
  } finally {
    db.close();
  }
}

/**
 * Issues a one-time password for an account and ends its sessions. The account
 * cannot use the workspace again until it chooses its own password, so a
 * password typed into a terminal and read aloud cannot become a lasting one.
 */
export async function recoverAccount(opts: {
  dataDir: string;
  handle: string;
  /** Also make this account the owner. For a workspace whose owner is gone. */
  makeOwner?: boolean;
}): Promise<{ temporaryPassword: string; role: string; revokedSessions: number }> {
  const db = openWorkspace(opts.dataDir);
  try {
    const store = new Store(db);
    const user = store.getUserAuthByHandle(opts.handle);
    if (!user) throw new Error(`No account with the handle "${opts.handle}".`);
    if (user.isBot)
      throw new Error(`"${opts.handle}" is an app, which has a token rather than a password.`);

    const temporaryPassword = secretToken().slice(0, 16);
    const credentials = await hashPassword(temporaryPassword);
    const { revoked, role } = store.transaction(() => {
      store.setPassword(user.id, credentials.hash, credentials.salt, true);
      // Recovery is pointless if the account cannot sign in at all.
      if (user.deactivated) store.updateUser(user.id, { deactivated: false });
      if (opts.makeOwner) {
        // The existing owner steps down to admin rather than out, matching what
        // an ordinary ownership transfer does.
        for (const other of store.listUsers()) {
          if (other.role === "owner" && other.id !== user.id) {
            store.updateUser(other.id, { role: "admin" });
          }
        }
        store.updateUser(user.id, { role: "owner" });
      }
      return {
        revoked: store.revokeSessions(user.id).length,
        role: store.getUser(user.id)!.role,
      };
    });
    return { temporaryPassword, role, revokedSessions: revoked };
  } finally {
    db.close();
  }
}
