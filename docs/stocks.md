# 4S stock money printer

`stock-trader.js` is a standalone, long-only stock trader for the World Stock
Exchange. It intentionally does not run from the supervisor and does not share
ports or RAM ownership with the JIT daemon.

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

The trader is deliberately long-only. It uses 4S forecast and volatility to rank
opportunities by an estimated directional return per tick:

```text
edge ~= (2 * forecast - 1) * volatility / 2
```

Default entry/exit hysteresis:

- buy candidates at forecast >= 60%
- exit owned longs at forecast <= 55%

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
| `--entry-forecast` | `0.60` | Minimum 4S forecast to consider buying |
| `--exit-forecast` | `0.55` | Sell a long at or below this forecast |
| `--min-trade` | `25000000` | Minimum transaction size before commission |
| `--min-hold-ticks` | `6` | Horizon used by the friction check |
| `--min-profit-multiple` | `1.15` | Expected edge must exceed friction by this factor |
| `--max-buys-per-tick` | `4` | Limit new allocations per market update |
| `--ticks` | `0` | Number of market updates before exit; 0 = continuous |
| `--dry-run` | `false` | Print hypothetical trades without buying/selling |

The reserve is based on **portfolio equity**, not just current cash. This prevents
the reserve target from shrinking toward zero after each purchase and gives the
cloud/JIT ecosystem room to keep spending.

## Existing positions

Existing long positions are adopted and managed by the same exit rule. Existing
short positions are never modified and the trader will not add a long position
to a symbol that already has a short position.

Stopping the script never liquidates anything automatically. Manual trading while
the script is running is unsupported; stop the trader first.

## Dashboard

The script log shows:

- cash, equity, invested value and reserve
- open mark-to-market P/L
- realized sales P/L for this session
- trade count and commissions
- the strongest current 4S signals
- current exposure/reserve safety limits

Realized P/L follows the current owned average price and sale proceeds. Historical
entry commissions on positions that existed before this script started are not
reconstructed.

## Notes

This is an automated trading strategy, not a guaranteed-profit oracle. 4S forecast
is the game's actual next-tick direction probability, but forecasts change over
time, market cycles can flip, spreads and commissions are real, and large
transactions can influence stock forecasts.

The initial version intentionally avoids shorts because short APIs require
additional BitNode 8 / Source-File 8 access. A later version can add short
positions behind an explicit capability check.
