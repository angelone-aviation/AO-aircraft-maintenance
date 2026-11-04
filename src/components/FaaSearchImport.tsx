/**
 * Responsibility: The FAA airworthiness directive search and import window
 *   for one aircraft.
 * Layer: UI. React component; searches and imports through the workspace
 *   backend.
 * Dependencies: react, src/data/store.ts, src/domain (model, airworthiness,
 *   faaSearch), ./DrsComboBox, ./ui, ./faaSearch.css.
 */
import { DrsComboBox } from "./DrsComboBox";
import "./faaSearch.css";
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { adAircraftUuid, adNumber } from "../domain/airworthiness";
import {
  blankSearch,
  searchAssets,
  searchFilters,
  faaSearchSchema,
  type FaaSearchInput,
  type FaaSearchResult,
} from "../domain/faaSearch";
import { Field, Modal, errorText, safeHref } from "./ui";
export function FaaSearchImport({ aircraftUuid }: { aircraftUuid: string }) {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const state = s!;
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [form, setForm] = useState<FaaSearchInput>(() =>
    blankSearch(aircraftUuid, searchAssets(state, aircraftUuid)),
  );
  const [results, setResults] = useState<FaaSearchResult[] | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const assets = searchAssets(state, aircraftUuid);
  const writable = can(state, aircraftUuid, "maintenance");
  const enabled = writable && online && connected && !demo;
  const change = (next: FaaSearchInput) => {
    setForm(next);
    setResults(null);
    setSelected({});
    setError("");
  };
  const tracked = (number: string, id: string) =>
    (state.airworthiness ?? []).some(
      (r) =>
        adAircraftUuid(state, r) === aircraftUuid &&
        r.componentUuid === id &&
        adNumber(r.source.number) === adNumber(number),
    );
  const count = Object.values(selected).reduce((n, a) => n + a.length, 0);
  const importEntries = () =>
    (results ?? []).flatMap((r) =>
      (selected[r.candidate.id] ?? []).map((id) => {
        const asset = assets.find((a) => a.id === id);
        if (!asset)
          throw Error(
            "An assigned component is no longer installed. Search again.",
          );
        return {
          componentUuid: id,
          source: { ...r.candidate.source, section: asset.section },
        };
      }),
    );
  return (
    <>
      <button
        className="button primary"
        disabled={!writable}
        onClick={() => {
          setForm(blankSearch(aircraftUuid, assets));
          setResults(null);
          setSelected({});
          setError("");
          setOpen(true);
        }}
      >
        Search FAA ADs &amp; Import
      </button>
      {notice && <p role="status">{notice}</p>}
      {open && (
        <Modal
          wide
          title="Search FAA ADs & Import"
          onClose={() => !busy && setOpen(false)}
        >
          <p>
            Aircraft:{" "}
            {state.aircraft.find((a) => a.uuid === aircraftUuid)?.registration}.
            Search values are copied from your profiles. Editing them here does
            not change the profiles.
          </p>
          {demo && (
            <p>
              Search is available on the connected app; demo mode cannot contact
              FAA.
            </p>
          )}
          <form
            className="faa-search-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setResults(null);
              setSelected({});
              setBusy(true);
              try {
                const input = faaSearchSchema.parse(form);
                for (const a of input.assets)
                  searchFilters(
                    input,
                    a,
                    input.finalRules ? "ADFRAWD" : "ADFREAD",
                  );
                setResults(await backend!.searchFAA(input));
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              <legend>Aircraft and installed components</legend>
              <p>
                Select up to 20 assets per search. Model is the default filter.
                Manufacturer is optional because type-certificate ownership can
                change. Part numbers can be searched as keywords; serial numbers
                are shown for applicability review.
              </p>
              {assets.map((asset) => {
                const row = form.assets.find((a) => a.id === asset.id);
                const edit = (
                  key: "model" | "make" | "keywords" | "useMake",
                  value: string | boolean,
                ) =>
                  change({
                    ...form,
                    assets: form.assets.map((a) =>
                      a.id === asset.id ? { ...a, [key]: value } : a,
                    ),
                  });
                return (
                  <fieldset key={asset.id}>
                    <legend>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!row}
                          onChange={(e) =>
                            change({
                              ...form,
                              assets: e.target.checked
                                ? [...form.assets, asset]
                                : form.assets.filter((a) => a.id !== asset.id),
                            })
                          }
                        />
                        {asset.label}
                      </label>
                    </legend>
                    <p>
                      Product type:{" "}
                      {asset.id === "" ? "Aircraft" : asset.section} · Serial:{" "}
                      {asset.serial || "Not recorded"} · Part number:{" "}
                      {asset.partNumber || "Not recorded"}
                    </p>
                    {row && (
                      <div className="form-grid">
                        <Field label={`${asset.label} model`}>
                          <DrsComboBox
                            kind="models"
                            value={row.model}
                            onChange={(value) => edit("model", value)}
                          />
                        </Field>
                        <Field label={`${asset.label} manufacturer`}>
                          <DrsComboBox
                            kind="makes"
                            value={row.make}
                            onChange={(value) => edit("make", value)}
                          />
                        </Field>
                        <label>
                          <input
                            type="checkbox"
                            checked={row.useMake}
                            onChange={(e) => edit("useMake", e.target.checked)}
                          />
                          Filter by manufacturer for {asset.label}
                        </label>
                        <Field label={`${asset.label} keywords / part number`}>
                          <input
                            value={row.keywords}
                            onChange={(e) => edit("keywords", e.target.value)}
                          />
                        </Field>
                        {asset.partNumber && !row.keywords && (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => edit("keywords", asset.partNumber)}
                          >
                            Use part number as keyword for {asset.label}
                          </button>
                        )}
                        {!row.model && !row.keywords && (
                          <p role="alert">
                            Model is missing. Enter a model, keyword, or
                            specific AD number.
                          </p>
                        )}
                      </div>
                    )}
                  </fieldset>
                );
              })}
            </fieldset>
            <fieldset disabled={busy}>
              <legend>Documents to search</legend>
              <label>
                <input
                  type="checkbox"
                  checked={form.finalRules}
                  onChange={(e) =>
                    change({ ...form, finalRules: e.target.checked })
                  }
                />
                Final-rule ADs
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.emergency}
                  onChange={(e) =>
                    change({ ...form, emergency: e.target.checked })
                  }
                />
                Emergency ADs
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.historical}
                  onChange={(e) =>
                    change({ ...form, historical: e.target.checked })
                  }
                />
                Include historical ADs
              </label>
              <Field label="Specific AD number (optional)">
                <input
                  value={form.number}
                  onChange={(e) => change({ ...form, number: e.target.value })}
                />
              </Field>
            </fieldset>
            <details>
              <summary>Advanced search</summary>
              <fieldset disabled={busy}>
                <p>
                  All entered fields narrow the search together. FAA permits
                  five filters per request, including status, product type, and
                  each asset’s model/manufacturer/keyword filters.
                </p>
                <div className="form-grid">
                  {(
                    [
                      ["subject", "Subject"],
                      ["productSubtype", "Product subtype"],
                      ["amendment", "Amendment number"],
                      ["docket", "Docket number"],
                      ["affectedAD", "Affected AD"],
                      ["supersededBy", "Superseded by AD"],
                    ] as const
                  ).map(([key, label]) => (
                    <Field key={key} label={label}>
                      <input
                        value={form[key]}
                        onChange={(e) =>
                          change({ ...form, [key]: e.target.value })
                        }
                      />
                    </Field>
                  ))}
                  <Field label="Date filter">
                    <select
                      value={form.dateField}
                      onChange={(e) =>
                        change({
                          ...form,
                          dateField: e.target
                            .value as FaaSearchInput["dateField"],
                        })
                      }
                    >
                      <option value="effective">Effective date</option>
                      <option value="issued">Issue date</option>
                      <option value="published">Publication date</option>
                    </select>
                  </Field>
                  <Field label="Date from">
                    <input
                      type="date"
                      value={form.dateFrom}
                      onChange={(e) =>
                        change({ ...form, dateFrom: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Date to">
                    <input
                      type="date"
                      value={form.dateTo}
                      onChange={(e) =>
                        change({ ...form, dateTo: e.target.value })
                      }
                    />
                  </Field>
                </div>
              </fieldset>
            </details>
            {error && <p role="alert">{error}</p>}
            <button
              className="button secondary"
              type="submit"
              disabled={busy || !enabled || !form.assets.length}
            >
              {busy ? "Working…" : "Search FAA"}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => change(blankSearch(aircraftUuid, assets))}
            >
              Reset from profiles
            </button>
          </form>
          {results && (
            <section className="faa-search-results">
              <h3>{results.length} unique AD results</h3>
              <p>
                Matches require applicability review. Select the assets to
                receive each AD. Existing records will be updated without
                replacing compliance history. No deadlines or compliance are
                inferred from search results.
              </p>
              {!results.length && (
                <p>
                  No matches. Try the FAA model designation or a broader
                  model/series; clear manufacturer, keyword, or advanced filters
                  if needed.
                </p>
              )}
              <button
                className="button secondary"
                disabled={busy || !results.length}
                onClick={() =>
                  setSelected(
                    Object.fromEntries(
                      results.map((r) => [r.candidate.id, r.assetIds]),
                    ),
                  )
                }
              >
                Select all matched assets
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setSelected({})}
              >
                Clear selection
              </button>
              {results.map((r) => (
                <fieldset key={r.candidate.id} disabled={busy}>
                  <legend>
                    AD {r.candidate.source.number} · {r.candidate.status}
                    {r.documents.some((d) => d.emergency)
                      ? " · Emergency document available"
                      : ""}
                  </legend>
                  <p>{r.candidate.source.subject}</p>
                  <p>
                    Effective:{" "}
                    {r.candidate.source.effective || "See FAA document"} · Make:{" "}
                    {r.candidate.source.make} · Model:{" "}
                    {r.candidate.source.model}
                  </p>
                  {r.documents.map((d, i) => (
                    <a
                      key={i}
                      href={safeHref(d.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {d.emergency
                        ? "Open emergency AD"
                        : "Open FAA final rule"}{" "}
                    </a>
                  ))}
                  {form.assets.map((a) => {
                    const profile = assets.find((x) => x.id === a.id);
                    return (
                      <label key={a.id}>
                        <input
                          type="checkbox"
                          checked={(selected[r.candidate.id] ?? []).includes(
                            a.id,
                          )}
                          onChange={(e) =>
                            setSelected({
                              ...selected,
                              [r.candidate.id]: e.target.checked
                                ? [...(selected[r.candidate.id] ?? []), a.id]
                                : (selected[r.candidate.id] ?? []).filter(
                                    (id) => id !== a.id,
                                  ),
                            })
                          }
                        />
                        {profile?.label} · S/N{" "}
                        {profile?.serial || "Not recorded"} ·{" "}
                        {r.assetIds.includes(a.id)
                          ? "Matched"
                          : "Manual assignment"}{" "}
                        ·{" "}
                        {tracked(r.candidate.source.number, a.id)
                          ? "Already tracked — update"
                          : "New record"}
                      </label>
                    );
                  })}
                </fieldset>
              ))}
              <button
                className="button primary"
                disabled={busy || !enabled || count === 0 || count > 500}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await backend!.saveAD({
                      kind: "import",
                      aircraftUuid,
                      entries: importEntries(),
                    });
                    setNotice(
                      `${count} AD/asset assignments imported. Review applicability and required actions.`,
                    );
                    setOpen(false);
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Import selected ({count}) as Needs review
              </button>
              {count > 500 && (
                <p role="alert">
                  Select no more than 500 AD/asset assignments per import.
                </p>
              )}
            </section>
          )}
        </Modal>
      )}
    </>
  );
}
