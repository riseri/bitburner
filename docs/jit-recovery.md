# JIT recovery and validation

This engine remains JIT: each phase is launched near its own action start, not all four actions at the beginning of a batch. Temporal RAM reservation, core-aware placement, the fleet manager, supervisor and contracts remain in use.

## Run after updating

Pull `main` after merging the PR and let `npm run dev` synchronize the entire `src` directory. Include the updated three workers, `fleet-manager.js`, and new `lib/jit-worker.js`, not just `daemon.js`.

On `home`, stop the old supervisor and daemon, then start the supervisor:

```text
kill supervisor.js
kill daemon.js
run supervisor.js
```

A missing-process message when stopping an already-exited script is harmless. The daemon replaces old remote workers during startup and deploys the worker dependency. Do not start a second daemon alongside the supervisor.

No special timing flags are required. Defaults are now a 100ms phase gap and a 600ms JIT launch cushion. Existing reservations retain their timing until an epoch change. When a hard recovery rebuilds the plan, the next gap is chosen with margin over measured loop lag and completion drift.

A new process still needs target preparation when dirty and one initial pipeline warmup. Auto-target ranking now subtracts both prep and warmup from its next-ten-minute revenue estimate; a ready target may outrank a much richer but unprepared one.

## Invariants

- Normal HGW actions start only at minimum security. Workers use `additionalMsec` immediately during the clean start window, rather than sleeping to a final 3ms window and re-reading a potentially invalid duration.
- A call-time pause latch stops new H calls regardless of how far in the future they would land. The controller also cancels imminent H PIDs that already invoked `ns.hack`; a port message cannot retract an already-started action.
- Local recovery has an immutable 15-second deadline, checked before deferred health polling. Repeated faults cannot extend it. Money and security must remain clean before the latch opens.
- A security excursion above minimum +5 is a circuit-breaker event. Stop planning, cancel damaging H/G work in bounded slices, retain useful W tails, then re-evaluate/prep. Do not keep launching batches against an invalid security model.
- Worker terminal events settle each chunk exactly once. Start events never release RAM. Split phases and out-of-order event delivery must not finalize a batch prematurely. Actual earned money is recorded even when the rest of the batch is recovered.
- Stale unplanned landing slots are skipped. Productive runtime is required before elective level/capacity retunes, preventing repeated warmup-only reconfiguration.
- A growing hacking level causes H threads to be capped at invocation against the reserved steal budget, with growth headroom. Large stat changes can still require safe reconfiguration.

## Diagnostics

`Hack status` prioritizes DRAINING and PAUSED over historical success. LIVE requires a recent hack completion. Miss reasons separate `launch +...ms` from `duration delta ...ms`; a security-inflated duration is not described as a multi-minute event-loop stall.

Judge a run by sustained `Income 60s`, paid batches, target health and fallback/restart counts after warmup, not by the modeled income alone. Local recoveries may suppress a small set of hacks. A hard fault can still require prep and another warmup; the guarantee is bounded escalation, not zero downtime under every failure.

## Tests

With Node 22:

```sh
npm test
```

The suite includes 24 deterministic regressions and five full-daemon simulations. It executes the actual daemon and worker source against a virtual Netscript clock, processes, ports, RAM and money/security model.

Scenarios cover 20 virtual minutes of long target actions with a shared 70ms timer stall, 20 minutes with an intentionally missed W2 start, 15 minutes of a faster target with skill growth, dirty-target prep, and a security-100 circuit breaker followed by renewed income. The deadline regression fails against the pre-fix daemon.

These are simulations, not an in-game soak. They do not emulate the Netscript RAM analyzer, Electron garbage collection, external scripts, browser suspension, or offline progress. Passing them is evidence for the tested invariants, not a claim of universal timing stability or a promised live income rate.
