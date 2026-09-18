# Validated coding-contract automation

The manager supports the 30 contract names in the upstream game catalog checked
for this change. Runtime discovery reports unknown types instead of guessing.
Singularity is not required. This change does not alter JIT scheduling, supervision,
shared RAM allocation, progression actions, or the combined dashboard renderer.

## Upgrade and start

Stop the old supervisor first so it cannot relaunch an old contract manager. Stop
only the old contract manager by its PID. The hacking daemon and fleet can remain
running. Sync these files together (imports must be available on home):

- `contract-manager.js`, `contract-solvers.js`, `contract-selftest.js`
- `lib/contract-safety.js`, `lib/contract-fixtures.js`

Run the in-game self-test before starting the updated manager:

```text
run contract-selftest.js
```

It first checks deterministic examples and then generates 100 dummy contracts per
supported type advertised by the running game. Only types passing **both** checks
get a certificate. Missing, failed, interrupted, or obsolete validation never
allows real submissions. A successful dummy test is evidence, not a proof that a
solver can never fail. Node tests provide additional independent randomized and
exhaustive oracles.

After it finishes, start your normal supervisor. It starts the manager with safe
defaults. Inspect the contract manager's script log for a current inventory and
explicit skip reasons. Port 18 retains the existing status fields and adds
`waiting`, `blockers`, and `contracts`; `found` is now distinct file locations
seen in this manager session, not the number of repeated observations.
`unsupported` counts current unsupported files, while `quarantined` counts blocked
solver types. During a scan the inventory is partial and `scanning` is true.
The combined supervisor presentation is deliberately unchanged to avoid overlap
with the separate JIT work.

To run diagnostic-only calculations:

```text
run contract-manager.js --dry-run true
```

Only run one manager. Stop the supervisor first when changing manager flags, then
restart it after manually starting the configured manager so it adopts those
arguments. Existing custom `--fleet-port`, `--port`, and `--interval` flags remain.

## Validation and quarantine

Certificates in `contract-validation.txt` bind to the exact bytes of
`contract-solvers.js`, not just a manually edited version number. Syncing a changed
solver invalidates approval. Restart the manager and rerun validation after a
solver update; do not hot-update source while validation is running.

Focused validation and explicit quarantine recovery:

```text
run contract-selftest.js --type "Square Root"
run contract-selftest.js --type "Square Root" --retry-quarantined true
```

The second command can pardon only the exact old quarantine failure recorded
when validation started, and only after all checks pass. A newer failure cannot
be cleared by that certificate. Existing legacy array-format quarantine files
are preserved. Ordinary self-tests do not erase previous quarantines.

`--samples` accepts 1..1000. Values below 100 are useful for diagnostics but cannot
authorize automatic real submissions. Unsupported game types are recorded as
unapproved and do not crash the rest of the test.

The self-test can run alongside the **updated** manager: it first sets validation
status to `running`, which pauses submissions, and records exact dummy ownership.
Dummy filenames are not distinguishable from real filenames in the game. Cleanup
only removes filenames returned to this self-test and recorded in its ownership
list. A killed test leaves submissions paused until the test is rerun. Never run
it beside an older manager that does not understand the validation file.

## Submission safety

Real submissions require a valid certificate and no effective quarantine. A
contract with one remaining try is preserved unless the manager was explicitly
started with:

```text
run contract-manager.js --allow-last-try true
```

This flag does not bypass validation or quarantine. A one-try contract can still
be destroyed by an incorrect answer; enabling the flag accepts that game risk.

Before every attempt the manager rechecks the certificate, source revision,
contract type/data and remaining attempts. It persists an intent receipt in
`contract-attempts.txt` **before** invoking the game API. A failed submission
quarantines its entire solver type and is not retried. A crash between intent and
result, or an API exception with uncertain outcome, requires manual review rather
than an automatic retry. Type revalidation does not erase old per-contract
receipts. Receipt identity includes host, filename, type and full input, including
BigInts. A genuinely different payload at the same filename is a different entry.

Separate file writers avoid lost quarantine updates: the self-test writes only
validation; the manager writes quarantine and receipts. Malformed state or failed
writes stop submissions. The receipt store stops admitting new entries at 10,000
rather than discarding safety history silently. Back up and inspect these files
before manually repairing/archiving state; deleting them discards retry protection.
Persistence covers script restarts in the current saved game, not unsaved progress
lost in a browser/game crash or a rollback to an older save.

## Performance and tests

Prime-factor search, segmented prime counting, expression search, parenthesis
sanitization, and LZ compression support cooperative yielding. Manager heartbeats
continue during scans, solving and idle waits. The game API's own validation work
can still take time; this is not a promise of zero JIT impact.

Run all tests through the existing `npm test`/CI discovery, or only this feature:

```text
node --test test/contract-solvers.test.cjs test/contract-runtime.test.cjs
```

Tests cover every solver with deterministic cases; randomized/exhaustive checks
cover BigInt rounding, single-bit Hamming correction, optimal LZ output, inclusive
prime ranges, zero-rectangle coordinates, expression precedence, grid paths,
stocks, jumping and parentheses. Runtime tests cover fail-closed approval,
quarantine migration, one-try opt-in, crash receipts, source changes, dummy
ownership, concurrency and inventory deduplication.

Upstream references checked (public dev branch; the running game's dummy validator
is authoritative for that installation):
- `src/CodingContract/Enums.ts`
- `src/CodingContract/contracts/{SquareRoot,Compression,HammingCode,TotalPrimesInRange,LargestRectangle}.ts`
- `src/CodingContract/ContractGenerator.ts`
- `src/NetscriptFunctions/CodingContract.ts`

Notable semantics: Square Root rounds to the nearest integer (decimal string
answer), Total Number of Primes includes both endpoints, and Largest Rectangle
returns two corners of a largest rectangle containing **zeroes**, not its area.
