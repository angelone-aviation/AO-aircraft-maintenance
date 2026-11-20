/**
 * Responsibility: Pages a list's older history for a screen, loads one older
 *   work order or records named by uuid on demand, and merges what is loaded
 *   with the workspace snapshot for the screen's records.
 * Layer: Data. React hooks and a context over the workspace store and
 *   Backend; renders nothing.
 * Dependencies: react, ./store, ./backend (types), ./errors, src/domain
 *   (retention, historyReads, model types).
 *
 * Older records come only through Backend.historyPage and workOrderHistory,
 * which the server checks (ADR-0013). They are not reactive and live only in
 * memory: dropped on a program switch or sign-out, and reloaded after any
 * write of their kind, so an edited older record never shows a stale copy,
 * and when the workspace's window moves a day, so a record leaving it is
 * never in neither.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useWorkspace } from "./store";
import type { Backend } from "./backend";
import { errorText } from "./errors";
import {
  emptyHistoryRecords,
  HISTORY_PAGE_SIZE,
  retentionCutoff,
  type HistoryKind,
  type HistoryPage,
  type HistoryPageRequest,
  type HistoryRecords,
} from "../domain/retention";
import type {
  FoundRecords,
  RecordLookup,
  WorkOrderHistory,
} from "../domain/historyReads";
import type { Flight, Member, Snapshot } from "../domain/model";
import type { RequestPurchase, RequestSource } from "../domain/partsRequests";

/** One list of older history, with the filters the server applies. */
export interface HistoryList {
  kind: HistoryKind;
  /** One aircraft; every aircraft the user may read when absent. Ignored
   * for purchase orders, which belong to no aircraft. */
  aircraftUuid?: string;
  /** Flights only: one status (H2). Ignored for the other lists. */
  status?: Flight["status"];
  /** Parts requests only: one record's list (requestMatchesSource). */
  source?: RequestSource;
  /** Purchase orders only: one vendor's, matched as vendorKey matches. */
  vendor?: string;
}

/** A list's older history as loaded so far, in page order. */
export interface LoadedHistory {
  records: HistoryRecords;
  /** The members the rows name, for their names. */
  members: Member[];
  /** Pages loaded; a reload asks for as many again. */
  pages: number;
  /** Where the next page starts; null before the first. */
  cursor: string | null;
  /** True once the server has no older row left. */
  isDone: boolean;
}

/** What a screen shows of a list's older history, and how to load more. */
export interface HistoryPages extends LoadedHistory {
  loading: boolean;
  /** The last load's failure, as the user should read it; "" otherwise. */
  error: string;
  /** No connection: nothing older can load. */
  offline: boolean;
  /** Loads the next page; does nothing offline, while loading or when done. */
  loadOlder(): void;
}

/** Rows that can join a snapshot: pages, and work orders loaded whole. */
export type HistoryRows = Partial<
  HistoryRecords &
    Pick<
      WorkOrderHistory,
      "taskEvidence" | "workOrderAttachments" | "partsRequests"
    >
> & { members?: Member[] };

// Purchase allocations carry no uuid: one is its order, line and request.
type PurchaseKey = Pick<RequestPurchase, "poUuid" | "requestUuid" | "lineUuid">;

/** One pager's state, for {@link historyPager}'s subscribers. */
export interface HistoryPagerState {
  /** The program and list the pages belong to ({@link historyScope}). */
  scope: string;
  /** The write mark the pages were loaded at ({@link historyWriteMark}). */
  mark: string | undefined;
  loaded: LoadedHistory;
  loading: boolean;
  error: string;
}

/** What the workspace says to a pager on each change. */
export interface HistoryPagerSync {
  scope: string;
  mark: string | undefined;
  /** Connected with a backend: pages can load. */
  live: boolean;
}

/** Fetches one page, as Backend.historyPage. */
export type FetchHistoryPage = (
  request: HistoryPageRequest,
) => Promise<HistoryPage>;

/** One older work order loaded on demand, and its load state. */
export interface LoadedWorkOrder {
  /** Undefined until loaded, or when it could not be. */
  history?: WorkOrderHistory;
  loading: boolean;
  /** Why it could not load, as the user should read it; "" otherwise. */
  error: string;
  /** No connection: it cannot load. */
  offline: boolean;
}

/** Records named by uuid loaded on demand, and their load state. */
export interface LoadedRecords {
  /** Undefined until loaded, or when they could not be. */
  records?: FoundRecords;
  loading: boolean;
  /** Why they could not load, as the user should read it; "" otherwise. */
  error: string;
  /** No connection: they cannot load. */
  offline: boolean;
}

/**
 * The records a screen shows: the workspace snapshot with the older records
 * it has loaded. Components under it read it through
 * {@link useRecordsSnapshot}, so a record opened from a history page finds
 * its job cards, costs and files.
 */
export const HistoryRecordsContext = createContext<Snapshot | null>(null);

/** Nothing loaded yet. */
export const NO_HISTORY: LoadedHistory = Object.freeze({
  records: emptyHistoryRecords(),
  members: [],
  pages: 0,
  cursor: null,
  isDone: false,
});

const LOAD_ERROR = "Could not load older records.";
const NO_ITEM: LoadedItem<never> = { item: "", mark: undefined, error: "" };
const MERGED_COLLECTIONS = [
  "flights",
  "discrepancies",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
  "taskEvidence",
  "workOrderAttachments",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
] as const;
type MergedCollection = (typeof MERGED_COLLECTIONS)[number];
// What an on-demand load fetched, for which item and write mark.
interface LoadedItem<T> {
  item: string;
  mark: string | undefined;
  value?: T;
  error: string;
}
type Keyed = { uuid: string };
// The change-log actions that write each list's records: a work order page
// also carries its job cards and cost record, a request page its purchases,
// which orders change, and a plan page the flights logged against it.
const WRITE_ACTIONS: Record<HistoryKind, string[]> = {
  flights: ["flight."],
  discrepancies: ["discrepancy."],
  workOrders: ["workOrder.", "taskCard.", "labor.", "cost."],
  partsRequests: ["partsRequest.", "po."],
  purchaseOrders: ["po."],
  flightPlans: ["plan.", "flight."],
};
/**
 * A list's older history for a screen: nothing until the user asks, then a
 * page at a time while connected.
 *
 * @param list - The list and its server-side filters; changing them starts
 *   a new list.
 * @returns The rows loaded, with paging and load state. They are dropped
 *   when the program, user or list changes, and reloaded after any write of
 *   the list's kind (a new change-log entry of it).
 */
export function useHistoryPages(list: HistoryList): HistoryPages {
  const { backend, online, connected, snapshot } = useWorkspace();
  const { kind, aircraftUuid, status, vendor } = list;
  // A record's source is a new object each render; its text is stable.
  const sourceKey = JSON.stringify(list.source ?? null);
  const pager = useMemo(() => {
    const source = (JSON.parse(sourceKey) as RequestSource | null) ?? undefined;
    const filters = { kind, aircraftUuid, status, source, vendor };
    return new HistoryPager(filters, (request) =>
      backend
        ? backend.historyPage(request)
        : Promise.reject(new Error(LOAD_ERROR)),
    );
  }, [backend, kind, aircraftUuid, status, sourceKey, vendor]);
  const scope = historyScope(snapshot, list);
  const state = useSyncExternalStore(
    pager.subscribe,
    pager.getState,
    pager.getState,
  );
  const mark = historyWriteMark(snapshot, kind);
  const live = !!backend && online && connected;
  useEffect(
    () => pager.sync({ scope, mark, live }),
    [pager, scope, mark, live],
  );
  const current = state.scope === scope;
  return {
    ...(current ? state.loaded : NO_HISTORY),
    loading: current && state.loading,
    error: current ? state.error : "",
    offline: !live,
    loadOlder: pager.loadOlder,
  };
}

/**
 * The records of the screen around the caller: its {@link
 * HistoryRecordsContext}, or the workspace snapshot when none is set.
 *
 * @returns Null before the workspace has a snapshot.
 */
export function useRecordsSnapshot(): Snapshot | null {
  const screen = useContext(HistoryRecordsContext);
  const { snapshot } = useWorkspace();
  return screen ?? snapshot;
}

/**
 * One work order and everything filed on it, loaded through
 * Backend.workOrderHistory, for an order the workspace's window leaves out.
 *
 * @param uuid - The order; undefined loads nothing, for an order the
 *   workspace holds.
 * @returns The order once loaded. It loads again after any write of a work
 *   order, job card or cost, keeping the copy it has meanwhile, and is
 *   dropped on a program or user change. "History not found." is the
 *   server's answer for an order the user may not read.
 */
export function useWorkOrderHistory(uuid: string | undefined): LoadedWorkOrder {
  const { snapshot } = useWorkspace();
  const item = uuid
    ? historyScope(snapshot, { kind: "workOrders" }) + uuid
    : "";
  const { value, ...state } = useLoadedItem(
    item,
    historyWriteMark(snapshot, "workOrders"),
    (backend) => backend.workOrderHistory(uuid!),
  );
  return { ...state, history: value };
}

/**
 * Records a screen names by uuid that the workspace may not hold, loaded
 * through Backend.historyRecords while connected: a job card's problem
 * report, a request's source, a plan's flights.
 *
 * @param lookup - The uuids; a lookup naming none loads nothing.
 * @returns The records once loaded. They load again after any write of a
 *   flight, problem report or work order, keeping the copy they have
 *   meanwhile, and are dropped on a program or user change.
 */
export function useHistoryRecords(lookup: RecordLookup): LoadedRecords {
  const { snapshot } = useWorkspace();
  const named =
    lookup.discrepancyUuids.length +
    lookup.taskCardUuids.length +
    lookup.flightPlanUuids.length;
  const item = named
    ? JSON.stringify([snapshot?.user.id, snapshot?.activeProgramUuid, lookup])
    : "";
  const mark = (["flights", "discrepancies", "workOrders"] as const)
    .map((kind) => historyWriteMark(snapshot, kind))
    .join("|");
  const { value, ...state } = useLoadedItem(item, mark, (backend) =>
    backend.historyRecords(lookup),
  );
  return { ...state, records: value };
}

/**
 * The snapshot with loaded older rows added. Each row is joined once by
 * uuid (a member by id), and the snapshot's copy wins: it is reactive, and
 * a page may be older than it.
 *
 * @param s - The workspace snapshot.
 * @param rows - Pages or whole work orders, in the order to list them.
 * @returns A new snapshot when anything joins; `s` itself otherwise. Page
 *   rows follow the snapshot's in each collection; a collection the snapshot
 *   lacks stays absent unless rows join it.
 */
export function withHistory(s: Snapshot, ...rows: HistoryRows[]): Snapshot {
  const merged: Partial<Snapshot> = Object.assign(
    {},
    ...MERGED_COLLECTIONS.map((name) => joined(name, s, rows)),
  );
  const members = rows.flatMap((r) => r.members ?? []);
  if (members.length) merged.members = joinMembers(s.members, members);
  const purchases = rows.flatMap((r) => r.partsRequestPurchases ?? []);
  if (purchases.length)
    merged.partsRequestPurchases = joinPurchases(
      s.partsRequestPurchases ?? [],
      purchases,
    );
  return Object.keys(merged).length ? { ...s, ...merged } : s;
}

/**
 * One work order's history as rows for {@link withHistory}.
 *
 * @param history - From Backend.workOrderHistory.
 */
export function workOrderRows(history: WorkOrderHistory): HistoryRows {
  return { ...history, workOrders: [history.workOrder] };
}

/**
 * Fetches pages of a list one after another.
 *
 * @param fetchPage - Backend.historyPage, or a stand-in.
 * @param list - The list and its filters.
 * @param start - What is loaded already; the first page follows its cursor.
 * @param count - The most pages to fetch; fewer once the list is done.
 * @returns `start` with the pages appended.
 * @throws What `fetchPage` throws; nothing is kept from a failed run.
 */
export async function loadHistoryPages(
  fetchPage: FetchHistoryPage,
  list: HistoryList,
  start: LoadedHistory,
  count: number,
): Promise<LoadedHistory> {
  let loaded = start;
  for (let n = 0; n < count && !loaded.isDone; n++)
    loaded = appendPage(
      loaded,
      await fetchPage(pageRequest(list, loaded.cursor)),
    );
  return loaded;
}

/**
 * Who and what the pages belong to: the user, the active program and the
 * list with its filters. Pages from another scope are never shown.
 *
 * @param s - The workspace snapshot; null after sign-out.
 * @param list - The list.
 */
export function historyScope(s: Snapshot | null, list: HistoryList): string {
  return JSON.stringify([
    s?.user.id ?? "",
    s?.activeProgramUuid ?? "",
    list.kind,
    list.kind === "purchaseOrders" ? "" : (list.aircraftUuid ?? ""),
    list.kind === "flights" ? (list.status ?? "") : "",
    list.kind === "partsRequests" ? (list.source ?? null) : null,
    list.kind === "purchaseOrders" ? (list.vendor ?? null) : null,
  ]);
}

/**
 * What loaded pages must be newer than: the newest change-log entry that
 * wrote a list's records, and the UTC day the workspace's window was cut on.
 * It changes after any write of that kind, from this device or another, and
 * when a snapshot cut on a later day arrives: its window has moved past
 * records that pages loaded the day before do not hold.
 *
 * @param s - The workspace snapshot, its change log newest first; its
 *   `syncedAt` is when the server cut its window.
 * @param kind - The list.
 * @returns The day and the entry's uuid; undefined without a snapshot.
 */
export function historyWriteMark(
  s: Snapshot | null,
  kind: HistoryKind,
): string | undefined {
  if (!s) return undefined;
  const actions = WRITE_ACTIONS[kind];
  const entry = s.audit.find((a) =>
    actions.some((p) => a.action.startsWith(p)),
  );
  return `${retentionCutoff(s.syncedAt, 0)} ${entry?.uuid ?? ""}`;
}

/**
 * A list's pager, apart from React so its rules can be tested: one request
 * at a time, the newest superseding older ones. A new scope drops the pages
 * and any request in flight; a new write mark reloads as many pages as were
 * loaded, once connected; a failed load keeps the pages it had.
 */
export class HistoryPager {
  #state: HistoryPagerState = {
    scope: "",
    mark: undefined,
    loaded: NO_HISTORY,
    loading: false,
    error: "",
  };
  #latest: HistoryPagerSync = { scope: "", mark: undefined, live: false };
  #request = 0;
  readonly #listeners = new Set<() => void>();
  readonly #list: HistoryList;
  readonly #fetchPage: FetchHistoryPage;

  /**
   * @param list - The list and its filters.
   * @param fetchPage - Backend.historyPage, or a stand-in.
   */
  constructor(list: HistoryList, fetchPage: FetchHistoryPage) {
    this.#list = list;
    this.#fetchPage = fetchPage;
  }

  /** The current state; a new object after every change. */
  getState = (): HistoryPagerState => this.#state;

  /**
   * Calls `listener` after every change.
   *
   * @returns Stops the calls.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * Takes the workspace's latest scope, write mark and connection.
   *
   * @param next - What the workspace says now.
   */
  sync = (next: HistoryPagerSync): void => {
    this.#latest = next;
    if (next.scope === this.#state.scope) return this.#reloadIfStale();
    this.#request++;
    this.#set({
      scope: next.scope,
      mark: next.mark,
      loaded: NO_HISTORY,
      loading: false,
      error: "",
    });
  };

  /** Loads the next page; does nothing offline, while loading or when done. */
  loadOlder = (): void => {
    const { loaded, loading, mark } = this.#state;
    if (!this.#latest.live || loading || loaded.isDone) return;
    void this.#fetchFrom(loaded, 1, loaded.pages ? mark : this.#latest.mark);
  };

  #set(patch: Partial<HistoryPagerState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  async #fetchFrom(start: LoadedHistory, count: number, mark?: string) {
    const id = ++this.#request;
    this.#set({ loading: true, error: "" });
    try {
      const list = this.#list;
      const loaded = await loadHistoryPages(
        this.#fetchPage,
        list,
        start,
        count,
      );
      if (id !== this.#request) return;
      this.#set({ loaded, mark, loading: false });
      this.#reloadIfStale();
    } catch (e) {
      if (id === this.#request)
        this.#set({ loading: false, error: errorText(e, LOAD_ERROR) });
    }
  }

  // Pages loaded before the latest write of their kind load again.
  #reloadIfStale() {
    const { loaded, mark, loading } = this.#state;
    const { live, mark: latest } = this.#latest;
    if (live && loaded.pages && mark !== latest && !loading)
      void this.#fetchFrom(NO_HISTORY, loaded.pages, latest);
  }
}

function pageRequest(
  list: HistoryList,
  cursor: string | null,
): HistoryPageRequest {
  const page = { cursor, numItems: HISTORY_PAGE_SIZE };
  const { kind, aircraftUuid } = list;
  if (kind === "purchaseOrders") return { kind, vendor: list.vendor, ...page };
  if (kind === "flights")
    return { kind, aircraftUuid, status: list.status, ...page };
  if (kind === "partsRequests")
    return { kind, aircraftUuid, source: list.source, ...page };
  return { kind, aircraftUuid, ...page };
}

function appendPage(loaded: LoadedHistory, page: HistoryPage): LoadedHistory {
  const records = emptyHistoryRecords();
  for (const name of Object.keys(records) as (keyof HistoryRecords)[])
    Object.assign(records, {
      [name]: [...loaded.records[name], ...page.records[name]],
    });
  return {
    records,
    members: joinMembers(loaded.members, page.members),
    pages: loaded.pages + 1,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

// One collection's joined rows under its name, or nothing when none join.
// Every merged collection is an array of rows with a uuid, so the casts only
// widen each row to that.
function joined(name: MergedCollection, s: Snapshot, rows: HistoryRows[]) {
  const added = rows.flatMap((r) => (r[name] ?? []) as Keyed[]);
  if (!added.length) return {};
  return { [name]: joinRows(s[name] as Keyed[] | undefined, added) };
}

function joinRows<T extends { uuid: string }>(
  kept: readonly T[] | undefined,
  added: readonly T[],
): T[] {
  const seen = new Set((kept ?? []).map((r) => r.uuid));
  const joined = [...(kept ?? [])];
  for (const row of added) {
    if (seen.has(row.uuid)) continue;
    seen.add(row.uuid);
    joined.push(row);
  }
  return joined;
}

// The snapshot's allocation wins, as its rows do: it is reactive.
function joinPurchases(
  kept: RequestPurchase[],
  added: RequestPurchase[],
): RequestPurchase[] {
  const key = (a: PurchaseKey) => `${a.poUuid} ${a.lineUuid} ${a.requestUuid}`;
  const seen = new Set(kept.map(key));
  return [
    ...kept,
    ...added.filter((a) => !seen.has(key(a)) && seen.add(key(a))),
  ];
}

function joinMembers(kept: Member[], added: Member[]): Member[] {
  const seen = new Set(kept.map((m) => m.id));
  return [...kept, ...added.filter((m) => !seen.has(m.id) && seen.add(m.id))];
}

// One on-demand load per item: fetched while connected, again after the
// write mark changes (keeping the copy it has meanwhile), dropped when the
// item changes. `item` identifies what `load` fetches.
function useLoadedItem<T>(
  item: string,
  mark: string | undefined,
  load: (backend: Backend) => Promise<T>,
) {
  const { backend, online, connected } = useWorkspace();
  const live = !!backend && online && connected;
  const [state, setState] = useState<LoadedItem<T>>(NO_ITEM);
  const fresh = state.item === item && state.mark === mark;
  // The latest `load`, set before the effect below runs: `item` already
  // names what it fetches, so a new closure alone is no reason to refetch.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!item || !live || !backend || fresh) return;
    let current = true;
    loadRef.current(backend).then(
      (value) => current && setState({ item, mark, value, error: "" }),
      (e) =>
        current && setState({ item, mark, error: errorText(e, LOAD_ERROR) }),
    );
    return () => void (current = false);
  }, [item, live, backend, fresh, mark]);
  const kept = state.item === item && !!item;
  return {
    value: kept ? state.value : undefined,
    loading: !!item && live && !fresh,
    error: kept ? state.error : "",
    offline: !live,
  };
}
