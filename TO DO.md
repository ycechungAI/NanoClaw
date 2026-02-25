# TO DO

Ordered by severity (highest first). Each item combines:

- Issue from architecture analysis section 2
- Improvement from scalability section 3

## P0 - Critical

- [x] Fix unregistered-chat trigger pipeline mismatch
      Issue: `processAnyChatTriggers` depends on DB data for unregistered chats, but WhatsApp currently stores full messages only for registered chats.
      Action: Persist the minimum trigger metadata for unregistered chats (or adjust ingestion/query flow) so "any chat trigger" works reliably.

## P1 - High

- [x] Split `src/index.ts` into dedicated services
      Issue: `src/index.ts` is a hotspot mixing lifecycle, routing, auth checks, queue coordination, and channel wiring.
      Action: Refactor into `MessageIngestionService`, `ConversationService`, and `RuntimeCoordinator` with explicit dependency injection.

- [x] Reduce polling + synchronous I/O in hot paths
      Issue: Current polling loops and repeated sync file access in message processing/IPC limit throughput and scalability.
      Action: Move toward event-driven ingestion where possible; add adaptive polling/backpressure where not; remove per-message sync file reads.

- [ ] Move dashboard runtime code into tracked, typed source
      Issue: Dashboard implementation under `groups/main/*` is mostly untracked by git, increasing drift and maintenance risk.
      Action: Relocate dashboard server/UI into tracked source (or a package) with type-checking and tests.

## P2 - Medium

- [ ] Make container runtime truly pluggable
      Issue: Setup supports multiple runtimes, but runtime execution is effectively Docker-specific.
      Action: Implement runtime adapters and select via config so setup/runtime behavior cannot diverge.

- [ ] Consolidate database schema ownership
      Issue: Schema definitions/mutations are duplicated across core runtime and setup code.
      Action: Centralize schema + migrations in one module and make setup call shared DB initialization/migration APIs.

- [ ] Remove merge workflow duplication in skills-engine
      Issue: Similar merge/rerere pipelines are duplicated across apply/update/replay flows.
      Action: Extract a shared internal merge workflow module and reuse it across skills-engine operations.

---

## Performance Review TODO (ordered by severity)

## P0 - Critical

- [x] Eliminate sync config reads in hot message paths
      Issue: `allowed_senders.json` is read synchronously in high-frequency code paths, blocking the event loop.
      Action: Cache parsed config in memory with mtime or file-watch invalidation; use `Set` membership checks for sender filtering.

- [x] Add missing composite indexes for message query patterns
      Issue: Hot `messages` queries filter by `chat_jid`/`sender` with `timestamp`, but schema only guarantees a single-column timestamp index.
      Action: Add and validate indexes like `(chat_jid, timestamp)` and `(sender, timestamp)`; move `excludeJids` filtering into SQL (`NOT IN`) to avoid JS post-filter scans.

## P1 - High

- [x] Replace polling-heavy loops with event-driven flow where feasible
      Issue: Core runtime uses fixed polling loops for message processing, IPC scanning, and scheduling, creating constant wakeups and wasted CPU.
      Action: Use fs-watch/chokidar for IPC directories, enqueue processing on events, and use next-run timers for scheduler wakeups when possible.

- [x] Remove repeated container startup filesystem churn
      Issue: Container startup repeatedly copies agent-runner source and rereads `model.txt` on each run.
      Action: Copy runner source only when content hash/version changes; cache model configuration with mtime-based refresh.

- [x] Stop rewriting full task/group snapshots on every run
      Issue: Full snapshot files are rewritten frequently, causing avoidable I/O and scaling cost as task count grows.
      Action: Write only on change (content hash) or update snapshots incrementally by affected task/group.

## P2 - Medium

- [x] Add queue backpressure and `O(1)` queue primitives
      Issue: Queue management uses linear operations (`includes`, `shift`) and outgoing chat queue is effectively unbounded during disconnections.
      Action: Use `Set` + deque/ring buffer; enforce queue size limits and explicit drop/retry policy.

- [x] Optimize dashboard data access and API caching
      Issue: Dashboard endpoints repeatedly open/close DB connections and run date-function queries that reduce index effectiveness.
      Action: Reuse DB handle + prepared statements, switch to timestamp range predicates, and add short TTL caching for expensive stats endpoints.

- [x] Tighten container resource defaults and log retention
      Issue: Long idle container lifetime and per-run log writes can increase memory/disk pressure.
      Action: Lower/adapt `IDLE_TIMEOUT`, keep concurrency tunable, and implement log rotation or retention caps.
