import { freshBuilds } from "./fresh-builds";

// The browser tests launch the CLI bundle, which serves the client beside it.
export default freshBuilds("server");
