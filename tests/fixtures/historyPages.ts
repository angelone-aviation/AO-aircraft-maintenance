/**
 * Responsibility: Calls the paged history queries by list, and follows the
 *   server's and the oracle's cursors in step, for convex-test suites.
 * Layer: Test. Fixture over convex-test; never shipped in the build.
 * Dependencies: vitest, convex-test (types), convex/schema (types),
 *   convex/_generated (api), src/domain (retention, model).
 */
import { expect } from "vitest";
import type { TestConvex } from "convex-test";
import type schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import {
  historyPage,
  type HistoryKind,
  type HistoryPage,
  type HistoryPageRequest,
  type HistoryRecords,
} from "../../src/domain/retention";
import type { Flight, Snapshot } from "../../src/domain/model";

/** Pages a test follows before it fails as never finishing. */
const MAX_PAGES = 500;

/** A client that can run the history queries, signed in or not. */
export type HistoryClient = Pick<TestConvex<typeof schema>, "query">;

/** A page request's fields, any of them, as the cases vary them. */
export interface PageArgs {
  programUuid?: string;
  kind?: HistoryKind;
  aircraftUuid?: string;
  status?: Flight["status"];
  cursor?: string | null;
  numItems?: number;
}

/**
 * Asks the server for one page of a list.
 *
 * @param args - The request; the first page of 50 when fields are absent.
 */
export function queryHistoryPage(
  client: HistoryClient,
  kind: HistoryKind,
  args: PageArgs,
): Promise<HistoryPage> {
  const request = { cursor: null, numItems: 50, ...args };
  const { kind: _kind, status, ...list } = request;
  if (kind === "flights")
    return client.query(api.history.flights, { ...list, status });
  if (kind === "discrepancies")
    return client.query(api.history.discrepancies, list);
  return client.query(api.history.workOrders, list);
}

/**
 * Pages a list on the server and with historyPage on `s` in step, expecting
 * every page to be equal, until the oracle says it is done.
 *
 * @param s - The caller's scoped snapshot: the oracle's input.
 * @param first - The first request, with the program the server checks.
 * @param now - The time both page at.
 * @returns Every page's records, merged in page order.
 * @throws {Error} When the oracle never finishes.
 */
export async function expectOraclePages(
  client: HistoryClient,
  s: Snapshot,
  first: HistoryPageRequest & { programUuid: string },
  now: number,
): Promise<HistoryRecords> {
  const pages: HistoryRecords[] = [];
  let request = first;
  for (let n = 0; n < MAX_PAGES; n++) {
    const expected = historyPage(s, request, now);
    const served = await queryHistoryPage(client, request.kind, request);
    expect(served, JSON.stringify(request)).toEqual(expected);
    pages.push(expected.records);
    if (expected.isDone) return mergeRecords(pages);
    request = { ...request, cursor: expected.continueCursor };
  }
  throw new Error("Paging never finished.");
}

function mergeRecords(pages: HistoryRecords[]): HistoryRecords {
  return {
    flights: pages.flatMap((p) => p.flights),
    discrepancies: pages.flatMap((p) => p.discrepancies),
    workOrders: pages.flatMap((p) => p.workOrders),
    taskCards: pages.flatMap((p) => p.taskCards),
    archivedTaskCards: pages.flatMap((p) => p.archivedTaskCards),
    costs: pages.flatMap((p) => p.costs),
  };
}
