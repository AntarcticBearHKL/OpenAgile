#!/usr/bin/env node
// Deterministic stub worker used to verify the supervisor end-to-end.
//
// The supervisor passes the task context in OPENAGILE_* environment variables and
// reads this process's stdout as the report. A real worker command would do actual
// work here; the supervisor never assumes any particular agent CLI.
//
// Optional env:
//   STUB_WORKER_DELAY_MS  sleep this long before reporting (lets heartbeats run)
//   STUB_WORKER_FAIL=1    emit the report and exit non-zero (failure path)
//   STUB_WORKER_EMPTY=1   exit 0 without printing anything (exercises the report gate)

const taskId = process.env.OPENAGILE_TASK_ID || 'unknown';
const taskKey = process.env.OPENAGILE_TASK_KEY || 'unknown';
const boardId = process.env.OPENAGILE_BOARD_ID || 'unknown';
const title = process.env.OPENAGILE_TASK_TITLE || '';

const delayMs = Number(process.env.STUB_WORKER_DELAY_MS || 0);
const shouldFail = process.env.STUB_WORKER_FAIL === '1';
const shouldBeEmpty = process.env.STUB_WORKER_EMPTY === '1';

function report() {
  if (shouldBeEmpty) {
    process.exitCode = 0;
    return;
  }
  const lines = [
    `REPORT: stub worker completed ${taskId}`,
    `evidence: key=${taskKey} board=${boardId} pid=${process.pid} title=${JSON.stringify(title)} at=${new Date().toISOString()}`
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (shouldFail) {
    process.stderr.write('stub worker: forced failure\n');
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

if (Number.isFinite(delayMs) && delayMs > 0) {
  setTimeout(report, delayMs);
} else {
  report();
}
