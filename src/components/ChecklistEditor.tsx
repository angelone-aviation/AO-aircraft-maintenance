import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import {
  checklistEditable,
  checklistId,
  checklistCounts,
  type ChecklistDocument,
  type ChecklistRecord,
  type ChecklistItem,
} from "../domain/checklists";
import { AsyncForm, Field, Modal } from "./ui";
function move<T>(items: T[], index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
}
export function ChecklistEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChecklistRecord;
  onClose: () => void;
  onSaved: (uuid: string) => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [record, setRecord] = useState(() => structuredClone(initial));
  const [dirty, setDirty] = useState(initial.version === 0);
  const [categoryIndex, setCategory] = useState(0);
  const [groupId, setGroup] = useState(
    initial.document.payload.groups[0]?.items[0]?.objectId ?? "",
  );
  const [listId, setList] = useState(
    initial.document.payload.groups[0]?.items[0]?.items[0]?.objectId ?? "",
  );
  const patch = (change: (doc: ChecklistDocument) => void) => {
    setRecord((current) => {
      const next = structuredClone(current);
      change(next.document);
      return next;
    });
    setDirty(true);
  };
  const category = record.document.payload.groups[categoryIndex];
  const groupIndex =
    category?.items.findIndex((g) => g.objectId === groupId) ?? -1;
  const group = category?.items[groupIndex];
  const listIndex = group?.items.findIndex((l) => l.objectId === listId) ?? -1;
  const list = group?.items[listIndex];
  const currentGroup = (d: ChecklistDocument) =>
    d.payload.groups[categoryIndex].items[groupIndex];
  const currentList = (d: ChecklistDocument) =>
    currentGroup(d).items[listIndex];
  const close = () => {
    if (!dirty || window.confirm("Discard unsaved checklist changes?"))
      onClose();
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const counts = checklistCounts(record.document);
  const addItem = (type?: "comment") =>
    patch((d) =>
      currentList(d).items.push({
        objectId: checklistId(),
        ...(type ? { type } : {}),
        title: "",
        detail: "",
        note: "",
      }),
    );
  const editItem = (index: number, changes: Partial<ChecklistItem>) =>
    patch((d) => {
      const item = currentList(d).items[index];
      Object.assign(item, changes);
      if (changes.type === undefined && "type" in changes) delete item.type;
    });
  return (
    <Modal
      title={initial.version ? "Edit checklist" : "Import / create checklist"}
      wide
      onClose={close}
    >
      <AsyncForm
        submitLabel="Save checklist"
        disabled={!online || !connected}
        onSubmit={async () => {
          if (!record.document.payload.metadata.name?.trim())
            throw new Error("Enter a checklist name.");
          await backend!.saveChecklist({
            record,
            baseVersion: initial.version,
          });
          onSaved(record.uuid);
        }}
      >
        <p>
          {counts.lists} checklists · {counts.entries} entries · {counts.checks}{" "}
          checkable items. Changes are saved together. Saving a new revision
          starts fresh personal checkmarks.
        </p>
        <div className="form-grid">
          <Field label="Checklist name">
            <input
              required
              maxLength={200}
              value={record.document.payload.metadata.name ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.payload.metadata.name = e.target.value;
                })
              }
            />
          </Field>
          <Field label="Tail number">
            <input
              maxLength={100}
              value={record.document.payload.metadata.tailNumber ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.payload.metadata.tailNumber = e.target.value;
                })
              }
            />
          </Field>
          <Field label="Aircraft description">
            <input
              maxLength={500}
              value={record.document.payload.metadata.detail ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.payload.metadata.detail = e.target.value;
                })
              }
            />
          </Field>
          <Field label="Checklist aircraft">
            <select
              value={record.aircraftUuid}
              onChange={(e) => {
                setRecord({ ...record, aircraftUuid: e.target.value });
                setDirty(true);
              }}
            >
              {checklistEditable(s!, "", record.programUuid) && (
                <option value="">Flight Program library (all aircraft)</option>
              )}
              {s!.aircraft
                .filter((a) =>
                  checklistEditable(s!, a.uuid, record.programUuid),
                )
                .map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.registration}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <div className="checklist-editor-select form-grid">
          <Field label="Checklist category">
            <select
              value={categoryIndex}
              onChange={(e) => {
                const n = Number(e.target.value);
                setCategory(n);
                setGroup(
                  record.document.payload.groups[n].items[0]?.objectId ?? "",
                );
                setList(
                  record.document.payload.groups[n].items[0]?.items[0]
                    ?.objectId ?? "",
                );
              }}
            >
              {record.document.payload.groups.map((c, i) => (
                <option value={i} key={c.objectId}>
                  {c.groupType}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Checklist group">
            <select
              value={group?.objectId ?? ""}
              onChange={(e) => {
                setGroup(e.target.value);
                setList(
                  category.items.find((g) => g.objectId === e.target.value)
                    ?.items[0]?.objectId ?? "",
                );
              }}
            >
              <option value="">Select group</option>
              {category?.items.map((g) => (
                <option key={g.objectId} value={g.objectId}>
                  {g.title || "Untitled group"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Checklist to edit">
            <select
              value={list?.objectId ?? ""}
              onChange={(e) => setList(e.target.value)}
            >
              <option value="">Select checklist</option>
              {group?.items.map((l) => (
                <option key={l.objectId} value={l.objectId}>
                  {l.title || "Untitled checklist"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="management-actions">
          {(["normal", "abnormal", "emergency"] as const)
            .filter(
              (type) =>
                !record.document.payload.groups.some(
                  (c) => c.groupType === type,
                ),
            )
            .map((type) => (
              <button
                type="button"
                className="button"
                key={type}
                onClick={() => {
                  const i = record.document.payload.groups.length;
                  patch((d) =>
                    d.payload.groups.push({
                      objectId: checklistId(),
                      groupType: type,
                      items: [],
                    }),
                  );
                  setCategory(i);
                  setGroup("");
                  setList("");
                }}
              >
                Add {type} category
              </button>
            ))}
          <button
            type="button"
            className="button"
            disabled={!category}
            onClick={() => {
              const id = checklistId();
              patch((d) =>
                d.payload.groups[categoryIndex].items.push({
                  objectId: id,
                  title: "New group",
                  items: [],
                }),
              );
              setGroup(id);
              setList("");
            }}
          >
            Add group
          </button>
          <button
            type="button"
            className="button"
            disabled={!group}
            onClick={() => {
              const id = checklistId();
              patch((d) =>
                currentGroup(d).items.push({
                  objectId: id,
                  title: "New checklist",
                  items: [],
                }),
              );
              setList(id);
            }}
          >
            Add checklist
          </button>
        </div>
        {group && (
          <div className="checklist-editor-section">
            <Field label="Group title">
              <input
                value={group.title}
                maxLength={20000}
                onChange={(e) =>
                  patch((d) => {
                    currentGroup(d).title = e.target.value;
                  })
                }
              />
            </Field>
            <div className="management-actions">
              <button
                type="button"
                className="button small"
                disabled={groupIndex === 0}
                onClick={() =>
                  patch((d) =>
                    move(d.payload.groups[categoryIndex].items, groupIndex, -1),
                  )
                }
              >
                Move group up
              </button>
              <button
                type="button"
                className="button small"
                disabled={groupIndex === category.items.length - 1}
                onClick={() =>
                  patch((d) =>
                    move(d.payload.groups[categoryIndex].items, groupIndex, 1),
                  )
                }
              >
                Move group down
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete group “${group.title}” and its checklists from this draft?`,
                    )
                  ) {
                    patch((d) =>
                      d.payload.groups[categoryIndex].items.splice(
                        groupIndex,
                        1,
                      ),
                    );
                    setGroup("");
                    setList("");
                  }
                }}
              >
                Delete group
              </button>
            </div>
          </div>
        )}
        {list && (
          <>
            <div className="checklist-editor-section">
              <Field label="Checklist title">
                <input
                  value={list.title}
                  maxLength={20000}
                  onChange={(e) =>
                    patch((d) => {
                      currentList(d).title = e.target.value;
                    })
                  }
                />
              </Field>
              <div className="management-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={listIndex === 0}
                  onClick={() =>
                    patch((d) => move(currentGroup(d).items, listIndex, -1))
                  }
                >
                  Move checklist up
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={listIndex === group.items.length - 1}
                  onClick={() =>
                    patch((d) => move(currentGroup(d).items, listIndex, 1))
                  }
                >
                  Move checklist down
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete checklist “${list.title}” from this draft?`,
                      )
                    ) {
                      patch((d) => currentGroup(d).items.splice(listIndex, 1));
                      setList("");
                    }
                  }}
                >
                  Delete checklist
                </button>
              </div>
            </div>
            <div className="checklist-edit-items">
              {list.items.map((item, i) => (
                <details
                  key={item.objectId}
                  ref={(element) => {
                    if (element && !item.title && !item.detail)
                      element.open = true;
                  }}
                >
                  <summary>
                    {i + 1}. {item.type === "comment" ? "Heading / note: " : ""}
                    {item.title || item.detail || "New entry"}
                  </summary>
                  <div className="form-grid">
                    <Field label={`Entry ${i + 1} type`}>
                      <select
                        value={item.type ?? "check"}
                        onChange={(e) =>
                          editItem(i, {
                            type:
                              e.target.value === "comment"
                                ? "comment"
                                : undefined,
                          })
                        }
                      >
                        <option value="check">Check item</option>
                        <option value="comment">Heading / note</option>
                      </select>
                    </Field>
                    <Field label={`Entry ${i + 1} challenge / heading`}>
                      <textarea
                        value={item.title ?? ""}
                        maxLength={20000}
                        onChange={(e) => editItem(i, { title: e.target.value })}
                      />
                    </Field>
                    <Field label={`Entry ${i + 1} response / detail`}>
                      <textarea
                        value={item.detail ?? ""}
                        maxLength={20000}
                        onChange={(e) =>
                          editItem(i, { detail: e.target.value })
                        }
                      />
                    </Field>
                    <Field label={`Entry ${i + 1} note`}>
                      <textarea
                        value={item.note ?? ""}
                        maxLength={20000}
                        onChange={(e) => editItem(i, { note: e.target.value })}
                      />
                    </Field>
                  </div>
                  {!!item.actions?.length && (
                    <p>
                      Additional source actions are retained for export; this
                      app does not execute them.
                    </p>
                  )}
                  <div className="management-actions">
                    <button
                      type="button"
                      className="button small"
                      aria-label={`Move entry ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() =>
                        patch((d) => move(currentList(d).items, i, -1))
                      }
                    >
                      ↑ Move up
                    </button>
                    <button
                      type="button"
                      className="button small"
                      aria-label={`Move entry ${i + 1} down`}
                      disabled={i === list.items.length - 1}
                      onClick={() =>
                        patch((d) => move(currentList(d).items, i, 1))
                      }
                    >
                      ↓ Move down
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Delete entry ${i + 1}`}
                      onClick={() => {
                        if (window.confirm("Delete this entry from the draft?"))
                          patch((d) => currentList(d).items.splice(i, 1));
                      }}
                    >
                      Delete entry
                    </button>
                  </div>
                </details>
              ))}
            </div>
            <div className="management-actions">
              <button
                type="button"
                className="button"
                onClick={() => addItem()}
              >
                Add check item
              </button>
              <button
                type="button"
                className="button"
                onClick={() => addItem("comment")}
              >
                Add heading / note
              </button>
            </div>
          </>
        )}
      </AsyncForm>
    </Modal>
  );
}
