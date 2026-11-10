/**
 * Responsibility: The three-way merge behind "Keep mine" in a stale-save
 *   review: puts only the fields the user changed since opening a record on
 *   top of the record as it is now, lists every field either side changed
 *   in plain words, and refuses when both changed one fact.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./fieldDiff.
 *
 * A stale draft is never saved whole: that silently put back what the other
 * person had just saved, such as an AD action's next due after their
 * compliance (GLOSSARY "Stale save").
 */
import {
  DEFAULT_IGNORED_FIELDS,
  EMPTY_FIELD_TEXT,
  formatField,
  sameValue,
  specOf,
  type FieldDifference,
  type FieldSpec,
  type FieldSpecs,
} from "./fieldDiff";

/**
 * Fields that describe one fact, such as a required action's due limits.
 * When both people changed any of them the copies cannot be combined.
 */
export interface FieldGroup {
  /** The fact in plain words, to finish "you both changed …". */
  what: string;
  /** Field paths: names joined by "."; a list's items are not named, so
   * "tasks.dueHours" is that field of every task, judged task by task. */
  fields: readonly string[];
}

/** How one kind of record merges. */
export interface MergeRules<T> {
  /** Puts a copy in the form to compare, for example without values the
   * server derives on every save. */
  prepare?: (record: T) => T;
  /** Paths the server computes or only appends to: always left as stored. */
  serverOwned?: readonly string[];
  /** Facts that only one person may have changed. */
  together?: readonly FieldGroup[];
}

/** One field either person changed, and what Keep mine does with it. */
export interface MergedField extends FieldDifference {
  changedBy: "you" | "them" | "both";
  /** Whose value Keep mine stores; "neither" when it cannot be combined. */
  keeps: "mine" | "theirs" | "neither";
}

/** The outcome of {@link mergeKeepMine}. */
export interface KeepMineMerge<T> {
  /** Every field the two saves differ on, in the draft's order. */
  fields: MergedField[];
  /** The record Keep mine saves; absent when {@link blocked} is not empty. */
  merged?: T;
  /** Why the copies cannot be combined, one plain sentence each. */
  blocked: string[];
}

/** The three copies of a record a stale save involves. */
export interface RecordCopies<T> {
  /** The record as the form loaded it. */
  base: T;
  /** The record as the user's form would save it. */
  mine: T;
  /** The record as it is stored now. */
  theirs: T;
}

/**
 * Combines a stale draft with the record as it is now. A field only the user
 * changed takes the user's value; one only the other person changed keeps
 * theirs; one both changed takes the user's unless a rule forbids it. Lists
 * whose items carry an id merge item by item, in the stored order with the
 * user's new items last. Only fields the draft carries are merged, and the
 * bookkeeping fields ({@link DEFAULT_IGNORED_FIELDS}) stay as stored.
 *
 * @param copies - The loaded, drafted and current copies.
 * @param options - Labels for the fields, and the record kind's rules.
 * @returns The differing fields with their outcome, and the merged record
 *   unless a rule blocks it.
 */
export function mergeKeepMine<T extends object>(
  copies: RecordCopies<T>,
  options: { specs?: FieldSpecs<T>; rules?: MergeRules<T> } = {},
): KeepMineMerge<T> {
  const rules: MergeRules<T> = options.rules ?? {};
  const prepare = rules.prepare ?? ((record: T) => record);
  const walk: Walk = { serverOwned: rules.serverOwned ?? [], leaves: [] };
  const [base, mine, theirs] = [copies.base, copies.mine, copies.theirs].map(
    (copy) => prepare(copy) as Fields,
  );
  const merged: Fields = {};
  for (const key of Object.keys(mine)) {
    if (DEFAULT_IGNORED_FIELDS.includes(key)) {
      merged[key] = theirs[key];
      continue;
    }
    const spec = specOf(key, (options.specs as SpecMap | undefined)?.[key]);
    const node = { key, rulePath: key, label: spec.label, spec, scope: TOP };
    merged[key] = mergeNode(walk, node, pick(key, base, mine, theirs));
  }
  const blocked = applyGroups(walk.leaves, rules.together ?? []);
  return {
    fields: walk.leaves.map(toField),
    blocked,
    ...(blocked.length ? {} : { merged: merged as T }),
  };
}

type Fields = Record<string, unknown>;
type SpecMap = Record<string, string | FieldSpec | undefined>;
type Triple = { base: unknown; mine: unknown; theirs: unknown };

/** Where a value sits: how it is named, ruled and grouped. */
interface Node {
  /** Unique within the record: field names and item ids joined by ".". */
  key: string;
  /** The same without item ids, as rules name it. */
  rulePath: string;
  label: string;
  spec: FieldSpec;
  /** The list item the value belongs to, as key and label; "" at the top. */
  scope: Scope;
}
interface Scope {
  key: string;
  label: string;
}
interface Leaf extends MergedField {
  rulePath: string;
  scope: Scope;
  /** A sentence, when the leaf alone blocks the merge. */
  blocks?: string;
}
interface Walk {
  serverOwned: readonly string[];
  leaves: Leaf[];
}

const TOP: Scope = { key: "", label: "" };
const DEFAULT_ITEM_KEY = "uuid";
const LABEL_SEPARATOR = " · ";

function pick(key: string, base: Fields, mine: Fields, theirs: Fields): Triple {
  return { base: base[key], mine: mine[key], theirs: theirs[key] };
}

function mergeNode(walk: Walk, node: Node, values: Triple): unknown {
  if (walk.serverOwned.includes(node.rulePath)) {
    if (!sameValue(values.theirs, values.base))
      walk.leaves.push(leaf(node, values, "them", "theirs"));
    return values.theirs;
  }
  const itemKey = node.spec.itemKey ?? DEFAULT_ITEM_KEY;
  if (isKeyedLists(values, itemKey))
    return mergeList(walk, node, values, itemKey);
  if (isObjects(values)) return mergeObject(walk, node, values);
  return mergeLeaf(walk, node, values);
}

function mergeLeaf(walk: Walk, node: Node, values: Triple): unknown {
  const { base, mine, theirs } = values;
  // The same to a reader: the draft's own spelling of a blank is the one its
  // save is known to accept.
  if (sameValue(mine, theirs)) return mine;
  if (sameValue(mine, base)) {
    walk.leaves.push(leaf(node, values, "them", "theirs"));
    return theirs;
  }
  const changedBy = sameValue(theirs, base) ? "you" : "both";
  walk.leaves.push(leaf(node, values, changedBy, "mine"));
  return mine;
}

function mergeObject(walk: Walk, node: Node, values: Triple): Fields {
  const [base, mine, theirs] = [values.base, values.mine, values.theirs].map(
    (value) => (isFields(value) ? value : {}),
  );
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  const merged: Fields = {};
  for (const key of keys) {
    const spec = specOf(key, (node.spec.fields as SpecMap | undefined)?.[key]);
    const child: Node = {
      key: `${node.key}.${key}`,
      rulePath: `${node.rulePath}.${key}`,
      label: node.label + LABEL_SEPARATOR + spec.label,
      spec,
      scope: node.scope,
    };
    const value = mergeNode(walk, child, pick(key, base, mine, theirs));
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

// The stored order, without the items the user removed, then the items the
// user added: a form never reorders a list, so the stored order is kept.
function mergeList(walk: Walk, node: Node, values: Triple, itemKey: string) {
  const [base, mine, theirs] = [values.base, values.mine, values.theirs].map(
    (value) => byId(value, itemKey),
  );
  const merged: unknown[] = [];
  for (const id of new Set([...theirs.keys(), ...mine.keys()])) {
    const item = {
      base: base.get(id),
      mine: mine.get(id),
      theirs: theirs.get(id),
    };
    const index = [...(item.mine ? mine : theirs).keys()].indexOf(id);
    const label =
      node.spec.item?.(item.mine ?? item.theirs ?? {}, index) ??
      `${node.label} ${index + 1}`;
    const scope = { key: `${node.key}.${id}`, label };
    const child = { ...node, key: scope.key, label, scope };
    const kept =
      item.mine && item.theirs
        ? mergeObject(walk, child, item)
        : mergeLoneItem(walk, child, item);
    if (kept !== undefined) merged.push(kept);
  }
  return merged;
}

// An item only one copy holds: added by its holder, or removed by the other.
// A removal stands only when the remaining copy is untouched; otherwise one
// person's edit would vanish with the other's removal.
function mergeLoneItem(walk: Walk, node: Node, item: Triple): unknown {
  const byYou = item.mine !== undefined;
  const lone = byYou ? item.mine : item.theirs;
  if (item.base === undefined) {
    walk.leaves.push({
      ...itemLeaf(node, byYou ? "you" : "them", byYou ? "mine" : "theirs"),
      mine: byYou ? ITEM_ADDED : EMPTY_FIELD_TEXT,
      theirs: byYou ? EMPTY_FIELD_TEXT : ITEM_ADDED,
    });
    return lone;
  }
  const edited = !sameValue(lone, item.base);
  const remover = byYou ? "them" : "you";
  walk.leaves.push({
    ...itemLeaf(node, edited ? "both" : remover, byYou ? "theirs" : "mine"),
    mine: byYou ? (edited ? ITEM_CHANGED : ITEM_KEPT) : ITEM_REMOVED,
    theirs: byYou ? ITEM_REMOVED : edited ? ITEM_CHANGED : ITEM_KEPT,
    ...(edited && {
      keeps: "neither" as const,
      blocks: `${node.label}: one of you removed it and the other changed it.`,
    }),
  });
  return undefined;
}

const ITEM_ADDED = "Added";
const ITEM_REMOVED = "Removed";
const ITEM_CHANGED = "Changed";
const ITEM_KEPT = "Unchanged";

function itemLeaf(
  node: Node,
  changedBy: Leaf["changedBy"],
  keeps: Leaf["keeps"],
): Leaf {
  const { key, label, rulePath, scope } = node;
  return {
    key,
    label,
    rulePath,
    scope,
    changedBy,
    keeps,
    mine: "",
    theirs: "",
  };
}

function leaf(
  node: Node,
  values: Triple,
  changedBy: Leaf["changedBy"],
  keeps: Leaf["keeps"],
): Leaf {
  return {
    ...itemLeaf(node, changedBy, keeps),
    mine: formatField(values.mine, node.spec),
    theirs: formatField(values.theirs, node.spec),
  };
}

// Adds the sentences of leaves blocked on their own to those of the groups.
function applyGroups(leaves: Leaf[], groups: readonly FieldGroup[]) {
  const blocked = leaves.flatMap((l) => (l.blocks ? [l.blocks] : []));
  for (const group of groups)
    blocked.push(
      ...blockGroup(
        leaves.filter((l) => inGroup(l, group)),
        group,
      ),
    );
  return blocked;
}

// Per list item: when both people changed fields of the group, what the user
// changed there can be neither saved nor dropped silently.
function blockGroup(members: Leaf[], group: FieldGroup) {
  const reasons: string[] = [];
  for (const scope of new Set(members.map((l) => l.scope.key))) {
    const inScope = members.filter((l) => l.scope.key === scope);
    const yours = inScope.filter((l) => l.changedBy !== "them");
    if (!yours.length || inScope.every((l) => l.changedBy === "you")) continue;
    for (const l of yours) l.keeps = "neither";
    const where = inScope[0].scope.label;
    reasons.push(`${where ? `${where}: ` : ""}you both changed ${group.what}.`);
  }
  return reasons;
}

function inGroup(l: Leaf, group: FieldGroup) {
  return group.fields.some(
    (field) => l.rulePath === field || l.rulePath.startsWith(`${field}.`),
  );
}

function toField(l: Leaf): MergedField {
  const { key, label, mine, theirs, changedBy, keeps } = l;
  return { key, label, mine, theirs, changedBy, keeps };
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Both current copies are objects; the loaded copy may not have had the
// field yet.
function isObjects({ base, mine, theirs }: Triple) {
  return isFields(mine) && isFields(theirs) && (isFields(base) || base == null);
}

// Each copy is a list of objects that all carry the id (or is unset), and at
// least one copy has an item: any other list is compared as one value.
function isKeyedLists(values: Triple, itemKey: string) {
  const lists = [values.base, values.mine, values.theirs];
  const keyed = (value: unknown) =>
    value == null ||
    (Array.isArray(value) &&
      value.every((v) => isFields(v) && typeof v[itemKey] === "string"));
  return (
    lists.every(keyed) && lists.some((l) => Array.isArray(l) && l.length > 0)
  );
}

function byId(list: unknown, itemKey: string) {
  const items = Array.isArray(list) ? (list as Fields[]) : [];
  return new Map(items.map((item) => [String(item[itemKey]), item]));
}
