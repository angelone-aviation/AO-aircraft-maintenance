/**
 * Responsibility: The Work orders navigation icon: a work sheet with a
 *   folded corner and a wrench.
 * Layer: UI. Presentational SVG; no state or data access.
 * Dependencies: @phosphor-icons/react (IconWeight type only).
 */
import type { IconWeight } from "@phosphor-icons/react";

/**
 * Work orders icon that takes Phosphor's `size` and `weight` props, so it can
 * stand in wherever a Phosphor icon component is expected.
 *
 * @param props.size - Width and height; 18 when omitted.
 * @param props.weight - `bold` thickens the stroke, `light` and `thin` thin
 *   it, `duotone` tints the sheet; any other weight draws as `regular`.
 * @returns An SVG that is always hidden from assistive technology: the
 *   `aria-hidden` prop is accepted for Phosphor compatibility and ignored.
 */
export function WorkOrderIcon({
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

function strokeWidthFor(weight: IconWeight): number {
  if (weight === "bold") return 2.2;
  if (weight === "light" || weight === "thin") return 1.2;
  return 1.6;
}
