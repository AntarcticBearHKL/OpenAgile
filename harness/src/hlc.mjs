// Node-side Hybrid Logical Clock. Mirrors client/src/modules/event-sourcing/hlc.js
// semantics (wallTime/counter/nodeId) but without any IndexedDB dependency, so it
// can run in the harness server. The pure client clock cannot be imported here
// because hlc.js transitively imports idb-store.js which requires IndexedDB.

export const MAX_DRIFT_MS = 60_000;

let current = { wallTime: 0, counter: 0, nodeId: null };

function warnDrift() {
  if (Date.now() - current.wallTime > MAX_DRIFT_MS && current.wallTime > 0) {
    console.warn('[harness] HLC drift exceeded 60000ms; accepting local wall time.');
  }
}

export function initHlc(nodeId) {
  current.nodeId = typeof nodeId === 'string' && nodeId ? nodeId : current.nodeId;
}

export function getNodeId() {
  return current.nodeId;
}

export function emitLocalSync() {
  if (!current.nodeId) current.nodeId = crypto.randomUUID();
  warnDrift();
  const now = Date.now();
  if (now > current.wallTime) {
    current.wallTime = now;
    current.counter = 0;
  } else {
    current.counter += 1;
  }
  return { wallTime: current.wallTime, counter: current.counter, nodeId: current.nodeId };
}

export async function observeRemote(remoteHlc) {
  if (!current.nodeId) current.nodeId = crypto.randomUUID();
  warnDrift();
  const now = Date.now();
  const remoteWall = Number.isFinite(remoteHlc?.wallTime) ? remoteHlc.wallTime : 0;
  const remoteCounter = Number.isFinite(remoteHlc?.counter) ? remoteHlc.counter : 0;
  const newWall = Math.max(now, current.wallTime, remoteWall);

  if (newWall === current.wallTime && newWall === remoteWall) {
    current.counter = Math.max(current.counter, remoteCounter) + 1;
  } else if (newWall === current.wallTime) {
    current.counter += 1;
  } else if (newWall === remoteWall) {
    current.counter = remoteCounter + 1;
  } else {
    current.counter = 0;
  }

  current.wallTime = newWall;
  return { wallTime: current.wallTime, counter: current.counter, nodeId: current.nodeId };
}

export function compareHlc(a, b) {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}
