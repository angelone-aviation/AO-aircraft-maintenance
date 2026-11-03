/**
 * Responsibility: The mission verse on the welcome screen.
 * Layer: UI. Static markup; no state or data access.
 * Dependencies: none; styled by `.mission-slogan` in src/styles.css.
 */

/**
 * The mission verse, Proverbs 22:29, as a quotation with its citation.
 *
 * @returns A `blockquote.mission-slogan` holding the verse and a `cite`.
 */
export function MissionSlogan() {
  return (
    <blockquote className="mission-slogan">
      <p>
        “Do you see a man who is diligent in his work? He will stand before
        kings;”
      </p>
      <cite>Proverbs 22:29</cite>
    </blockquote>
  );
}
