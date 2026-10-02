/**
 * The server's version, kept apart from the server itself so that what only
 * needs to name it (a backup's manifest, a discovery announcement) does not
 * load the HTTP server, sockets and discovery to do so (REV-07).
 */
export const SERVER_VERSION = "0.1.0";
