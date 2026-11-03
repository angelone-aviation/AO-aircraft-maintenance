/**
 * Responsibility: The Inspections navigation icon: an airplane under a
 *   magnifying glass.
 * Layer: UI. Presentational SVG; no state or data access.
 * Dependencies: @phosphor-icons/react (IconWeight type only).
 */
import type { IconWeight } from "@phosphor-icons/react";

/**
 * Inspections icon that takes Phosphor's `size` and `weight` props, so it can
 * stand in wherever a Phosphor icon component is expected.
 *
 * @param props.size - Width and height; 18 when omitted.
 * @param props.weight - `bold` thickens the stroke, `light` and `thin` thin
 *   it, `duotone` tints the lens; any other weight draws as `regular`.
 * @returns An SVG that is always hidden from assistive technology: the
 *   `aria-hidden` prop is accepted for Phosphor compatibility and ignored.
 */
export function InspectionIcon({
  size = 18,
  weight = "regular",
}: {
  size?: number | string;
  weight?: IconWeight;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  const duotone = weight === "duotone";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidthFor(weight)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The airplane from Lucide's plane-takeoff, the Flight plans icon
          before the move to Phosphor, without its runway line. */}
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

function strokeWidthFor(weight: IconWeight): number {
  if (weight === "bold") return 2.2;
  if (weight === "light" || weight === "thin") return 1.2;
  return 1.6;
}
