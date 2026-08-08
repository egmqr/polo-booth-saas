# Manage Photos Task Queue

## Scope

Apply one in-memory, sequential task queue to the Manage Photos modal in both applications:

- `egmdash/public/index.html`: add downloads to its existing upload/delete queue.
- `polo-booth-saas/dashboard/index.html`: add upload, delete, and download tasks to a new equivalent queue.

`polo-booth-gallery` is out of scope. No queue/progress feature was changed there, so no revert is required.

## Interface

Each Manage Photos modal has a persistent task panel directly below its header. It shows active task progress, queued tasks, latest completion/failure, and this warning: “Keep this window open. Closing it interrupts active and queued tasks.” The grid and controls stay usable while work runs.

## Queue behavior

Each modal owns one FIFO queue. Upload selections, single/bulk deletions, and every single/bulk/archive download become tasks. A task triggered while another task runs displays its queue position. Tasks run one at a time; a failed task is recorded and later tasks continue.

Multi-photo downloads remain one ZIP task. Panel progress reports each fetched photo, then compression progress. Grid refresh remains after upload/delete completion; downloads retain existing downloaded-state marking.

## Boundaries and verification

No Worker API or `polo-booth-gallery` changes. Queue state lives only in current browser session. Tests cover FIFO execution, continuation after failure, all Manage Photos mutation/download handlers enqueuing work, and panel/warning markup. Run each repository's full existing test suite.
