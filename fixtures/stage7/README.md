# Stage 7 frozen replay fixtures

These files support **§7.2 Signal replay test** in `docs/STANDALONE_TRADING_POC_STAGES.md`.

| File | Purpose |
|------|---------|
| `replay_bars.json` | Frozen `Ohlcv[]` (1m spacing, same UTC day for VWAP continuity) |
| `indicators.golden.json` | Expected `computeBarIndicators` output (12 dp). Non-finite values are JSON `null` (= `NaN` in code). |
| `fsm_events.golden.json` | Expected `runFsmSeries` strategy events (kind, barIndex, reason) |
| `manifest.json` | Bar count, strategy snapshot, final FSM phase, schema version |

## Regenerate goldens (after intentional strategy / indicator changes)

From repo root:

```bash
npm run stage7:gen-golden
```

Then re-run `npm test` and commit updated JSON if outputs are correct.
