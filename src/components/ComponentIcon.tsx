/**
 * Responsibility: The Components navigation icon, a three-blade propeller
 *   drawn to stand in for a Phosphor icon.
 * Layer: UI. Presentational SVG; no state.
 * Dependencies: @phosphor-icons/react (IconWeight type).
 */
import type { IconWeight } from "@phosphor-icons/react";

const BLADE_PATH =
  "M11.4 10.8C10.9 8 10.8 3.5 11.2 1.2C14.4 3.2 15.4 8.2 12.8 10.8";

/**
 * A propeller outline that takes Phosphor's `size` and `weight` props, so
 * navigation renders it like any Phosphor icon. Always hidden from assistive
 * technology: `aria-hidden` is accepted and ignored.
 *
 * @param props.size - Width and height; defaults to 18.
 * @param props.weight - bold thickens the stroke, light and thin thin it,
 *   duotone adds a tinted disc, and fill draws as regular.
 * @returns An inline SVG on a 24-unit grid, stroked in `currentColor`.
 */
export function ComponentIcon({
  size = 18,
  weight = "regular",
}: {
  size?: number | string;
  weight?: IconWeight;
  "aria-hidden"?: boolean | "true" | "false";
}) {
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
      {weight === "duotone" && (
        <circle
          cx="12"
          cy="13"
          r="8"
          fill="currentColor"
          opacity={0.2}
          stroke="none"
        />
      )}
      <path d={BLADE_PATH} />
      <path d={BLADE_PATH} transform="rotate(120 12 13)" />
      <path d={BLADE_PATH} transform="rotate(240 12 13)" />
      <circle cx="12" cy="13" r="2.3" />
      <circle cx="12" cy="13" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function strokeWidthFor(weight: IconWeight): number {
  if (weight === "bold") return 2.2;
  if (weight === "light" || weight === "thin") return 1.2;
  return 1.6;
}
