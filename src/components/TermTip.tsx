/**
 * Responsibility: A term tip: a dotted-underlined word that opens its plain
 *   definition from the glossary, with a link to the Glossary page.
 * Layer: UI. React component; definitions come from the domain glossary.
 * Dependencies: react, @tanstack/react-router, src/domain/glossaryTerms.ts,
 *   src/styles/termTip.css.
 *
 * A toggletip on the native popover: the button opens and closes it by tap,
 * click, Enter or Space; Escape and a tap elsewhere close it. The popover sits
 * in the top layer, so it shows above dialogs and never widens the page.
 */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import {
  glossaryAnchor,
  glossaryEntry,
  plainDefinition,
  type TermId,
} from "../domain/glossaryTerms";
import "../styles/termTip.css";

// Space kept between the popover and the screen edge, and below the term.
const EDGE_GAP = 8;
const BELOW_GAP = 6;

/**
 * A term the reader can tap to see what it means.
 *
 * @param props.term - The glossary entry to explain.
 * @param props.children - The words shown; the entry's term when absent.
 * @returns A button named "<words>, what it means" and its popover. Inside a
 *   dialog, "See all terms" opens the Glossary in a new tab, so a half-filled
 *   form is not lost.
 */
export function TermTip({
  term,
  children,
}: {
  term: TermId;
  children?: string;
}) {
  const entry = glossaryEntry(term);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [inDialog, setInDialog] = useState(false);
  const shown = children ?? entry.term;
  useCloseOnScroll(open, tip);
  function onToggle(event: { newState: string }) {
    const opening = event.newState === "open";
    setOpen(opening);
    if (!opening || !button.current || !tip.current) return;
    setInDialog(!!button.current.closest("dialog"));
    placeNearTerm(button.current, tip.current);
  }
  return (
    <span className="term-tip">
      <button
        ref={button}
        type="button"
        className="term-tip-term"
        popoverTarget={id}
        aria-expanded={open}
        aria-label={`${shown}, what it means`}
      >
        {shown}
      </button>
      <span
        ref={tip}
        id={id}
        popover="auto"
        className="term-tip-pop"
        onToggle={onToggle}
      >
        <TipBody term={term} inDialog={inDialog} />
      </span>
    </span>
  );
}

function TipBody({ term, inDialog }: { term: TermId; inDialog: boolean }) {
  const entry = glossaryEntry(term);
  return (
    <>
      <strong className="term-tip-title">
        {entry.term}
        {entry.longForm && (
          <span className="term-tip-long"> · {entry.longForm}</span>
        )}
      </strong>
      <span className="term-tip-text">{plainDefinition(entry.definition)}</span>
      <Link
        to="/glossary"
        hash={glossaryAnchor(term)}
        className="term-tip-more"
        target={inDialog ? "_blank" : undefined}
        rel={inDialog ? "noopener" : undefined}
      >
        See all terms
      </Link>
    </>
  );
}

// A fixed popover would float away from its term as the page scrolls.
function useCloseOnScroll(
  open: boolean,
  tip: RefObject<HTMLSpanElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const close = () => tip.current?.hidePopover();
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [open, tip]);
}

// Below the term, or above it near the bottom of the screen, and inside the
// screen's width. getBoundingClientRect measures screen pixels, but top and
// left are read in the page's zoom (the "Larger text" setting zooms <html>),
// so they are divided back.
function placeNearTerm(term: HTMLElement, pop: HTMLElement) {
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const anchor = term.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - EDGE_GAP;
  const left = Math.max(EDGE_GAP, Math.min(anchor.left, maxLeft));
  const fitsBelow =
    anchor.bottom + BELOW_GAP + height <= window.innerHeight - EDGE_GAP;
  const top = fitsBelow
    ? anchor.bottom + BELOW_GAP
    : Math.max(EDGE_GAP, anchor.top - BELOW_GAP - height);
  pop.style.left = `${left / zoom}px`;
  pop.style.top = `${top / zoom}px`;
}
