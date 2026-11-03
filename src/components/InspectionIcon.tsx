import type { IconWeight } from "@phosphor-icons/react";
// Custom outline icon in the Phosphor style: accepts the same size/weight
// props (regular, bold, duotone; other weights render as regular).
export function InspectionIcon({
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
      {/* Flight Plans airplane, with the runway line omitted. */}
      <path
        transform="translate(0 -1) scale(.9)"
        d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"
      />
      <circle
        cx="16"
        cy="17"
        r="4"
        fill={duotone ? "currentColor" : "none"}
        fillOpacity={duotone ? 0.2 : undefined}
      />
      <path d="m19 20 2 2" />
    </svg>
  );
}
