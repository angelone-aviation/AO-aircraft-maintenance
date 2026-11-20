/**
 * Responsibility: Pins how screens get file links: requests made together go
 *   in one call of at most 50, a repeated file is asked for once, a link is
 *   reused until a minute before it expires, and a failure is not kept.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/fileLinks.ts, src/domain/fileLinks.ts.
 */
import { expect, it, vi } from "vitest";
import { fileLinkCache, LINK_REFRESH_MARGIN_MS } from "./fileLinks";
import {
  FILE_LINK_TTL_MS,
  MAX_FILE_LINKS,
  type FileLink,
  type FileRef,
} from "../domain/fileLinks";

const START = 1_000_000;
const photo = (id: string): FileRef => ({ kind: "aircraftPhoto", id });

function setup() {
  const clock = { now: START };
  const load = vi.fn(async (refs: FileRef[]): Promise<(FileLink | null)[]> =>
    refs.map((r) =>
      r.id === "hidden"
        ? null
        : {
            url: `link:${r.id}@${clock.now}`,
            expiresAt: clock.now + FILE_LINK_TTL_MS,
          },
    ),
  );
  const cache = fileLinkCache(load, () => clock.now);
  return { clock, load, cache };
}

it("asks once for files requested together, at most 50 a call, a repeated file once", async () => {
  const { load, cache } = setup();
  const ids = Array.from({ length: MAX_FILE_LINKS + 1 }, (_, i) => `a${i}`);
  const links = await Promise.all([
    ...ids.map((id) => cache.link(photo(id))),
    cache.link(photo("a0")),
  ]);
  expect(load.mock.calls.map(([refs]) => refs.length)).toEqual([
    MAX_FILE_LINKS,
    1,
  ]);
  expect(links[0]).toEqual(links.at(-1));
  expect(links[MAX_FILE_LINKS]?.url).toBe(`link:a${MAX_FILE_LINKS}@${START}`);
});

it("reuses a link until a minute before it expires, then asks again", async () => {
  const { clock, load, cache } = setup();
  const first = await cache.link(photo("a"));
  clock.now = first!.expiresAt - LINK_REFRESH_MARGIN_MS - 1;
  expect(await cache.link(photo("a"))).toBe(first);
  expect(load).toHaveBeenCalledOnce();
  clock.now += 1;
  expect((await cache.link(photo("a")))?.url).toBe(`link:a@${clock.now}`);
  expect(load).toHaveBeenCalledTimes(2);
  expect(LINK_REFRESH_MARGIN_MS).toBe(60_000);
});

it("remembers a file the member may not open as long as a link would last", async () => {
  const { clock, load, cache } = setup();
  expect(await cache.link(photo("hidden"))).toBeNull();
  clock.now += FILE_LINK_TTL_MS - LINK_REFRESH_MARGIN_MS - 1;
  expect(await cache.link(photo("hidden"))).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});

it("fails every request of a refused call, keeps nothing, and asks again next time", async () => {
  const { load, cache } = setup();
  load.mockRejectedValueOnce(
    new Error("Files are not available in the board view."),
  );
  const refused = [cache.link(photo("a")), cache.link(photo("b"))];
  for (const request of refused)
    await expect(request).rejects.toThrow("Files are not available");
  expect((await cache.link(photo("a")))?.url).toBe(`link:a@${START}`);
  expect(load).toHaveBeenCalledTimes(2);
});

it("forgets every link when cleared", async () => {
  const { load, cache } = setup();
  await cache.link(photo("a"));
  cache.clear();
  await cache.link(photo("a"));
  expect(load).toHaveBeenCalledTimes(2);
});
