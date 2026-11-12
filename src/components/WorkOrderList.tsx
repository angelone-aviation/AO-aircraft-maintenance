/**
 * Responsibility: The work orders list (one card per order with its status,
 *   progress and requested work) and the chart of orders by status.
 * Layer: UI. Presentational components; progress rules live in src/domain.
 * Dependencies: @phosphor-icons/react, src/domain (model, workOrders,
 *   shopCharts), ./charts, ./design, ./ShopList.
 *
 * The list stays a real <table>, laid out as cards by shop.css, because rows
 * and cells are what people's screen readers and the browser specs go by.
 */
import {
  CaretDown,
  CheckCircle,
  Circle,
  ClipboardText,
  Hourglass,
  Package,
  Prohibit,
  Wrench,
} from "@phosphor-icons/react";
import type { Snapshot } from "../domain/model";
import {
  workOrderProgress,
  type WorkOrder,
  type WorkTask,
} from "../domain/workOrders";
import { workOrderStatusCounts } from "../domain/shopCharts";
import type { ChartTone } from "./chartData";
import { StackedBar } from "./charts";
import {
  ProgressTrack,
  SectionHeading,
  StatusPill,
  type IconType,
  type Tone,
} from "./design";
import { ShopTableCard } from "./ShopList";

type Status = WorkOrder["status"];
type Progress = ReturnType<typeof workOrderProgress>;

// Amber marks an order that waits on someone else; green only a finished one.
// The chart instead keeps amber for parts delay alone and draws awaiting
// approval in the deep blue: two amber bands side by side would read as one.
// Every chart fill reaches 3:1 on the card in both themes.
const STATUS_LOOK: Record<
  Status,
  { tone: Tone; icon: IconType; chart: ChartTone }
> = {
  open: { tone: "neutral", icon: ClipboardText, chart: "slate" },
  "in-progress": { tone: "blue", icon: Wrench, chart: "1" },
  "awaiting-approval": { tone: "warn", icon: Hourglass, chart: "3" },
  "parts-delay": { tone: "warn", icon: Package, chart: "warn" },
  completed: { tone: "good", icon: CheckCircle, chart: "good" },
  cancelled: { tone: "neutral", icon: Prohibit, chart: "5" },
};

const TASK_ICON: Record<WorkTask["status"], IconType> = {
  requested: Circle,
  "in-progress": Wrench,
  "parts-delay": Package,
  completed: CheckCircle,
  cancelled: Prohibit,
};

/**
 * The work orders as cards: number and aircraft, status, a progress bar with
 * the count of finished tasks, the order's facts, and its tasks on request.
 *
 * @param props.list - The orders, in the order to show them.
 * @param props.onSelect - Called with an order when its Details is pressed.
 * @returns A table named "Work orders" with one row per order.
 */
export function WorkOrderCards({
  s,
  list,
  onSelect,
}: {
  s: Snapshot;
  list: WorkOrder[];
  onSelect: (order: WorkOrder) => void;
}) {
  return (
    <ShopTableCard label="Work orders" className="shop-order-cards">
      <table className="shop-table">
        <thead>
          <tr>
            <th>Work order</th>
            <th>Opened / status</th>
            <th>Supervisor</th>
            <th>Requested work</th>
            <th>Open discrepancies</th>
            <th>Parts delays</th>
            <th>Job cards</th>
            <th>Actions</th>
            <th>Tasks</th>
          </tr>
        </thead>
        <tbody>
          {list.map((w) => (
            <OrderRow key={w.uuid} s={s} order={w} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

/**
 * A bar of the work orders split by status, over a legend with each count
 * and share. Hidden on phones, where each card's pill says the same.
 *
 * @param props.orders - The orders in view, closed ones included.
 * @returns The chart card, or nothing when there are no orders.
 */
export function WorkOrderStatusChart({ orders }: { orders: WorkOrder[] }) {
  const counts = workOrderStatusCounts(orders);
  if (!counts.length) return null;
  return (
    <section className="ds-card shop-chart-card shop-hide-phone">
      <SectionHeading
        title="By status"
        note={`${orders.length} work ${orders.length === 1 ? "order" : "orders"}, closed ones included`}
      />
      <StackedBar
        label="Work orders by status"
        segments={counts.map(({ status, count }) => ({
          label: statusLabel(status),
          value: count,
          tone: STATUS_LOOK[status].chart,
        }))}
      />
    </section>
  );
}

/**
 * A work order's status as a pill: the status in words with its icon.
 *
 * @param props.status - Such as "parts-delay", shown as "Parts delay".
 */
export function WorkOrderStatusPill({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  const { tone, icon } = STATUS_LOOK[status];
  return (
    <StatusPill tone={tone} icon={icon} className={className}>
      {statusLabel(status)}
    </StatusPill>
  );
}

function OrderRow({
  s,
  order: w,
  onSelect,
}: {
  s: Snapshot;
  order: WorkOrder;
  onSelect: (order: WorkOrder) => void;
}) {
  const progress = workOrderProgress(s, w);
  return (
    <tr className="shop-order lift">
      <td className="shop-order-lead">
        <strong>{w.number}</strong>
        <small>{w.aircraft.registration}</small>
      </td>
      <td className="shop-order-opened" data-label="Opened">
        {w.dateOpened}
        <WorkOrderStatusPill status={w.status} className="shop-order-status" />
      </td>
      <td data-label="Supervisor">
        {w.supervisor || "Unassigned"}
        <small className="shop-priority">{w.priority}</small>
      </td>
      <ProgressCell progress={progress} done={w.status === "completed"} />
      <CountCell label="Open discrepancies" tone="shop-count-danger">
        {progress.outstandingDiscrepancies}
      </CountCell>
      <CountCell label="Parts delays" tone="shop-count-warn">
        {progress.partsDelays}
      </CountCell>
      <td data-label="Job cards">
        {progress.taskCardsCompleted} of {progress.taskCardsTotal}
      </td>
      <td className="shop-order-actions">
        <button className="button small" onClick={() => onSelect(w)}>
          Details
        </button>
      </td>
      <td className="shop-order-tasks">
        <OrderTasks tasks={w.tasks} />
      </td>
    </tr>
  );
}

function ProgressCell({
  progress: { completed, total },
  done,
}: {
  progress: Progress;
  done: boolean;
}) {
  return (
    <td className="shop-order-progress">
      <ProgressTrack
        tone={done ? "good" : "blue"}
        value={total ? completed / total : 0}
      />
      <span>
        {completed} of {total} {total === 1 ? "task" : "tasks"}
      </span>
    </td>
  );
}

// A count of zero is muted; any other count takes the given tone.
function CountCell({
  label,
  tone,
  children: count,
}: {
  label: string;
  tone: string;
  children: number;
}) {
  return (
    <td data-label={label}>
      <span className={count ? tone : "shop-zero"}>{count}</span>
    </td>
  );
}

function OrderTasks({ tasks }: { tasks: WorkTask[] }) {
  if (!tasks.length) return null;
  return (
    <details>
      <summary>
        <CaretDown size={14} weight="bold" aria-hidden="true" />
        Requested work
      </summary>
      <ul>
        {tasks.map((task) => (
          <TaskLine key={task.uuid} task={task} />
        ))}
      </ul>
    </details>
  );
}

function TaskLine({ task }: { task: WorkTask }) {
  const Icon = TASK_ICON[task.status];
  const done = task.status === "completed";
  return (
    <li className={done ? "done" : undefined}>
      <Icon size={18} weight={done ? "fill" : "regular"} aria-hidden="true" />
      <span>{task.description}</span>
      <small>
        {statusLabel(task.status)}
        {task.partsDelay && `: ${task.partsDelay}`}
      </small>
    </li>
  );
}

// "parts-delay" reads "Parts delay".
function statusLabel(status: string): string {
  const words = status.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
