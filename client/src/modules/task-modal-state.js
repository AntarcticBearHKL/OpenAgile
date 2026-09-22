// Task modal state — shared sink; imports nothing, imported by every task-modal module.

export const state = {
  editingTaskId: null,
  selectedTaskKeyPoints: [], // [{ id, text, at }]
  editingKeyPointId: null,
  lastAddedKeyPointId: null,
  dialogAccess: { title: true, description: true, notes: true }
};
