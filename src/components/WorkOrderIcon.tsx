import type { IconWeight } from "@phosphor-icons/react";
// Custom outline icon in the Phosphor style: accepts the same size/weight
// props (regular, bold, duotone; other weights render as regular).
export function WorkOrderIcon({
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
        <path
          d="M3 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3l-8 14H7l-4-4z"
          fill="currentColor"
          opacity={0.2}
          stroke="none"
        />
      )}
      <path d="M9.5 21H7l-4-4V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M3 17h4v4M6 6h10M6 10h7M6 14h4.5" />
      <path
        d="M20.7 10.2a3.4 3.4 0 0 1-3.9 4.9l-3.2 6a1.5 1.5 0 0 1-2.6-1.5l3.5-5.8a3.4 3.4 0 0 1 2.6-5.5l-1.4 2.4 2.5 1.4z"
        fill="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
