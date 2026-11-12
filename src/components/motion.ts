/**
 * Responsibility: The script half of the shared UI motion: a dialog's
 *   closing echo, the Segmented control's sliding pill and a replay count
 *   for values that change.
 * Layer: UI. React hooks over the DOM; no workspace data, no styles.
 * Dependencies: react; the classes they set are styled in
 *   src/styles/design.css.
 *
 * Adapted from transitions.dev's free modal and tabs recipes, re-timed to the
 * app's motion tokens. Motion never holds anything back: a closed dialog
 * leaves the page and the accessibility tree at once, and only an empty,
 * inert picture of it fades out.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// Decorative motion is for mouse-and-keyboard screens of people who have not
// asked for less of it; dialogs and menus check reduced motion only.
const POINTER_MOTION =
  "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
const ANY_MOTION = "(prefers-reduced-motion: no-preference)";
// Removes an echo whose animationend never fires (a hidden tab, say); a
// little longer than --dur-exit.
const ECHO_LIFETIME_MS = 400;
const SELECTED_SEGMENT =
  ":scope > [aria-pressed='true'], :scope > [aria-current='page']";

/**
 * Plays a short visual exit when the dialog in `ref` unmounts: a copy of its
 * scrim and an empty panel of the same size fade out where it was.
 *
 * @param ref - The open native dialog; its panel is `.ds-dialog-panel`.
 *   The copy is aria-hidden, inert, holds no text or controls and ignores
 *   the pointer, so nothing about the dialog stays findable or usable. Under
 *   prefers-reduced-motion nothing is drawn.
 */
export function useExitEcho(ref: RefObject<HTMLDialogElement | null>) {
  // A layout cleanup runs before React removes the dialog, while it can
  // still be measured.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog) leaveEcho(dialog);
    };
  }, [ref]);
}

/**
 * Slides a filled pill behind the chosen button of a Segmented row, for
 * mouse-and-keyboard screens without reduced motion; elsewhere the chosen
 * button keeps its own fill.
 *
 * @param row - The `.ds-segmented` row; its first child is the
 *   `.ds-seg-pill` span. Sets `data-sliding` on the row while the pill is
 *   shown. The first placement and any without a choice do not animate.
 */
export function useSlidingPill(row: RefObject<HTMLDivElement | null>) {
  const placed = useRef(false);
  // Every render: a new choice, label or count can move the chosen button.
  useLayoutEffect(() => {
    if (row.current) placed.current = placePill(row.current, placed.current);
  });
  useEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placePill(el, true));
    // The buttons too: a late web font changes their widths, not the row's.
    for (const child of [el, ...el.children]) observer.observe(child);
    return () => observer.disconnect();
  }, [row]);
}

/**
 * Counts how often `value` has changed since the first render, for a `key`
 * that replays an entrance only on a change.
 *
 * @param value - Compared with Object.is; pass text or a number.
 * @returns 0 on the first render, then one more on each change.
 */
export function useChangeCount(value: unknown): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (!Object.is(seen.value, value)) {
    setSeen({ value, count: seen.count + 1 });
  }
  return seen.count;
}

function motionAllowed(query: string) {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

function leaveEcho(dialog: HTMLDialogElement) {
  const panel = dialog.querySelector<HTMLElement>(".ds-dialog-panel");
  const box = panel?.getBoundingClientRect();
  if (!panel || !box?.width || !motionAllowed(ANY_MOTION)) return;
  const echo = document.createElement("div");
  echo.className = "ds-dialog-echo";
  echo.setAttribute("aria-hidden", "true");
  echo.inert = true;
  // A panel that meets the bottom of the screen is a sheet: it slides down.
  echo.classList.toggle("sheet", Math.round(box.bottom) >= innerHeight);
  echo.append(echoPanel(panel, box));
  showOnTop(echo);
  const remove = () => echo.remove();
  echo.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, ECHO_LIFETIME_MS);
}

// getBoundingClientRect measures screen pixels, but the copy is laid out in
// the page's zoom (the "Larger text" setting zooms <html>).
function echoPanel(panel: HTMLElement, box: DOMRect) {
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const shape = document.createElement("div");
  shape.style.left = `${box.left / zoom}px`;
  shape.style.top = `${box.top / zoom}px`;
  shape.style.width = `${box.width / zoom}px`;
  shape.style.height = `${box.height / zoom}px`;
  shape.style.borderRadius = getComputedStyle(panel).borderRadius;
  return shape;
}

// The top layer puts the copy above a parent dialog that stays open.
function showOnTop(echo: HTMLElement) {
  const topLayer = "showPopover" in echo;
  if (topLayer) echo.popover = "manual";
  document.body.append(echo);
  if (topLayer) echo.showPopover();
}

// Returns whether the pill is now placed, so the next move may animate.
function placePill(row: HTMLDivElement, animate: boolean): boolean {
  const pill = row.firstElementChild;
  const chosen = row.querySelector<HTMLElement>(SELECTED_SEGMENT);
  if (!(pill instanceof HTMLElement) || !chosen) return false;
  if (!motionAllowed(POINTER_MOTION)) {
    delete row.dataset.sliding;
    return false;
  }
  if (!animate) pill.style.transition = "none";
  pill.style.width = `${chosen.offsetWidth}px`;
  pill.style.height = `${chosen.offsetHeight}px`;
  pill.style.transform = `translate(${chosen.offsetLeft}px, ${chosen.offsetTop}px)`;
  row.dataset.sliding = "";
  if (!animate) {
    // Commit the jump before the transition comes back.
    void pill.offsetWidth;
    pill.style.transition = "";
  }
  return true;
}
