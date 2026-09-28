/** The backup, on a worker thread, as the desktop app now runs it. See measure-stall.mts. */
import { parentPort, workerData } from "node:worker_threads";
import { backupWorkspace } from "../packages/server/src/index.js";

await backupWorkspace(workerData as { dataDir: string; out: string });
parentPort!.postMessage("done");
