# 00 · Evidence policy

Floor sells trust. One false number on day one ends that. These rules apply to docs, slides, the demo, the README, tweets and code comments.

## Rules

1. **Every number has a source.** A primary source link (governance raw text, official report, protocol source code, docs) or an onchain reference (tx hash, block, contract + call). If only news or aggregators report it, label it **SECONDARY**.
2. **Prefer onchain.** Tx hashes, blocks, addresses, configs and timestamps are re-read from chain, not copied from articles. Pin the block number.
3. **Labels are mandatory** where they apply:
   - **ESTIMATE**: our own calculation or judgement (market size, odds, pricing).
   - **HYPOTHESIS**: something we believe but have not tested with customers.
   - **UNVERIFIED**: reported but not confirmed by us. Do not put on a slide.
   - **MODELLED**: a scenario figure (e.g. Aave's bad-debt scenarios), not a realised outcome.
4. **Scope every counterfactual.** Never "Floor would have stopped Kelp". Say exactly what was shown: "In our Aave Ethereum fork replay, the attacker's borrow reverts: $0 borrowed on Aave."
5. **Quote verbatim, attribute exactly.** Say who wrote it (LlamaRisk vs Aave Labs vs a community analyst) and where (thread + post number).
6. **Credit others' work.** If a finding comes from someone else, say so until we reproduce it ourselves. Then say "reproduced with Floor at block N".
7. **Ranges, not false precision.** When sources disagree, show the range and who says what.
8. **No "first" claims.** Use "we found no product that does all of X, Y, Z".
9. **Correct publicly.** If we find an error, fix it everywhere and note it in the changelog below.
10. **Every Floor grade links to evidence** (tx, block, storage slot or call), so anyone can re-check it.

## How to verify a claim

```bash
# onchain read at a pinned block (Foundry `cast`)
cast call <contract> "<sig>" <args> -b <block> -r https://eth.drpc.org
# timestamp of a block
cast block <block> -f timestamp -r https://eth.drpc.org
# Aave governance post as raw markdown (no summariser in between)
curl -s https://governance.aave.com/raw/<topicId>/<postNumber>
# Snapshot vote result
curl -s https://hub.snapshot.org/graphql -H 'content-type: application/json' \
  --data '{"query":"{proposal(id:\"<id>\"){title state scores choices}}"}'
```

## Corrections log

| Date | Old claim | Correct claim | Evidence |
|---|---|---|---|
| 2026-11-06 | "One key, no multisig controlled rsETH" | An EOA delegate made the Apr 2 2025 change. The owner was always a 3-of-6 Safe; the delegate moved to that Safe on Aug 25 2025. | `EndpointV2.delegates(adapter)` at blocks 23,218,825 / 23,218,826 |
| 2026-11-06 | "A Safe guard would have blocked Kelp's Apr 2 2025 setup" | False: the tx was sent directly by the EOA delegate, not via the Safe. | tx `0x2d48d933…0592` |
| 2026-11-06 | "Aave froze rsETH after 77 min" | ~88 min: first freeze 19:03:59 UTC, block 24,908,723 | block timestamps |
| 2026-11-06 | "Aave froze 292 reserves because it could not tell what was exposed" | The broad freeze was deliberate (stolen funds could be swapped into any asset). | governance.aave.com/raw/25954 |
| 2026-11-06 | "Aave framework not voted" | Passed Snapshot Jul 9 2026 (359,345 For / 0 Against) | Snapshot `0xe40b377b…66ac` |
| 2026-11-06 | "70% of 2026 losses from keys/infra" | 74–76% of H1 2026 losses (Blockaid; TRM Labs) | see 17-sources |
| 2026-11-06 | "$123–236M bad debt" | Aave modelled $123,708,727 / $230,113,582 (hypothetical) | governance.aave.com/raw/24580/1 |
| 2026-11-06 | "Several routes used LZ's default config" | All 26 Ethereum routes had explicit app configs pre-hack | evidence/onchain/cfg_pre.txt |
| 2026-11-06 | "LayerZero's default for Unichain is still 1 DVN" | The default's single DVN `0x747c…f6ac` is **LZDeadDVN** (never signs): the default disables the route | LayerZero metadata API `/v1/metadata/dvns` (`id: lz-dead-dvn`) |
| 2026-11-07 | "Only EtherFi weETH's main adapter is inbound rate-limited" (34 Ethereum adapters) | Three are: weETH `0xcd2e`, plus PYUSD `0xa2c3` and USDG `0x147b`, which mint on credit and enforce `RateLimitExceeded()` caps; the first run classed them "empty escrow". Also: the peer scan missed endpoint ids above 30499. | `docs/evidence/inbound/2026-11-07-ethereum-34.json`, docs/09 "All-chain rerun" |
| 2026-11-28 | Live market config watch: "FRAX, sFRAX, frxETH, sfrxETH, FPI, FXS (old) on Metis: 0 (single verifier)" (22 rows, red) | False positive. One Frax tx (`0xbb64fd58…3258`, Metis block 23,404,699) moved those routes' send and receive libraries to LayerZero's **BlockedMessageLib** (`0x1ccBf0db…D862`, `version()` = (2^64−1, 255, 2)): the routes are closed. The watcher scored the raw event (`requiredDVNCount = 0` means "inherit default", not "no verifier") on a library the OApps no longer use. The watcher now reads the effective route state (docs/07). | `cast call 0x1a44…728c "getReceiveLibrary(address,uint32)"` and `0x1ccB….version()` on Metis, 2026-11-28 |
| 2026-11-28 | Live market: "Kelp pattern: 0 · $0"; rsETH, USDC, WETH, weETH, WBTC, wstETH, USDe "inactive LayerZero adapter only" | Not measured. From Nov 7 the hourly Ethereum probe failed on every adapter: its cross-check on the second RPC (api.zan.top) errored and the error replaced the row; the guard only compared row counts, and the page read an error row as "inactive". Cross-checks now fall through providers, failed rows keep the last good result marked stale, and a failed probe is shown as "not checked". | `docs/evidence/inbound/latest-ethereum-34.json` history (23–29 error rows per run since 2026-11-07) |
| 2026-11-28 | Live market: "4 home-chain adapters can be emptied in one message" (Ink USD₮0, X Layer USD₮0, BNB BTCB, Optimism OP) | No inbound limit is correct, but escrow at stake was 0 / ~172 USD₮0 / 1.80 BTCB / 368,062 OP, and the weakest route of each needs 3 / 3 / 2 / 4 independent verifiers (full re-probe, 2026-11-28; X Layer DVNs are not in the operator snapshot, so its 3 counts addresses, not organisations). Not the Kelp pattern (which also needs one verifier). The page now marks red only "no inbound limit AND one verifier can approve". | `getUlnConfig` on each chain's ReceiveUln302, 2026-11-28; inbound probe rows |
