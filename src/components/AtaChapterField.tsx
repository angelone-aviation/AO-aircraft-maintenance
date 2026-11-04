/**
 * Responsibility: The ATA chapter picker that record forms share.
 * Layer: UI. React component; the chapter list comes from the domain.
 * Dependencies: src/domain/ata.ts, ./ui.tsx.
 */
import { ATA_GROUPS, type AtaChapter } from "../domain/ata";
import { Field } from "./ui";

/**
 * An uncontrolled select, grouped as ATA_GROUPS is, that submits as
 * `ataChapter`: a chapter code, or "" for Unassigned.
 *
 * @param props.initial - The chapter selected at first; Unassigned without one.
 */
export function AtaChapterField({ initial }: { initial?: AtaChapter }) {
  return (
    <Field label="ATA Chapter">
      <select name="ataChapter" defaultValue={initial ?? ""}>
        <option value="">Unassigned</option>
        {ATA_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.chapters.map(([code, name]) => (
              <option key={code} value={code}>
                ATA {code}: {name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
