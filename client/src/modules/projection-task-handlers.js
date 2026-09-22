import { isDoneColumn } from './constants.js';

export function applyTaskCreated(state, event) {
  if (state.taskTombstones.has(event.entity_id) || state.tasks.some((task) => task.id === event.entity_id)) return state;
  return {
    ...state,
    tasks: [...state.tasks, { id: event.entity_id, ...(event.payload?.task || event.payload?.fields || {}) }]
  };
}

export function applyTaskUpdated(state, event) {
  if (state.taskTombstones.has(event.entity_id)) return state;
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  return {
    ...state,
    tasks: state.tasks.map((task) => (
      task.id === event.entity_id ? { ...task, ...fields } : task
    ))
  };
}

export function applyTaskMoved(state, event) {
  if (state.taskTombstones.has(event.entity_id)) return state;
  const order = Array.isArray(event.payload?.order) ? event.payload.order : [];
  const orderByTaskId = new Map(order.map((entry) => [entry.id, entry]));

  return {
    ...state,
    tasks: state.tasks.map((task) => {
      const entry = orderByTaskId.get(task.id);
      if (!entry) return task;

      const nextTask = {
        ...task,
        column: typeof entry.column === 'string' ? entry.column : task.column,
        order: Number.isFinite(entry.order) ? entry.order : task.order
      };

      if (task.id === event.entity_id && task.column !== nextTask.column) {
        const history = Array.isArray(task.columnHistory) && task.columnHistory.length
          ? [...task.columnHistory]
          : [{ column: task.column, at: task.creationDate || task.changeDate || event.at }];
        history.push({ column: nextTask.column, at: event.at });
        nextTask.columnHistory = history;

        // Derive doneDate from the move so it replays from events alone (ADR-0005):
        // entering the done column stamps it, leaving clears it.
        const wasDone = isDoneColumn(state.columns.find((column) => column.id === task.column));
        const isDone = isDoneColumn(state.columns.find((column) => column.id === nextTask.column));
        if (isDone && !wasDone) {
          nextTask.doneDate = event.at;
        } else if (wasDone && !isDone) {
          delete nextTask.doneDate;
        }
      }

      return nextTask;
    })
  };
}

export function applyTaskDeleted(state, event) {
  const nextTombstones = new Set(state.taskTombstones);
  nextTombstones.add(event.entity_id);
  return {
    ...state,
    tasks: state.tasks.filter((task) => task.id !== event.entity_id),
    taskTombstones: nextTombstones
  };
}
