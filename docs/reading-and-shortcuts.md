# Larger text, term tips, the Glossary and keyboard shortcuts

Features that make Angel One easier to read and quicker to use. None of them changes a record.

## Larger text

**Settings → This device → Text size → Larger text** makes the whole interface about a fifth larger (118%): text, buttons, fields and tap targets together, for older eyes and gloved hands. Like the theme, it is kept on this device only (`localStorage` key `angelone-large-text`) and applied before the first paint, so a reload never flashes the normal size.

The app's sizes are in pixels, so the setting uses CSS zoom on the page rather than a larger root font size. The layout breakpoints still read the real screen width; on tablets the top bar takes its compact phone form to make room, and the demo's preview buttons give way there. Every route is checked at phone and tablet sizes with larger text on and off (`tests/e2e/responsive.spec.ts`).

## Term tips

Some aviation words on the key screens are underlined with dots: **Hobbs** and **Tach** in the aircraft detail and the flight form, **deferred** and **MEL** on Discrepancies, **FAA** and **ADs** on Airworthiness directives. Tapping one, or pressing Enter or Space on it, opens a one- or two-sentence explanation; Escape, a tap elsewhere or scrolling closes it. **See all terms** opens the Glossary at that word (in a new tab when the tip is inside a dialog, so a half-filled form is not lost). Only the first occurrence on a screen carries a tip.

## Glossary

**Glossary**, in the Manage menu just above Settings (the last link for owners and board members), explains every term a reader outside aviation meets in the app: abbreviations with their long forms, record-keeping words, the status words (Airworthy, Due soon, Grounded, Overdue, Held for review) and the roles. Every signed-in role reaches it, owners and board members included, and it works offline. It has a search box, an A to Z letter bar, and an anchor for each term (`/glossary#term-mel`); a term opened that way is focused and highlighted. Definitions link to the other terms they use.

The text comes from one typed module, `src/domain/glossaryTerms.ts`, written for lay readers and kept consistent with [GLOSSARY.md](../GLOSSARY.md). Its tests require a definition of at most two sentences for every entry, no duplicate terms, links only to entries that exist, and a definition for every term a screen explains.

## Keyboard shortcuts

On computers, **/** moves to the page's search box, **N** opens the flight form for users who may log flights, and **?** lists the shortcuts. They do nothing while you type in a field, while Ctrl, Alt or Cmd is held, or while a dialog is open. The page footer shows "Press ? for keyboard shortcuts" only on devices with a mouse or trackpad; touch-only phones and tablets show no hint.
