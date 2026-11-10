/**
 * Responsibility: Desktop keyboard shortcuts: "/" to the page's search, "n"
 *   for a new flight, "?" for the list of shortcuts, and that list's dialog.
 * Layer: UI. A React hook and dialog; the shell decides who may log flights.
 * Dependencies: react, ./design (Dialog), src/styles/shortcuts.css.
 *
 * Shortcuts are single keys, so they stand down whenever a key could mean
 * typing or belongs to something else: in a text field, with Ctrl, Alt or
 * Cmd held, and while a dialog is open.
 */
import { useEffect, useState } from "react";
import { Dialog } from "./design";
import "../styles/shortcuts.css";

/** What a shortcut key asks the app to do. */
export type ShortcutAction = "search" | "new-flight" | "help";

/** The parts of a key press, and of the page, that decide a shortcut. */
export type ShortcutPress = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** The focus is in a text field, a select or editable content. */
  typing: boolean;
  /** A modal dialog is open. */
  dialogOpen: boolean;
};

const KEY_ACTIONS: Record<string, ShortcutAction> = {
  "/": "search",
  n: "new-flight",
  "?": "help",
};
// Fields where a key types a character or picks an option.
const TYPING_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
// Devices with a mouse or trackpad; touch-only phones and tablets get no
// shortcut help, as they have no keyboard to use it with.
const POINTER_QUERY = "(any-hover: hover), (any-pointer: fine)";

/**
 * The action a key press asks for.
 *
 * @param press - The key and where the focus is.
 * @returns The action, or undefined while typing, with Ctrl, Alt or Cmd held,
 *   on a held-down repeat, while a dialog is open, or for any other key.
 *   Shift is allowed: "?" needs it.
 */
export function shortcutFor(press: ShortcutPress): ShortcutAction | undefined {
  if (press.typing || press.dialogOpen || press.repeat) return undefined;
  if (press.ctrlKey || press.metaKey || press.altKey) return undefined;
  return KEY_ACTIONS[press.key];
}

/**
 * Listens for the shortcut keys on the whole page.
 *
 * @param onNewFlight - Opens the flight form; absent for users who may not
 *   log flights, so "n" does nothing for them.
 * @returns Whether the shortcut list is open, and a way to close it.
 */
export function useKeyboardShortcuts(onNewFlight?: () => void) {
  const [help, setHelp] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const action = shortcutFor(readPress(event));
      if (!action || !runAction(action, onNewFlight, () => setHelp(true)))
        return;
      event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onNewFlight]);
  return { help, closeHelp: () => setHelp(false) };
}

/**
 * The list of shortcuts, opened with "?".
 *
 * @param props.canLog - Lists "n" only for users who may log flights.
 */
export function ShortcutsHelp({
  canLog,
  onClose,
}: {
  canLog: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog title="Keyboard shortcuts" size="narrow" onClose={onClose}>
      <dl className="shortcuts-list">
        <Shortcut keys="/">Go to this page&apos;s search box</Shortcut>
        {canLog && <Shortcut keys="N">Log a new flight</Shortcut>}
        <Shortcut keys="?">Show this list</Shortcut>
        <Shortcut keys="Esc">Close a dialog or a term tip</Shortcut>
      </dl>
      <p className="muted">
        Shortcuts work when you are not typing in a field.
      </p>
    </Dialog>
  );
}

/**
 * Whether this device has a mouse or trackpad, and so likely a keyboard.
 *
 * @returns False on touch-only phones and tablets, and without matchMedia.
 */
export function hasKeyboardPointer(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(POINTER_QUERY).matches;
}

function Shortcut({ keys, children }: { keys: string; children: string }) {
  return (
    <div className="shortcuts-row">
      <dt>
        <kbd>{keys}</kbd>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function readPress(event: KeyboardEvent): ShortcutPress {
  const target = event.target instanceof Element ? event.target : null;
  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    repeat: event.repeat,
    typing: !!target?.closest(TYPING_SELECTOR),
    dialogOpen: !!document.querySelector("dialog[open]"),
  };
}

// Returns whether the shortcut did something, so an unused key keeps its
// browser meaning (such as "/" for quick find).
function runAction(
  action: ShortcutAction,
  onNewFlight: (() => void) | undefined,
  openHelp: () => void,
): boolean {
  switch (action) {
    case "search":
      return focusSearch();
    case "new-flight":
      onNewFlight?.();
      return !!onNewFlight;
    case "help":
      openHelp();
      return true;
  }
}

function focusSearch(): boolean {
  const field = [
    ...document.querySelectorAll<HTMLInputElement>('main input[type="search"]'),
  ].find((input) => input.getClientRects().length > 0);
  field?.focus();
  field?.select();
  return !!field;
}
