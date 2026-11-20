/**
 * Responsibility: Each Flight Program's fair share of an allowance every
 *   program draws on, such as a provider's daily quota or the urgent emails.
 * Layer: Domain. A pure function; no I/O, no React.
 * Dependencies: none.
 *
 * An equal split is the plainest fair rule, since every program counts
 * alike. The total stays its own limit, checked beside each share: once the
 * floor lifts the shares, they add up to more than the total, so a share
 * bounds what one program can take rather than promising it.
 */

/**
 * A Flight Program's share of an allowance: an equal split between the
 * programs, rounded down, never below `floor`.
 *
 * @param total - The deployment-wide allowance per window.
 * @param programs - How many Flight Programs share it; none counts as one.
 * @param floor - The least share any program gets.
 * @returns Uses allowed to one program per window.
 */
export function programShare(
  total: number,
  programs: number,
  floor: number,
): number {
  return Math.max(floor, Math.floor(total / Math.max(1, programs)));
}
