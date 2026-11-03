import { ATA_GROUPS, type AtaChapter } from "../domain/ata";
import { Field } from "./ui";
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
