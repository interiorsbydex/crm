# Launch-flow harness runner (test-only)

Run only in a persistent background shell, from `server/`. The application entrypoint and normal Vitest config are not used.

1. After choosing to start the isolated runner, create its one-shot nonsecret opt-in and run:

   ```sh
   printf '%s\n' 'LAUNCH_FLOW_HARNESS_ENABLE_V1' > /tmp/launch_flow_harness.enable
   ./node_modules/.bin/vitest run --config src/testing/launchFlow.harness.config.ts --reporter=dot
   ```

   The opt-in marker is consumed immediately. Do not set `LENIENT_LAUNCH` or any other environment flag.

2. Startup binds only to `127.0.0.1` on an OS-assigned ephemeral port. Read `/tmp/launch_flow_harness_endpoint.json` without printing its `controlToken`; its `port` gives the health URL:

   ```text
   http://127.0.0.1:<port>/api/__harness/health
   ```

   Expected before initialization: `marker: "launch-flow-transaction-harness"`, `transactionOpen: false`, `credentialsCreated: false`, `workersStarted: false`. First confirm the browser's `/api` interception reaches this endpoint. **Do not initialize or enter login credentials until that browser health check succeeds.**

3. Only after that check, send `POST http://127.0.0.1:<port>/__harness/initialize` with header `x-launch-harness-control` set from the endpoint JSON. This creates disposable Auth accounts and opens the outer rollback-only Prisma transaction. The handler returns only after six scoped profiles/targets are seeded and read back.

4. During the journey, authenticated `GET /__harness/status` reports fixture IDs and counts only. Outbound mail/SMS/WhatsApp/notifications are captured in memory. Prisma writes run through one interactive transaction; shared lead/project counters are virtualized, candidate user queries/writes are scoped to the disposable profile IDs, and lead/project IDs are rewritten to `TEST-` values. No workers/jobs are started.

5. On completion, send `POST /__harness/rollback` with the same control header, then wait for the Vitest process to exit. The outer transaction is intentionally aborted; exact storage objects and Auth IDs are cleaned and verified. Read the nonsecret manifest at `/tmp/launch_flow_harness_manifest.json` before removing it.

Control paths, on the same loopback port:

```text
GET  /__harness/status
POST /__harness/initialize
POST /__harness/rollback       # after initialization; preferred graceful stop
POST /__harness/stop           # before initialization only; creates no fixtures
```

Temporary files: `/tmp/launch_flow_harness.enable` (one-shot opt-in), `/tmp/launch_flow_harness_endpoint.json` (port/control token), `/tmp/launch_flow_harness_credentials.json` (synthetic secrets; never print), and `/tmp/launch_flow_harness_manifest.json` (nonsecret evidence). Normal completion removes the opt-in, endpoint, and credentials files; preserve/read the manifest, then remove it. Never SIGKILL the runner while the transaction is open; use the rollback control path and allow cleanup to finish.
