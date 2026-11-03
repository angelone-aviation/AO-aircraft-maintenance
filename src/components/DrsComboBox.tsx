import { useEffect, useId, useMemo, useState } from "react";
import catalog from "../data/drsCatalog.json";
import { useWorkspace } from "../data/store";
import "./drsComboBox.css";

export function DrsComboBox({
  kind,
  id,
  name,
  value,
  defaultValue = "",
  onChange,
  required,
  maxLength = 150,
  "aria-describedby": describedBy,
}: {
  kind: "makes" | "models";
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  maxLength?: number;
  "aria-describedby"?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [local, setLocal] = useState(defaultValue);
  const text = value ?? local;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${inputId}-option-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, inputId]);
  const snapshot = useWorkspace((s) => s.snapshot);
  const options = useMemo(() => {
    const known = new Map(
      catalog[kind].map((v) => [v.toLowerCase(), { value: v, source: "DRS" }]),
    );
    const custom = [
      ...(snapshot?.aircraft ?? []).flatMap((a) =>
        kind === "makes" ? [a.make] : [a.model, a.faaSearchModel],
      ),
      ...(snapshot?.management ?? [])
        .filter((c) => c.kind === "component")
        .flatMap((c) =>
          kind === "makes" ? [c.manufacturer] : [c.model, c.faaSearchModel],
        ),
    ];
    for (const v of custom)
      if (v?.trim() && !known.has(v.toLowerCase()))
        known.set(v.toLowerCase(), { value: v, source: "Custom" });
    return [...known.values()];
  }, [kind, snapshot]);
  const query = text.trim().toLowerCase();
  const filtered = options
    .filter((o) => o.value.toLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(b.value.toLowerCase().startsWith(query)) -
          Number(a.value.toLowerCase().startsWith(query)) ||
        a.value.localeCompare(b.value),
    );
  const matches = filtered.slice(0, 40);
  const exact = options.find((o) => o.value.toLowerCase() === query);
  const choices = [
    ...matches,
    ...(query && !exact
      ? [{ value: text.trim(), source: "Use custom entry" }]
      : []),
  ];
  function change(next: string) {
    setLocal(next);
    onChange?.(next);
    setActive(-1);
  }
  function select(next: string) {
    change(next);
    setOpen(false);
  }
  return (
    <div className="drs-combobox">
      <div className="drs-combobox-input">
        <input
          id={inputId}
          name={name}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${inputId}-list`}
          aria-activedescendant={
            open && active >= 0 ? `${inputId}-option-${active}` : undefined
          }
          aria-describedby={describedBy}
          autoComplete="off"
          value={text}
          required={required}
          maxLength={maxLength}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            change(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((i) =>
                Math.max(
                  0,
                  Math.min(
                    choices.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            if (e.key === "Enter" && open && active >= 0 && choices[active]) {
              e.preventDefault();
              select(choices[active].value);
            }
          }}
        />
        <span aria-hidden="true" />
      </div>
      {text && (
        <small>
          {exact?.source ?? "Custom"}
          {!exact
            ? " · Not in the DRS list; can still be saved and searched."
            : ""}
        </small>
      )}
      {open && (
        <div className="drs-combobox-menu">
          <div
            role="listbox"
            id={`${inputId}-list`}
            aria-label={`Suggested ${kind}`}
          >
            {choices.map((o, i) => (
              <div
                role="option"
                id={`${inputId}-option-${i}`}
                aria-selected={active === i}
                key={`${o.source}:${o.value}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(o.value);
                }}
              >
                {o.source === "Use custom entry" ? `Use “${o.value}”` : o.value}
                <small>{o.source}</small>
              </div>
            ))}
          </div>
          {filtered.length > 40 && (
            <small className="drs-combobox-hint">
              Showing 40 of {filtered.length} matches. Keep typing to narrow the
              list.
            </small>
          )}
        </div>
      )}
    </div>
  );
}
