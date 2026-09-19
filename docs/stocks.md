# 4S directional stock money printer

`stock-trader.js` is a 4S directional stock trader for the World Stock Exchange. The
normal deployment is supervisor-managed, while direct standalone runs remain
supported for smoke tests and dry runs. It has its own status port and does not
share JIT worker/control ports or RAM ownership with the hacking daemon.

## Hard access gate

The trader requires all of the following before it will wait for a stock tick or
make any trade:

- WSE Account
- TIX API Access
- 4S Market Data TIX API Access

It does **not** buy those upgrades automatically. If any required access is
missing at startup, the script exits without trading. The same check runs before
and after every `ns.stock.nextUpdate()`; if access disappears while the script is
running, it exits and leaves all existing positions untouched.

## Run

Continuous trading:

```text
run stock-trader.js
```

A finite smoke test:

```text
run stock-trader.js --ticks 10
```

Observe the decisions without touching money:

```text
run stock-trader.js --ticks 10 --dry-run true
```

The script waits on the native stock update promise rather than polling. Normal
stock updates are approximately every 6 seconds.

## Default strategy

The trader uses 4S forecast and volatility to rank directional opportunities by estimated return per tick. Longs use the normal edge and shorts use the mirrored bearish edge when shorting is unlocked:

```text
edge ~= (2 * forecast - 1) * volatility / 2
```

Default entry/exit hysteresis:

- buy long candidates at forecast >= 55%
- buy short candidates at forecast <= 45% when BitNode 8 / Source-File 8 level 2+ permits shorts
- exit owned longs at forecast <= 52%
- cover owned shorts at forecast >= 48%

Before buying, the candidate must also have enough estimated multi-tick edge to
cover the bid/ask spread plus both $100k commissions by the configured profit
multiple. Weak signals and tiny trades are skipped.

## Capital controls

Defaults:

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--cash-reserve` | `0.20` | Keep at least 20% of portfolio equity liquid |
| `--cash-floor` | `0` | Additional absolute cash floor |
| `--max-exposure` | `0.80` | Maximum total stock exposure |
| `--max-position` | `0.25` | Maximum exposure in one symbol |
| `--entry-forecast` | `0.55` | Minimum bullish forecast; bearish short threshold is mirrored at 45% |
| `--exit-forecast` | `0.52` | Exit threshold; short cover threshold is mirrored at 48% |
| `--min-trade` | `25000000` | Minimum transaction size before commission |
| `--min-hold-ticks` | `6` | Horizon used by the friction check |
| `--min-profit-multiple` | `1.10` | Expected edge must exceed friction by this factor |
| `--max-buys-per-tick` | `8` | Limit new allocations per market update |
| `--ticks` | `0` | Number of market updates before exit; 0 = continuous |
| `--dry-run` | `false` | Print hypothetical trades without buying/selling |

The reserve is based on **portfolio equity**, not just current cash. This prevents
the reserve target from shrinking toward zero after each purchase and gives the
cloud/JIT ecosystem room to keep spending. The shared `savings.js` goal adds an absolute floor for new
entries; it never prevents closing positions. See the root README for controls.

## Existing positions

Existing long positions are adopted and managed by the same exit rule. Existing
short positions are managed by the mirrored exit rule when shorting is unlocked;
without that capability they remain untouched. The trader will not add a long
position to a symbol that already has a short position.

Stopping the script never liquidates anything automatically. Manual trading while
the script is running is unsupported; stop the trader first.

## Dashboard

The script log shows:

- cash, equity, invested value and reserve
- open mark-to-market P/L
- realized **net** profit for this session
- average and last net profit per closed trade, plus win/loss count
- trade count and commissions
- the strongest current directional 4S signals
- current exposure/reserve safety limits
- current deployment versus the exposure cap and why capital may still be idle

For positions opened by the running trader, realized profit is net of both the buy
and sell commissions. The dashboard also shows average realized profit per closed
trade, the last closed trade's net profit, and closed-trade W/L. Historical entry
commissions on positions that already existed before this script started cannot be
reconstructed, so a later sale of one of those adopted positions can differ from
true lifetime profit by its unknown historical entry commissions.

## Notes

This is an automated trading strategy, not a guaranteed-profit oracle. 4S forecast
is the game's actual next-tick direction probability, but forecasts change over
time, market cycles can flip, spreads and commissions are real, and large
transactions can influence stock forecasts.

Shorting is enabled automatically only in BitNode 8 or when Source-File 8 level 2+ is active. Otherwise the same trader falls back to long-only behavior without attempting short APIs.


## Supervisor integration

The normal long-running deployment is now through `supervisor.js`. Stocks are
enabled by default:

```text
run supervisor.js
```

The supervisor creates a lifecycle record for `stock-trader.js` on
`PORTS.STOCK_STATUS` (port 13), adopts an existing trader without rewriting its
arguments, and restarts unexpected crashes with the same bounded lifecycle policy
used by the other managers.

Market access is a special gate. If WSE, TIX, or 4S TIX access is unavailable,
the stock service is shown as `BLOCKED` and is **not** repeatedly restarted. When
the required access becomes available again, normal lifecycle management resumes.
The trader itself still rechecks access before and after every stock update.

Disable supervised stocks explicitly with:

```text
run supervisor.js --stocks false
```

The supervisor dashboard shows stock equity, invested value, cash, shared cash
floor, unrealized P/L, realized net session profit, average/last closed-trade
profit, W/L, and the last trade action.

### Shared capital floor

Every healthy non-dry-run trader heartbeat publishes its current absolute reserve
floor. `fleet-manager.js` reads that status and uses the larger of:

- its own configured cloud cash floor,
- its percentage cloud reserve,
- the trader's published stock reserve floor.

This means cloud purchases/upgrades cannot intentionally spend through the
trader's cash reserve. The shared floor is ignored when the stock heartbeat is
stale, access is blocked, or the trader is in dry-run mode. No stock script
controls JIT scheduling or server allocation.


## Capital allocation

The trader no longer treats the exposure limit as a passive ceiling only. Qualified symbols receive a target position based on their 4S directional edge: the best edge can use the full per-symbol cap while weaker but still profitable edges receive a smaller allocation. Total exposure, per-symbol exposure, the shared cash reserve, maximum shares, spread, commissions, and the multi-tick friction check still cap every entry.

This is intentionally aggressive about using capital when the market presents real 4S edge, but it will still leave money idle instead of filling the portfolio with weak or negative-expectation positions.
