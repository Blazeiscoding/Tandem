import type { CSSProperties } from "react";

const paths = {
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "m21 21-5-5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  hash: "m10 3-4 18M18 3l-4 18M4 9h17M3 15h17",
  friends:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  pin: "m16 3 5 5-4 1-4 5v4l-7-7h4l5-4zM9 15l-6 6",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2",
  attach: "m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 6",
  send: "m22 2-7 20-4-9-9-4zM22 2 11 13",
  headphones: "M3 14v-3a9 9 0 0 1 18 0v3M3 13h4v8H3zM17 13h4v8h-4z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
} as const;

/** Small inline vectors: no icon font, network request, or runtime dependency. */
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="40" height="40" rx="12" fill="currentColor" className="text-copper" />
      <path
        d="M12 13h16M12 20h11M12 27h16M28 20v7"
        stroke="var(--color-ground)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
