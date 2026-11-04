/**
 * Responsibility: The Delete group button: previews what deleting a permission
 *   group changes, then deletes it on confirmation.
 * Layer: UI. React component; the server plans and performs the deletion.
 * Dependencies: react, src/data/store.ts, src/domain/model.ts (types),
 *   src/domain/groupDeletion.ts (types), ./ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import type { Group } from "../domain/model";
import type { GroupDeletionPlan } from "../domain/groupDeletion";
import { AsyncForm, Modal, errorText } from "./ui";
export function DeleteGroupButton({ group }: { group: Group }) {
  const { backend, online, connected } = useWorkspace();
  const [open, setOpen] = useState(false),
    [plan, setPlan] = useState<GroupDeletionPlan>(),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="text-button"
        disabled={!online || !connected}
        onClick={async () => {
          setPlan(undefined);
          setError("");
          setOpen(true);
          try {
            setPlan(await backend!.previewGroupDeletion(group.id));
          } catch (e) {
            setError(errorText(e, "Unable to load group."));
          }
        }}
      >
        Delete group
      </button>
      {open && (
        <Modal
          title={`Delete group · ${group.name}`}
          onClose={() => setOpen(false)}
        >
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : !plan ? (
            <p role="status">Loading affected users…</p>
          ) : (
            <AsyncForm
              disabled={!online || !connected}
              submitLabel="Delete permission group"
              onSubmit={async () => {
                await backend!.deleteGroup(group.id, plan.expected);
                setOpen(false);
              }}
            >
              <p>
                Delete <strong>{plan.name}</strong>? This removes the group and
                its membership from {plan.users.length} user account(s). User
                accounts and their other groups are kept.
              </p>
              {plan.users.length > 0 && (
                <ul>
                  {plan.users.map((u) => (
                    <li key={u.id}>
                      {u.name}
                      {u.losesProgramAccess
                        ? " — loses access to this Flight Program"
                        : " — keeps access through other permissions"}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                Permissions provided only by this group will be removed.
                Deleting a default group does not recreate it when this program
                is edited.
              </p>
              <button
                type="button"
                className="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </AsyncForm>
          )}
        </Modal>
      )}
    </>
  );
}
