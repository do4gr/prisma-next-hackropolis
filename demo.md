# Demo: Prisma Next Durable Workflows

**Scenario**: `onboard-user` — creates an account, waits for human approval, then provisions a Compute service. The run auto-progresses, retries on failure, and persists state as plain relational rows.

**Duration**: 3 minutes

---

## Setup (done before presenting)

```bash
# .env
DATABASE_URL="prisma+postgres://..."
PRISMA_API_TOKEN="..."
COMPUTE_PROJECT_ID="proj_abc"
COMPUTE_REGION="us-east-1"
```

```bash
pnpm build
pnpm --filter compute-app dev    # starts dispatcher loop automatically
pnpm --filter workflows-console dev  # http://localhost:5173
```

---

## 0:00–0:30 — Show the authoring surface

Open `workflows/onboard-user.ts`. Walk through it once:

```ts
import { awaitSignal, defineWorkflow, step } from '@prisma-next/extension-workflows'

export const onboardUser = defineWorkflow('onboard-user', [
  step('create-account', {
    timeout: '10s',
    retries: 3,
    async handler({ db, state, setState }) {
      const user = await db.users.create({ email: state.email, name: state.name })
      setState({ ...state, userId: user.id, status: 'awaiting-approval' })
    },
  }),

  awaitSignal('approval'),

  step('provision-compute-service', {
    timeout: '60s',
    retries: 5,
    backoff: 'exponential',
    async handler({ db, state, setState, attempt }) {
      if (attempt === 1) throw new Error('Compute API temporarily unavailable')

      const provisioned = await provisionComputeService({
        projectId: state.computeProjectId,
        region: state.computeRegion,
        serviceName: `onboard-${state.userId}`,
      })
      setState({ ...state, ...provisioned, status: 'provisioned' })
    },
  }),
])
```

**Say**: Plain TypeScript — no directives, no compiler magic. `defineWorkflow`, `step`, `awaitSignal`.

---

## 0:30–1:00 — Trigger

Run the trigger script in a terminal:

```ts
// scripts/demo-trigger.ts
const result = await db.workflows.trigger('onboard-user', {
  email: 'prismanaut@prisma.io',
  name: 'BloblobFoo',
  computeProjectId: process.env['COMPUTE_PROJECT_ID']!,
  computeRegion: process.env['COMPUTE_REGION']!,
})

console.log(result)
// { runId: 'run_01abc...', status: 'queued' }
```

Switch to the console immediately. Watch the status badge live:

```
queued  →  running  →  waiting_for_signal
```

**Say**: `trigger` returns instantly — it's a single row insert. The dispatcher picked it up, ran `create-account`, and parked the run waiting for a human.

---

## 1:00–1:30 — Paused at approval

Point at the console run detail:

```
Status: waiting_for_signal

State Fields
  email               prismanaut@prisma.io
  name                BloblobFoo
  userId              usr_xyz          ← written by create-account
  status              awaiting-approval

Step Timeline
  create-account   ✓  attempt 1   10:00:00Z – 10:00:01Z
  await-approval   ◷  waiting…

[Approve]  [Reject]
```

**Say**: State is already in the DB — `create-account` ran, wrote `userId`, and the run parked. No cost while waiting. The Approve button calls `db.workflows.signal(runId, 'approval', { approvalStatus: 'approved' })`.

---

## 1:30–2:30 — Approve and watch retry

Click **Approve** in the console. Watch the timeline update live:

```
waiting_for_signal  →  running  →  queued (retry)  →  running  →  completed
```

Step timeline as it unfolds:

```
create-account              ✓  attempt 1
await-approval              ◷  waited 00:01:12
provision-compute-service   ✗  attempt 1   "Compute API temporarily unavailable"
provision-compute-service   ✓  attempt 2
```

**Say**: The signal merged `approvalStatus: approved` into state and enqueued a job. Attempt 1 threw — the dispatcher scheduled a retry with exponential backoff, then re-ran automatically. Attempt 2 succeeded and wrote the Compute identifiers back into state.

---

## 2:30–3:00 — Final state + punchline

Point at the completed run detail:

```
Status: completed

State Fields
  userId                usr_xyz
  approvalStatus        approved
  computeServiceId      svc_...
  computeDeploymentUrl  https://onboard-usr_xyz.prisma-compute.io
  status                provisioned

Event Log
  run_started
  step_completed      create-account/1
  signal_awaited      approval
  signal_received     approval
  step_failed         provision-compute-service/1  "Compute API temporarily unavailable"
  step_scheduled      retry at 10:01:29Z
  step_completed      provision-compute-service/2
  run_completed
```

Then flip to a terminal and run:

```sql
SELECT field_name, string_value
FROM pn_workflow_state_fields
WHERE run_id = 'run_01abc...';
```

**Say**: Every state field is a typed row. No JSON blob, no deserialization. Any field is queryable and indexable directly in Prisma Postgres.

---

## What to have open before starting

| Window | Content |
|---|---|
| Editor | `workflows/onboard-user.ts` |
| Terminal A | ready to run `pnpm tsx scripts/demo-trigger.ts` |
| Browser | console at `http://localhost:5173` |
| Terminal B | ready to run the SQL query |

The retry backoff is set to 5 s for the demo so the audience sees attempt 1 fail and attempt 2 succeed within the same 60-second window.
