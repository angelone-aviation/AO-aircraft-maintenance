import type { IconWeight } from "@phosphor-icons/react";
// Custom outline icon in the Phosphor style: accepts the same size/weight
// props (regular, bold, duotone; other weights render as regular).
export function ComponentIcon({
  size = 18,
  weight = "regular",
}: {
  size?: number | string;
  weight?: IconWeight;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  const stroke =
    weight === "bold"
      ? 2.2
      : weight === "light" || weight === "thin"
        ? 1.2
        : 1.6;
  const duotone = weight === "duotone";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {duotone && (
        <circle
          cx="12"
          cy="13"
          r="8"
          fill="currentColor"
          opacity={0.2}
          stroke="none"
        />
      )}
      <path d="M11.4 10.8C10.9 8 10.8 3.5 11.2 1.2C14.4 3.2 15.4 8.2 12.8 10.8" />
      <path
        d="M11.4 10.8C10.9 8 10.8 3.5 11.2 1.2C14.4 3.2 15.4 8.2 12.8 10.8"
        transform="rotate(120 12 13)"
      />
      <path
        d="M11.4 10.8C10.9 8 10.8 3.5 11.2 1.2C14.4 3.2 15.4 8.2 12.8 10.8"
        transform="rotate(240 12 13)"
      />
      <circle cx="12" cy="13" r="2.3" />
      <circle cx="12" cy="13" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
