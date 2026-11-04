/**
 * Responsibility: The FAA airworthiness directive search and import window
 *   for one aircraft.
 * Layer: UI. Searches and imports through the workspace backend.
 * Dependencies: react, src/data (store, Backend type), src/domain (model,
 *   airworthiness, faaSearch), ./DrsComboBox, ./ui, ./faaSearch.css.
 */
import { DrsComboBox } from "./DrsComboBox";
import "./faaSearch.css";
import { useState } from "react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { can, type Snapshot } from "../domain/model";
import { adAircraftUuid, adNumber } from "../domain/airworthiness";
import {
  blankSearch,
  searchAssets,
  searchFilters,
  faaSearchSchema,
  type FaaSearchInput,
  type FaaSearchResult,
  type SearchAsset,
} from "../domain/faaSearch";
import { Field, Modal, errorText, safeHref } from "./ui";

// The AD import command takes at most 500 entries (adCommandSchema).
const MAX_IMPORT_ASSIGNMENTS = 500;
// FAA DRS document types: final-rule ADs and emergency ADs.
const FINAL_RULE_ADS = "ADFRAWD";
const EMERGENCY_ADS = "ADFREAD";

const DOCUMENT_FILTERS = [
  ["finalRules", "Final-rule ADs"],
  ["emergency", "Emergency ADs"],
  ["historical", "Include historical ADs"],
] as const;
const ADVANCED_FIELDS = [
  ["subject", "Subject"],
  ["productSubtype", "Product subtype"],
  ["amendment", "Amendment number"],
  ["docket", "Docket number"],
  ["affectedAD", "Affected AD"],
  ["supersededBy", "Superseded by AD"],
] as const;
const DATE_RANGE = [
  ["dateFrom", "Date from"],
  ["dateTo", "Date to"],
] as const;

type SearchRow = FaaSearchInput["assets"][number];
// Candidate id → ids of the assets ("" for the airframe) to receive the AD.
type Selection = Record<string, string[]>;
type FaaSearch = ReturnType<typeof useFaaSearch>;
type SearchProps = { search: FaaSearch };
type AssetProps = SearchProps & { asset: SearchAsset };
type RowProps = {
  asset: SearchAsset;
  row: SearchRow;
  edit: (patch: Partial<SearchRow>) => void;
};
type ResultProps = SearchProps & { result: FaaSearchResult };
type DialogProps = {
  aircraftUuid: string;
  onClose: () => void;
  onImported: (notice: string) => void;
};

/**
 * The "Search FAA ADs & Import" button and window for one aircraft: searches
 * FAA DRS with filters copied from the aircraft's and installed components'
 * profiles, then imports the chosen AD/asset assignments as Needs review.
 *
 * @param props.aircraftUuid - The aircraft to search for.
 * @returns The button, the import notice and, while open, the window. Search
 *   and import need maintenance permission, a connection and live mode.
 */
export function FaaSearchImport({ aircraftUuid }: { aircraftUuid: string }) {
  const { snapshot } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const imported = (message: string) => {
    setNotice(message);
    setOpen(false);
  };
  return (
    <>
      <button
        className="button primary"
        disabled={!can(snapshot!, aircraftUuid, "maintenance")}
        onClick={() => setOpen(true)}
      >
        Search FAA ADs &amp; Import
      </button>
      {notice && <p role="status">{notice}</p>}
      {open && (
        <FaaSearchDialog
          aircraftUuid={aircraftUuid}
          onClose={() => setOpen(false)}
          onImported={imported}
        />
      )}
    </>
  );
}

function FaaSearchDialog(props: DialogProps) {
  const { snapshot, demo } = useWorkspace();
  const search = useFaaSearch(props);
  const aircraft = snapshot!.aircraft.find(
    (a) => a.uuid === props.aircraftUuid,
  );
  return (
    <Modal
      wide
      title="Search FAA ADs & Import"
      onClose={() => !search.busy && props.onClose()}
    >
      <p>
        Aircraft: {aircraft?.registration}. Search values are copied from your
        profiles. Editing them here does not change the profiles.
      </p>
      {demo && (
        <p>
          Search is available on the connected app; demo mode cannot contact
          FAA.
        </p>
      )}
      <SearchForm search={search} />
      {search.results && (
        <SearchResults search={search} results={search.results} />
      )}
    </Modal>
  );
}

function useFaaSearch({ aircraftUuid, onImported }: DialogProps) {
  const { snapshot, backend, online, connected, demo } = useWorkspace();
  const assets = searchAssets(snapshot!, aircraftUuid);
  const [form, setForm] = useState(() => blankSearch(aircraftUuid, assets));
  const [results, setResults] = useState<FaaSearchResult[] | null>(null);
  const [selected, setSelected] = useState<Selection>({});
  const { run, setError, ...task } = useTask();
  const writable = can(snapshot!, aircraftUuid, "maintenance");
  const change = (next: FaaSearchInput) => {
    setForm(next);
    setResults(null);
    setSelected({});
    setError("");
  };
  return {
    ...task,
    assets,
    form,
    results,
    selected,
    setSelected,
    enabled: writable && online && connected && !demo,
    tracked: (number: string, id: string) =>
      isTracked(snapshot!, aircraftUuid, number, id),
    change,
    reset: () => change(blankSearch(aircraftUuid, assets)),
    find: () =>
      run(async () => {
        // A new search discards the previous results and assignments.
        change(form);
        setResults(await findADs(form, backend!));
      }),
    importSelected: () =>
      run(async () => {
        const entries = importEntries(results ?? [], selected, assets);
        await backend!.saveAD({ kind: "import", aircraftUuid, entries });
        onImported(importNotice(selected));
      }),
  };
}

function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function SearchForm({ search }: SearchProps) {
  const { busy, form } = search;
  return (
    <form
      className="faa-search-form"
      onSubmit={(e) => {
        e.preventDefault();
        void search.find();
      }}
    >
      <AssetList search={search} />
      <DocumentFilters search={search} />
      <AdvancedFilters search={search} />
      {search.error && <p role="alert">{search.error}</p>}
      <button
        className="button secondary"
        type="submit"
        disabled={busy || !search.enabled || !form.assets.length}
      >
        {busy ? "Working…" : "Search FAA"}
      </button>
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={search.reset}
      >
        Reset from profiles
      </button>
    </form>
  );
}

function AssetList({ search }: SearchProps) {
  return (
    <fieldset disabled={search.busy}>
      <legend>Aircraft and installed components</legend>
      <p>
        Select up to 20 assets per search. Model is the default filter.
        Manufacturer is optional because type-certificate ownership can change.
        Part numbers can be searched as keywords; serial numbers are shown for
        applicability review.
      </p>
      {search.assets.map((asset) => (
        <AssetFilters key={asset.id} asset={asset} search={search} />
      ))}
    </fieldset>
  );
}

function AssetFilters({ asset, search }: AssetProps) {
  const { form, change } = search;
  const row = form.assets.find((a) => a.id === asset.id);
  const setAssets = (assets: SearchRow[]) => change({ ...form, assets });
  const toggle = (checked: boolean) =>
    setAssets(
      checked
        ? [...form.assets, asset]
        : form.assets.filter((a) => a.id !== asset.id),
    );
  const edit = (patch: Partial<SearchRow>) =>
    setAssets(
      form.assets.map((a) => (a.id === asset.id ? { ...a, ...patch } : a)),
    );
  return (
    <fieldset>
      <legend>
        <label>
          <input
            type="checkbox"
            checked={!!row}
            onChange={(e) => toggle(e.target.checked)}
          />
          {asset.label}
        </label>
      </legend>
      <p>
        Product type: {asset.id === "" ? "Aircraft" : asset.section} · Serial:{" "}
        {asset.serial || "Not recorded"} · Part number:{" "}
        {asset.partNumber || "Not recorded"}
      </p>
      {row && (
        <div className="form-grid">
          <ModelFields asset={asset} row={row} edit={edit} />
          <KeywordFields asset={asset} row={row} edit={edit} />
        </div>
      )}
    </fieldset>
  );
}

function ModelFields({ asset, row, edit }: RowProps) {
  return (
    <>
      <Field label={`${asset.label} model`}>
        <DrsComboBox
          kind="models"
          value={row.model}
          onChange={(model) => edit({ model })}
        />
      </Field>
      <Field label={`${asset.label} manufacturer`}>
        <DrsComboBox
          kind="makes"
          value={row.make}
          onChange={(make) => edit({ make })}
        />
      </Field>
      <label>
        <input
          type="checkbox"
          checked={row.useMake}
          onChange={(e) => edit({ useMake: e.target.checked })}
        />
        Filter by manufacturer for {asset.label}
      </label>
    </>
  );
}

function KeywordFields({ asset, row, edit }: RowProps) {
  return (
    <>
      <Field label={`${asset.label} keywords / part number`}>
        <input
          value={row.keywords}
          onChange={(e) => edit({ keywords: e.target.value })}
        />
      </Field>
      {asset.partNumber && !row.keywords && (
        <button
          className="button secondary"
          type="button"
          onClick={() => edit({ keywords: asset.partNumber })}
        >
          Use part number as keyword for {asset.label}
        </button>
      )}
      {!row.model && !row.keywords && (
        <p role="alert">
          Model is missing. Enter a model, keyword, or specific AD number.
        </p>
      )}
    </>
  );
}

function DocumentFilters({ search: { busy, form, change } }: SearchProps) {
  return (
    <fieldset disabled={busy}>
      <legend>Documents to search</legend>
      {DOCUMENT_FILTERS.map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={form[key]}
            onChange={(e) => change({ ...form, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
      <Field label="Specific AD number (optional)">
        <input
          value={form.number}
          onChange={(e) => change({ ...form, number: e.target.value })}
        />
      </Field>
    </fieldset>
  );
}

function AdvancedFilters({ search: { busy, form, change } }: SearchProps) {
  return (
    <details>
      <summary>Advanced search</summary>
      <fieldset disabled={busy}>
        <p>
          All entered fields narrow the search together. FAA permits five
          filters per request, including status, product type, and each asset’s
          model/manufacturer/keyword filters.
        </p>
        <div className="form-grid">
          {ADVANCED_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                value={form[key]}
                onChange={(e) => change({ ...form, [key]: e.target.value })}
              />
            </Field>
          ))}
          <DateFilters form={form} change={change} />
        </div>
      </fieldset>
    </details>
  );
}

function DateFilters({ form, change }: Pick<FaaSearch, "form" | "change">) {
  return (
    <>
      <Field label="Date filter">
        <select
          value={form.dateField}
          onChange={(e) =>
            change({
              ...form,
              dateField: e.target.value as FaaSearchInput["dateField"],
            })
          }
        >
          <option value="effective">Effective date</option>
          <option value="issued">Issue date</option>
          <option value="published">Publication date</option>
        </select>
      </Field>
      {DATE_RANGE.map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            type="date"
            value={form[key]}
            onChange={(e) => change({ ...form, [key]: e.target.value })}
          />
        </Field>
      ))}
    </>
  );
}

function SearchResults({
  search,
  results,
}: SearchProps & { results: FaaSearchResult[] }) {
  const { busy, setSelected } = search;
  return (
    <section className="faa-search-results">
      <h3>{results.length} unique AD results</h3>
      <p>
        Matches require applicability review. Select the assets to receive each
        AD. Existing records will be updated without replacing compliance
        history. No deadlines or compliance are inferred from search results.
      </p>
      {!results.length && (
        <p>
          No matches. Try the FAA model designation or a broader model/series;
          clear manufacturer, keyword, or advanced filters if needed.
        </p>
      )}
      <button
        className="button secondary"
        disabled={busy || !results.length}
        onClick={() => setSelected(allMatches(results))}
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
      {results.map((result) => (
        <ResultCard key={result.candidate.id} result={result} search={search} />
      ))}
      <ImportButton search={search} />
    </section>
  );
}

function ResultCard({ result, search }: ResultProps) {
  const { source, status } = result.candidate;
  return (
    <fieldset disabled={search.busy}>
      <legend>
        AD {source.number} · {status}
        {result.documents.some((d) => d.emergency)
          ? " · Emergency document available"
          : ""}
      </legend>
      <p>{source.subject}</p>
      <p>
        Effective: {source.effective || "See FAA document"} · Make:{" "}
        {source.make} · Model: {source.model}
      </p>
      {result.documents.map((d, i) => (
        <a key={i} href={safeHref(d.url)} target="_blank" rel="noreferrer">
          {d.emergency ? "Open emergency AD" : "Open FAA final rule"}{" "}
        </a>
      ))}
      {search.form.assets.map((a) => (
        <AssignmentOption
          key={a.id}
          assetId={a.id}
          result={result}
          search={search}
        />
      ))}
    </fieldset>
  );
}

function AssignmentOption({
  assetId,
  result,
  search,
}: ResultProps & { assetId: string }) {
  const { selected } = search;
  const id = result.candidate.id;
  const chosen = selected[id] ?? [];
  const profile = search.assets.find((x) => x.id === assetId);
  const toggle = (checked: boolean) =>
    search.setSelected({
      ...selected,
      [id]: checked
        ? [...chosen, assetId]
        : chosen.filter((x) => x !== assetId),
    });
  return (
    <label>
      <input
        type="checkbox"
        checked={chosen.includes(assetId)}
        onChange={(e) => toggle(e.target.checked)}
      />
      {profile?.label} · S/N {profile?.serial || "Not recorded"} ·{" "}
      {result.assetIds.includes(assetId) ? "Matched" : "Manual assignment"} ·{" "}
      {search.tracked(result.candidate.source.number, assetId)
        ? "Already tracked — update"
        : "New record"}
    </label>
  );
}

function ImportButton({ search }: SearchProps) {
  const count = selectionCount(search.selected);
  return (
    <>
      <button
        className="button primary"
        disabled={
          search.busy ||
          !search.enabled ||
          count === 0 ||
          count > MAX_IMPORT_ASSIGNMENTS
        }
        onClick={() => void search.importSelected()}
      >
        Import selected ({count}) as Needs review
      </button>
      {count > MAX_IMPORT_ASSIGNMENTS && (
        <p role="alert">
          {`Select no more than ${MAX_IMPORT_ASSIGNMENTS} AD/asset assignments per import.`}
        </p>
      )}
    </>
  );
}

// Checks each asset's filters before calling FAA, so an asset without a model
// or keyword, or a sixth filter, is refused at once with the domain's message.
async function findADs(form: FaaSearchInput, backend: Backend) {
  const input = faaSearchSchema.parse(form);
  const type = input.finalRules ? FINAL_RULE_ADS : EMERGENCY_ADS;
  for (const asset of input.assets) searchFilters(input, asset, type);
  return backend.searchFAA(input);
}

function importEntries(
  results: FaaSearchResult[],
  selected: Selection,
  assets: SearchAsset[],
) {
  return results.flatMap((r) =>
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
}

function isTracked(
  snapshot: Snapshot,
  aircraftUuid: string,
  number: string,
  componentUuid: string,
) {
  return (snapshot.airworthiness ?? []).some(
    (r) =>
      adAircraftUuid(snapshot, r) === aircraftUuid &&
      r.componentUuid === componentUuid &&
      adNumber(r.source.number) === adNumber(number),
  );
}

const importNotice = (selected: Selection) =>
  `${selectionCount(selected)} AD/asset assignments imported. Review applicability and required actions.`;

const selectionCount = (selected: Selection) =>
  Object.values(selected).reduce((n, ids) => n + ids.length, 0);

const allMatches = (results: FaaSearchResult[]): Selection =>
  Object.fromEntries(results.map((r) => [r.candidate.id, r.assetIds]));
