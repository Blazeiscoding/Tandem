// The apps build this package with Vite, which turns these imports into a
// file's address (`?url`) or its bytes as a data URL (`?inline`).
declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
