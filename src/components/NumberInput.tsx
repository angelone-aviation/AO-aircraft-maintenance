/**
 * Responsibility: A number input bound to a number in a form's state that
 *   shows the text as typed.
 * Layer: UI. One React component; no rules of its own.
 * Dependencies: react.
 *
 * React writes a controlled number input's value back on every keystroke, so
 * an emptied field read "0", typing then gave "012", and the browser's ""
 * for a lone "-" became "0" and then "05": -5 was saved as 5.
 */
import { useState, type InputHTMLAttributes } from "react";

/** The input's own attributes, less those NumberInput sets. */
type NumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value: number;
  onValue: (value: number) => void;
};

/**
 * A number input that keeps what the user typed: it can be emptied while
 * editing, and a typed minus sign stays, so the browser refuses a number
 * below `min` on save with its own message instead of the sign being
 * dropped. Other attributes, such as `min`, `step`, `required`, `id` and
 * `aria-describedby`, go to the input.
 *
 * @param props.value - The number in state. A change made elsewhere, such as
 *   choosing a stock item, replaces the text.
 * @param props.onValue - Called on each edit with the typed number; 0 while
 *   the field is empty.
 * @returns The `input type="number"`.
 */
export function NumberInput({ value, onValue, ...input }: NumberInputProps) {
  const [text, setText] = useState(() => String(value));
  const [shown, setShown] = useState(value);
  if (!Object.is(value, shown)) {
    setShown(value);
    if (value !== typedNumber(text)) setText(String(value));
  }
  return (
    <input
      {...input}
      type="number"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onValue(typedNumber(event.target.value));
      }}
    />
  );
}

// A number input reports "" both when emptied and while it holds text that
// is not yet a number, such as a lone "-".
function typedNumber(text: string): number {
  return text === "" ? 0 : Number(text);
}
