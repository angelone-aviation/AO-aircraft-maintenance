/**
 * Responsibility: The Delete group button: previews what deleting a permission
 *   group changes, then deletes it on confirmation.
 * Layer: UI. The server plans and performs the deletion.
 * Dependencies: react, src/data/store.ts (useWorkspace), src/domain/model.ts
 *   (Group type), src/domain/groupDeletion.ts (plan type),
 *   src/components/ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import type { Group } from "../domain/model";
import type { GroupDeletionPlan } from "../domain/groupDeletion";
import { AsyncForm, Modal, errorText } from "./ui";

type Deletion = ReturnType<typeof useGroupDeletion>;

/**
 * Deletes a permission group once the user has seen its plan: each member who
 * loses the group, and whether they also lose access to the Flight Program.
 * Needs a connection.
 *
 * @param props.group - The group to delete.
 * @returns The button, and the confirmation dialog while open. Deleting sends
 *   the plan back, so the server refuses if the group or its members changed
 *   after the preview.
 */
export function DeleteGroupButton({ group }: { group: Group }) {
  const { online, connected } = useWorkspace();
  const deletion = useGroupDeletion(group);
  return (
    <>
      <button
        type="button"
        className="text-button"
        disabled={!online || !connected}
        onClick={deletion.open}
      >
        Delete group
      </button>
      {deletion.isOpen && (
        <Modal title={`Delete group · ${group.name}`} onClose={deletion.close}>
          <DeletionPlan deletion={deletion} />
        </Modal>
      )}
    </>
  );
}

function useGroupDeletion(group: Group) {
  const { backend } = useWorkspace();
  const [isOpen, setOpen] = useState(false);
  const [plan, setPlan] = useState<GroupDeletionPlan>();
  const [error, setError] = useState("");
  async function open() {
    setPlan(undefined);
    setError("");
    setOpen(true);
    try {
      setPlan(await backend!.previewGroupDeletion(group.id));
    } catch (e) {
      setError(errorText(e, "Unable to load group."));
    }
  }
  async function remove(confirmed: GroupDeletionPlan) {
    await backend!.deleteGroup(group.id, confirmed.expected);
    setOpen(false);
  }
  return { isOpen, plan, error, open, remove, close: () => setOpen(false) };
}

function DeletionPlan({ deletion }: { deletion: Deletion }) {
  const { online, connected } = useWorkspace();
  const { plan, error } = deletion;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!plan) return <p role="status">Loading affected users…</p>;
  return (
    <AsyncForm
      disabled={!online || !connected}
      submitLabel="Delete permission group"
      onSubmit={() => deletion.remove(plan)}
    >
      <p>
        Delete <strong>{plan.name}</strong>? This removes the group and its
        membership from {plan.users.length} user account(s). User accounts and
        their other groups are kept.
      </p>
      {plan.users.length > 0 && <AffectedUsers users={plan.users} />}
      <p>
        Permissions provided only by this group will be removed. Deleting a
        default group does not recreate it when this program is edited.
      </p>
      <button type="button" className="button" onClick={deletion.close}>
        Cancel
      </button>
    </AsyncForm>
  );
}

function AffectedUsers({ users }: { users: GroupDeletionPlan["users"] }) {
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>
          {u.name}
          {u.losesProgramAccess
            ? " — loses access to this Flight Program"
            : " — keeps access through other permissions"}
        </li>
      ))}
    </ul>
  );
}
