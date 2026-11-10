/**
 * Responsibility: The Glossary page: every term in plain words, A to Z, with
 *   search, a letter jump bar and an anchor per term for term tips to open.
 * Layer: UI. React screen over the domain glossary; no workspace data.
 * Dependencies: react, @tanstack/react-router, src/domain/glossaryTerms.ts,
 *   ./design, src/styles/screens/glossary.css.
 *
 * For readers outside aviation: board members, owners, office staff and
 * partners. Every signed-in role reaches it, and it needs no connection.
 */
import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  definitionParts,
  glossaryAnchor,
  groupByLetter,
  searchGlossary,
  termFromAnchor,
  type GlossaryEntry,
  type TermId,
  type LetterGroup,
} from "../domain/glossaryTerms";
import { EmptyState, PageHeader, SearchField } from "./design";
import "../styles/screens/glossary.css";

const LETTER_PREFIX = "glossary-letter-";

/**
 * The Glossary page. Opening it at `#term-<id>` clears the search, scrolls
 * to that term, focuses it and highlights it.
 *
 * @returns The page: search, letter bar and the grouped terms.
 */
export function GlossaryPage() {
  const [query, setQuery] = useState("");
  const target = useTermTarget(setQuery);
  const groups = groupByLetter(searchGlossary(query));
  const count = groups.reduce((n, g) => n + g.entries.length, 0);
  return (
    <div className="glossary">
      <PageHeader
        eyebrow="HELP"
        title="Glossary"
        description="The aviation and record-keeping words used in Angel One, in plain language."
      />
      <div className="glossary-tools">
        <SearchField label="Search terms" value={query} onChange={setQuery} />
        <p className="glossary-count" role="status">
          {count === 1 ? "1 term" : `${count} terms`}
        </p>
      </div>
      {groups.length > 0 && <LetterBar groups={groups} />}
      {groups.length ? (
        groups.map((g) => (
          <LetterSection key={g.letter} group={g} target={target} />
        ))
      ) : (
        <EmptyState title="No matching terms">
          Try a shorter word, or clear the search to see every term.
        </EmptyState>
      )}
    </div>
  );
}

function LetterBar({ groups }: { groups: LetterGroup[] }) {
  return (
    <nav className="glossary-letters" aria-label="Jump to letter">
      {groups.map((g) => (
        <a
          key={g.letter}
          href={`#${LETTER_PREFIX}${letterId(g.letter)}`}
          aria-label={g.letter === "#" ? "Numbers" : g.letter}
        >
          {g.letter}
        </a>
      ))}
    </nav>
  );
}

function LetterSection({
  group,
  target,
}: {
  group: LetterGroup;
  target: TermId | undefined;
}) {
  const id = LETTER_PREFIX + letterId(group.letter);
  return (
    <section className="glossary-group" aria-labelledby={id}>
      <h2 id={id} tabIndex={-1}>
        {group.letter === "#" ? "Numbers" : group.letter}
      </h2>
      <dl>
        {group.entries.map((e) => (
          <Term key={e.id} entry={e} highlighted={target === e.id} />
        ))}
      </dl>
    </section>
  );
}

function Term({
  entry,
  highlighted,
}: {
  entry: GlossaryEntry;
  highlighted: boolean;
}) {
  return (
    <div className={"glossary-term" + (highlighted ? " target" : "")}>
      <dt id={glossaryAnchor(entry.id)} tabIndex={-1}>
        {entry.term}
        {entry.longForm && (
          <span className="glossary-long">{entry.longForm}</span>
        )}
      </dt>
      <dd>
        {definitionParts(entry.definition).map((p, i) =>
          p.link ? (
            <Link key={i} to="/glossary" hash={glossaryAnchor(p.link)}>
              {p.text}
            </Link>
          ) : (
            p.text
          ),
        )}
      </dd>
    </div>
  );
}

// Follows the address's #term-<id>: clears the search when the term changes,
// so it is listed, then scrolls to it and moves focus there, for keyboard and
// screen reader users arriving from a term tip.
function useTermTarget(setQuery: (query: string) => void) {
  const hash = useRouterState({ select: (r) => r.location.hash });
  const target = termFromAnchor(hash.replace(/^#/, ""));
  const [seen, setSeen] = useState(hash);
  if (hash !== seen) {
    setSeen(hash);
    if (target) setQuery("");
  }
  useEffect(() => {
    if (!target) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(glossaryAnchor(target));
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, [target, hash]);
  return target;
}

// "#" is not valid in an id's link target; numbers get their own word.
function letterId(letter: string) {
  return letter === "#" ? "numbers" : letter;
}
