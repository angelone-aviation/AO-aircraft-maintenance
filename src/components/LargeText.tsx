/**
 * Responsibility: The "Larger text" device setting: stored on this device,
 *   applied to <html>, and its switch in Settings.
 * Layer: UI. A device preference and one Settings block; no workspace data.
 * Dependencies: react, ./design (Switch), ./SettingsBlock.
 *
 * For older eyes and gloved hands: the whole interface grows, text and tap
 * targets together, kept per device like the theme. public/theme-init.js
 * applies it before the first paint; src/styles/largeText.css styles it.
 */
import { useSyncExternalStore } from "react";
import { Switch } from "./design";
import { Block } from "./SettingsBlock";

/** The localStorage key; public/theme-init.js reads it too. */
export const LARGE_TEXT_KEY = "angelone-large-text";
const LARGE_TEXT_CLASS = "large-text";
const STORED_ON = "on";
const listeners = new Set<() => void>();
let current = typeof window === "undefined" ? false : readStored();
applyLargeText(current);

/**
 * Turns larger text on or off for every useLargeText caller and saves it on
 * the device.
 *
 * @param on - Applied at once; when storage is blocked it lasts this visit.
 */
export function setLargeText(on: boolean) {
  current = on;
  applyLargeText(on);
  try {
    if (on) localStorage.setItem(LARGE_TEXT_KEY, STORED_ON);
    else localStorage.removeItem(LARGE_TEXT_KEY);
  } catch {
    // Not persisted when storage is unavailable; the choice lasts this visit.
  }
  listeners.forEach((l) => l());
}

/**
 * Whether larger text is on.
 *
 * @returns False when server rendered.
 */
export function useLargeText(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => false,
  );
}

/** The Settings block with the "Larger text" switch, under This device. */
export function LargeTextBlock() {
  const on = useLargeText();
  return (
    <Block
      title="Text size"
      description="Makes text, buttons and fields about a fifth larger on this device, for easier reading and for tapping with gloves."
    >
      <Switch checked={on} onChange={setLargeText} label="Larger text" />
    </Block>
  );
}

function readStored() {
  try {
    return localStorage.getItem(LARGE_TEXT_KEY) === STORED_ON;
  } catch {
    // Storage blocked: normal text.
    return false;
  }
}

function applyLargeText(on: boolean) {
  if (typeof document !== "undefined")
    document.documentElement.classList.toggle(LARGE_TEXT_CLASS, on);
}
