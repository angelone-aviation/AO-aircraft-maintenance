/**
 * Responsibility: Make and model field that suggests FAA DRS names and the
 *   names already recorded on the program's aircraft and components.
 * Layer: UI. Reads the workspace snapshot; writes nothing.
 * Dependencies: @phosphor-icons/react, src/data/drsCatalog.json (DRS
 *   names), src/data/store.ts (useWorkspace), src/domain/model.ts (Snapshot
 *   type), drsComboBox.css.
 *
 * Any text is accepted: a name outside the DRS list can still be saved and
 * searched, and the field says so.
 */
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { CaretDown } from "@phosphor-icons/react";
import catalog from "../data/drsCatalog.json";
import { useWorkspace } from "../data/store";
import type { Snapshot } from "../domain/model";
import "./drsComboBox.css";

const MAX_SUGGESTIONS = 40;
const CARET_SIZE = 14;
const CUSTOM_ENTRY = "Use custom entry";

type SuggestionKind = "makes" | "models";
type Suggestion = { value: string; source: string };
type ComboBox = ReturnType<typeof useComboBox>;
type ListControl = Pick<ComboBox, "open" | "active" | "choices" | "select"> & {
  setOpen: (open: boolean) => void;
  setActive: (update: (index: number) => number) => void;
};
type DrsComboBoxProps = {
  kind: SuggestionKind;
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  maxLength?: number;
  "aria-describedby"?: string;
};

/**
 * Make or model field with a WAI-ARIA combobox list of FAA DRS names and
 * names recorded in the program, then the typed text as a custom entry. A
 * note under the field names where the current text comes from.
 *
 * @param props.kind - Whether to suggest makes or models.
 * @param props.value - Controlled text; without it the field keeps its own,
 *   starting at `defaultValue` ("" when omitted).
 * @param props.onChange - Called with the new text on each edit or pick.
 * @param props.maxLength - Longest text accepted; 150 when omitted.
 * @returns The field; `id`, `name`, `required` and `aria-describedby` go to
 *   its input, which gets a generated id when `id` is omitted.
 */
export function DrsComboBox(props: DrsComboBoxProps) {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  const combo = useComboBox(props);
  useScrollActiveOption(inputId, combo.open, combo.active);
  return (
    <div className="drs-combobox">
      <div className="drs-combobox-input">
        <input
          id={inputId}
          name={props.name}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={combo.open}
          aria-controls={`${inputId}-list`}
          aria-activedescendant={
            combo.open && combo.active >= 0
              ? optionId(inputId, combo.active)
              : undefined
          }
          aria-describedby={props["aria-describedby"]}
          autoComplete="off"
          value={combo.text}
          required={props.required}
          maxLength={props.maxLength ?? 150}
          {...combo.handlers}
        />
        <CaretDown
          className="drs-combobox-caret"
          size={CARET_SIZE}
          aria-hidden="true"
        />
      </div>
      {combo.text && <SourceNote exact={combo.exact} />}
      {combo.open && (
        <SuggestionMenu inputId={inputId} kind={props.kind} combo={combo} />
      )}
    </div>
  );
}

function useComboBox({
  kind,
  value,
  defaultValue = "",
  onChange,
}: DrsComboBoxProps) {
  const [local, setLocal] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const text = value ?? local;
  const suggestions = useSuggestions(kind);
  const { matchCount, exact, choices } = matchSuggestions(suggestions, text);
  function change(next: string) {
    setLocal(next);
    onChange?.(next);
    setActive(-1);
  }
  function select(next: string) {
    change(next);
    setOpen(false);
  }
  const list = { open, active, choices, select, setOpen, setActive };
  const handlers = {
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      change(event.target.value);
      setOpen(true);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) =>
      handleKeyDown(event, list),
  };
  return { text, open, active, matchCount, exact, choices, select, handlers };
}

function handleKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  list: ListControl,
): void {
  const { key } = event;
  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    list.setOpen(true);
    const step = key === "ArrowDown" ? 1 : -1;
    const last = list.choices.length - 1;
    list.setActive((i) => Math.max(0, Math.min(last, i + step)));
    return;
  }
  if (key === "Escape") {
    // Closes the list only, not an enclosing dialog.
    event.preventDefault();
    event.stopPropagation();
    list.setOpen(false);
    return;
  }
  const choice = list.active >= 0 ? list.choices[list.active] : undefined;
  if (key !== "Enter" || !list.open || !choice) return;
  event.preventDefault();
  list.select(choice.value);
}

function useScrollActiveOption(inputId: string, open: boolean, active: number) {
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(optionId(inputId, active))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, inputId]);
}

function useSuggestions(kind: SuggestionKind): Suggestion[] {
  const snapshot = useWorkspace((s) => s.snapshot);
  return useMemo(() => listSuggestions(kind, snapshot), [kind, snapshot]);
}

// A recorded name joins only when no DRS name matches it ignoring case, so
// the DRS spelling wins.
function listSuggestions(
  kind: SuggestionKind,
  snapshot: Snapshot | null,
): Suggestion[] {
  const known = new Map(
    catalog[kind].map((v) => [v.toLowerCase(), { value: v, source: "DRS" }]),
  );
  const recorded = [
    ...(snapshot?.aircraft ?? []).flatMap((a) =>
      kind === "makes" ? [a.make] : [a.model, a.faaSearchModel],
    ),
    ...(snapshot?.management ?? [])
      .filter((c) => c.kind === "component")
      .flatMap((c) =>
        kind === "makes" ? [c.manufacturer] : [c.model, c.faaSearchModel],
      ),
  ];
  for (const v of recorded)
    if (v?.trim() && !known.has(v.toLowerCase()))
      known.set(v.toLowerCase(), { value: v, source: "Custom" });
  return [...known.values()];
}

// Names that start with the typed text come first, then alphabetical.
function matchSuggestions(suggestions: Suggestion[], text: string) {
  const query = text.trim().toLowerCase();
  const startsWithQuery = (s: Suggestion) =>
    Number(s.value.toLowerCase().startsWith(query));
  const matches = suggestions
    .filter((s) => s.value.toLowerCase().includes(query))
    .sort(
      (a, b) =>
        startsWithQuery(b) - startsWithQuery(a) ||
        a.value.localeCompare(b.value),
    );
  const exact = suggestions.find((s) => s.value.toLowerCase() === query);
  const custom =
    query && !exact ? [{ value: text.trim(), source: CUSTOM_ENTRY }] : [];
  const choices = [...matches.slice(0, MAX_SUGGESTIONS), ...custom];
  return { matchCount: matches.length, exact, choices };
}

function SourceNote({ exact }: { exact?: Suggestion }) {
  return (
    <small>
      {exact?.source ?? "Custom"}
      {!exact ? " · Not in the DRS list; can still be saved and searched." : ""}
    </small>
  );
}

function SuggestionMenu({
  inputId,
  kind,
  combo,
}: {
  inputId: string;
  kind: SuggestionKind;
  combo: ComboBox;
}) {
  return (
    <div className="drs-combobox-menu">
      <div
        role="listbox"
        id={`${inputId}-list`}
        aria-label={`Suggested ${kind}`}
      >
        {combo.choices.map((o, i) => (
          <SuggestionOption
            key={`${o.source}:${o.value}`}
            id={optionId(inputId, i)}
            choice={o}
            selected={combo.active === i}
            onSelect={combo.select}
          />
        ))}
      </div>
      {combo.matchCount > MAX_SUGGESTIONS && (
        <small className="drs-combobox-hint">
          Showing {MAX_SUGGESTIONS} of {combo.matchCount} matches. Keep typing
          to narrow the list.
        </small>
      )}
    </div>
  );
}

function SuggestionOption({
  id,
  choice,
  selected,
  onSelect,
}: {
  id: string;
  choice: Suggestion;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  // Picks on mouse down with focus kept in the input: its blur would close
  // the list before a click landed.
  return (
    <div
      role="option"
      id={id}
      aria-selected={selected}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(choice.value);
      }}
    >
      {choice.source === CUSTOM_ENTRY ? `Use “${choice.value}”` : choice.value}
      <small>{choice.source}</small>
    </div>
  );
}

function optionId(inputId: string, index: number): string {
  return `${inputId}-option-${index}`;
}
