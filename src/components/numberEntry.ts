/**
 * Responsibility: Stops a number input from silently misreading a typed or
 *   pasted decimal comma or exponent: refuses the text and marks the field
 *   invalid with a plain message until the user corrects it.
 * Layer: UI. One document-wide listener; no React, no rules of its own.
 * Dependencies: src/domain/readings.ts (numberEntryProblem).
 *
 * A number input never reveals a typed comma to code: the browser keeps
 * "2342,5" as 23425, so no parser downstream can tell, and an aircraft's
 * totals were rewritten that way. The keystroke is the only place it can be
 * seen, and one listener covers every number field in the app.
 */
import { numberEntryProblem } from "../domain/readings";

const FLAG = "numberEntryProblem";

/**
 * Watches every number input under `root`. Typed, pasted or dropped text
 * with a comma or an "e" is refused and the field is marked invalid with the
 * reason (the browser shows it beside the field and will not submit the
 * form). The mark stays, so digits typed after the refused comma cannot slip
 * through as a larger number; it clears when the user types a decimal point
 * or empties the field.
 *
 * @param root - The document, or a part of it, to watch.
 * @returns A function that stops watching.
 */
export function guardNumberEntry(root: Document | HTMLElement): () => void {
  const onBeforeInput = (event: Event) => {
    const input = numberInput(event.target);
    if (!input || !(event instanceof InputEvent)) return;
    const inserted =
      event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
    const problem = numberEntryProblem(inserted);
    if (problem) {
      event.preventDefault();
      markInvalid(input, problem);
    } else if (inserted.includes(".")) clearMark(input);
  };
  const onInput = (event: Event) => {
    const input = numberInput(event.target);
    if (input?.value === "" && !input.validity.badInput) clearMark(input);
  };
  root.addEventListener("beforeinput", onBeforeInput, true);
  root.addEventListener("input", onInput, true);
  return () => {
    root.removeEventListener("beforeinput", onBeforeInput, true);
    root.removeEventListener("input", onInput, true);
  };
}

function numberInput(target: EventTarget | null) {
  return target instanceof HTMLInputElement && target.type === "number"
    ? target
    : undefined;
}

function markInvalid(input: HTMLInputElement, message: string) {
  input.dataset[FLAG] = "true";
  input.setAttribute("aria-invalid", "true");
  input.setCustomValidity(message);
  input.reportValidity();
}

function clearMark(input: HTMLInputElement) {
  if (!input.dataset[FLAG]) return;
  delete input.dataset[FLAG];
  input.removeAttribute("aria-invalid");
  input.setCustomValidity("");
}
