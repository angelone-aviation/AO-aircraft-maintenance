/**
 * Responsibility: Short-lived links to stored files for the screens: asked
 *   for in batches, reused while fresh, held only in memory.
 * Layer: Data. A cache over Backend.fileLinks; no React, nothing stored on
 *   the device.
 * Dependencies: src/data/store.ts, src/domain/fileLinks.ts.
 *
 * A screen of thumbnails asks for many links at once, and each expires after
 * five minutes (docs/file-links.md), so requests made together share one
 * call and a link is reused until shortly before it stops working.
 */
import { useWorkspace } from "./store";
import {
  FILE_LINK_TTL_MS,
  MAX_FILE_LINKS,
  type FileLink,
  type FileRef,
} from "../domain/fileLinks";

/**
 * How long before its expiry a cached link is asked for again, so a link a
 * screen hands out still works when the user follows it.
 */
export const LINK_REFRESH_MARGIN_MS = 60_000;

/** Asks the server for links to files, one entry per reference, in order. */
type LoadLinks = (refs: FileRef[]) => Promise<(FileLink | null)[]>;

/** Links to stored files, reused while fresh. */
export interface FileLinkCache {
  /**
   * A link to one file, from memory while it has more than
   * {@link LINK_REFRESH_MARGIN_MS} left; requests made in the same turn are
   * sent together, at most {@link MAX_FILE_LINKS} per call.
   *
   * @param ref - The file.
   * @returns The link, or null when the member may not open the file or it is
   *   gone; a null is remembered as long as a link would be.
   * @throws Whatever the call that loads it throws; nothing is remembered.
   */
  link(ref: FileRef): Promise<FileLink | null>;
  /** Forgets every link and refusal. */
  clear(): void;
}

/**
 * A link cache over one way of loading links; the workspace's is
 * {@link fileLink}.
 *
 * @param load - Asks for links, as Backend.fileLinks does.
 * @param now - The clock, in epoch ms.
 * @returns The cache.
 */
export function fileLinkCache(
  load: LoadLinks,
  now: () => number = Date.now,
): FileLinkCache {
  const fresh = new Map<string, Remembered>();
  let waiting: Waiting[] = [];
  const send = () => {
    const batch = waiting;
    waiting = [];
    for (const group of chunk(groupByFile(batch), MAX_FILE_LINKS))
      void loadGroup(group, load, (key, link) =>
        fresh.set(key, { link, until: freshUntil(link, now()) }),
      );
  };
  return {
    link(ref) {
      const key = fileKey(ref);
      const hit = fresh.get(key);
      if (hit && hit.until > now()) return Promise.resolve(hit.link);
      return new Promise((resolve, reject) => {
        if (!waiting.length) queueMicrotask(send);
        waiting.push({ key, ref, resolve, reject });
      });
    },
    clear: () => fresh.clear(),
  };
}

/**
 * A link to a stored file through the workspace's backend, shared by every
 * screen. Signing out reloads the page, which empties it.
 *
 * @param ref - The file.
 * @returns As {@link FileLinkCache.link}.
 * @throws {Error} "Sign in to open files." before a backend is set; as
 *   Backend.fileLinks.
 */
export function fileLink(ref: FileRef): Promise<FileLink | null> {
  return workspaceLinks.link(ref);
}

const workspaceLinks = fileLinkCache((refs) => {
  const { backend } = useWorkspace.getState();
  if (!backend) return Promise.reject(new Error("Sign in to open files."));
  return backend.fileLinks(refs);
});

/** A link or refusal held in memory, and until when it is reused. */
interface Remembered {
  link: FileLink | null;
  until: number;
}

/** A screen waiting for one file's link. */
interface Waiting {
  key: string;
  ref: FileRef;
  resolve: (link: FileLink | null) => void;
  reject: (error: unknown) => void;
}

/** Every screen waiting for one file. */
interface FileGroup {
  key: string;
  ref: FileRef;
  waiting: Waiting[];
}

function fileKey(ref: FileRef) {
  return `${ref.kind}:${ref.id}`;
}

function freshUntil(link: FileLink | null, now: number) {
  const expiresAt = link?.expiresAt ?? now + FILE_LINK_TTL_MS;
  return expiresAt - LINK_REFRESH_MARGIN_MS;
}

function groupByFile(batch: Waiting[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const w of batch) {
    const group = groups.get(w.key);
    if (group) group.waiting.push(w);
    else groups.set(w.key, { key: w.key, ref: w.ref, waiting: [w] });
  }
  return [...groups.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}

// A failed call fails each screen waiting on it and is not remembered, so
// the next request asks again.
async function loadGroup(
  groups: FileGroup[],
  load: LoadLinks,
  remember: (key: string, link: FileLink | null) => void,
) {
  try {
    const links = await load(groups.map((g) => g.ref));
    groups.forEach((g, i) => {
      remember(g.key, links[i] ?? null);
      for (const w of g.waiting) w.resolve(links[i] ?? null);
    });
  } catch (error) {
    for (const w of groups.flatMap((g) => g.waiting)) w.reject(error);
  }
}
