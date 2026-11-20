/**
 * Responsibility: Shows stored files through short-lived links: the hook a
 *   screen asks for a file's link with, and the image, Open button and named
 *   link drawn from one.
 * Layer: UI. React hook and component over src/data/fileLinks.ts and the
 *   workspace store; no rules.
 * Dependencies: react, src/data (store, fileLinks), src/domain/fileLinks.
 *
 * A link is asked for while its file is on screen and never stored, so an
 * offline device shows no file it has not kept (docs/file-links.md).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "../data/store";
import { fileLink, LINK_REFRESH_MARGIN_MS } from "../data/fileLinks";
import type { FileRef } from "../domain/fileLinks";

/** A file's link on screen, and why it has none yet. */
export interface ShownLink {
  /** The link for `src` or `href`; "" until there is one. */
  url: string;
  /**
   * `waiting` for the server, `offline` without a connection, `unavailable`
   * when the member may not open the file, it is gone or asking failed.
   */
  status: "waiting" | "ready" | "offline" | "unavailable";
}

/**
 * The link to show a stored file through, asked for while the screen shows
 * it. Demo files arrive as data URLs and become blob URLs, since browsers
 * block opening a data URL as a page.
 *
 * @param file - The file; undefined asks for nothing.
 * @param options.keepFresh - Ask again before the link expires, for a link
 *   the user may follow later (an Open button); a drawn image needs none.
 * @returns The link and its status; a link already shown stays usable when
 *   the connection drops, until it expires.
 */
export function useFileLink(
  file: FileRef | undefined,
  options: { keepFresh?: boolean } = {},
): ShownLink {
  const live = useWorkspace((x) => x.online && x.connected);
  const { kind, id } = file ?? {};
  const key = kind && id ? `${kind}:${id}` : "";
  const keepFresh = options.keepFresh ?? false;
  const [shown, setShown] = useState<ShownLink & { key: string }>();
  useEffect(() => {
    if (!kind || !id || !live) return;
    const show = (link: ShownLink) =>
      setShown({ ...link, key: `${kind}:${id}` });
    return followLink({ kind, id }, keepFresh, show);
  }, [kind, id, live, keepFresh]);
  if (!key) return UNAVAILABLE;
  if (shown?.key === key) return shown;
  return live ? WAITING : OFFLINE;
}

/**
 * A stored image drawn from its link, or the fallback until it can be.
 *
 * @param props.file - The image file.
 * @param props.alt - The image's text alternative.
 * @param props.fallback - Shown while waiting, offline or unavailable.
 */
export function LinkedImage(props: {
  file: FileRef;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const { url } = useFileLink(props.file);
  if (!url) return <>{props.fallback ?? null}</>;
  return <img className={props.className} src={url} alt={props.alt} />;
}

/**
 * Opens a stored file in a new tab through its link, or says why it cannot
 * yet.
 *
 * @param props.link - The file's link, from useFileLink.
 * @param props.name - The file's name, in the accessible name ("Open <name>").
 */
export function OpenLink({ link, name }: { link: ShownLink; name: string }) {
  if (!link.url) return <small>{WHY_NOT_OPEN[link.status]}</small>;
  return (
    <a
      className="button small"
      href={link.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${name}`}
    >
      Open
    </a>
  );
}

/**
 * A stored file's name, linked to open it in a new tab once its link
 * arrives, and until then followed by why it cannot be opened yet.
 *
 * @param props.file - The file.
 * @param props.name - Its name, the link text.
 */
export function NamedFileLink({ file, name }: { file: FileRef; name: string }) {
  const link = useFileLink(file, { keepFresh: true });
  if (link.url)
    return (
      <a href={link.url} target="_blank" rel="noreferrer">
        {name}
      </a>
    );
  return (
    <span>
      {name} <small>{WHY_NOT_OPEN[link.status]}</small>
    </span>
  );
}

const WHY_NOT_OPEN: Record<ShownLink["status"], string> = {
  waiting: "Opening…",
  offline: "Reconnect to open.",
  unavailable: "Cannot be opened.",
  ready: "",
};
const WAITING: ShownLink = { url: "", status: "waiting" };
const OFFLINE: ShownLink = { url: "", status: "offline" };
const UNAVAILABLE: ShownLink = { url: "", status: "unavailable" };

// Loads the link, and again a minute before it expires when kept fresh.
// Returns the effect's cleanup, which also frees a demo blob URL.
function followLink(
  file: FileRef,
  keepFresh: boolean,
  show: (link: ShownLink) => void,
): () => void {
  const state = { stopped: false, local: "", timer: 0 };
  const load = async () => {
    // A refusal or a failed request leaves the file listed; the screen says
    // it cannot be opened rather than failing.
    const link = await fileLink(file).catch(() => null);
    if (state.stopped) return;
    if (!link) return show(UNAVAILABLE);
    URL.revokeObjectURL(state.local);
    state.local = link.url.startsWith("data:") ? blobUrl(link.url) : "";
    show({ url: state.local || link.url, status: "ready" });
    if (!keepFresh) return;
    const wait = link.expiresAt - LINK_REFRESH_MARGIN_MS - Date.now();
    state.timer = window.setTimeout(load, Math.max(0, wait));
  };
  void load();
  return () => {
    state.stopped = true;
    window.clearTimeout(state.timer);
    URL.revokeObjectURL(state.local);
  };
}

function blobUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const type = dataUrl.slice("data:".length, comma).split(";")[0];
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) =>
    c.charCodeAt(0),
  );
  return URL.createObjectURL(new Blob([bytes], { type }));
}
