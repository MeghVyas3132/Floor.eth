#!/usr/bin/env tsx
/**
 * Config-change watch (the "event" layer of the live dashboard). For every chain with an Aave V3 market, read the
 * LayerZero logs since the last run and keep the ones that touch a LayerZero deployment of an Aave-listed token
 * (adapter on its home chain, or OFT minted on that chain):
 *   ReceiveUln302  UlnConfigSet(oapp, eid, config)      verifier set / confirmations changed
 *   EndpointV2     ReceiveLibrarySet(receiver, eid, lib) receive library changed (pinning)
 *   EndpointV2     DelegateSet(oapp, delegate)           who can change the config
 *
 * The event only says WHICH route changed. What the route looks like afterwards is read onchain (docs/07 rule 1:
 * effective state only): the receive library actually in use, whether it is LayerZero's BlockedMessageLib (route
 * closed), and the config merged with defaults (a raw `requiredDVNCount = 0` means "inherit the default", not
 * "no verifier"). A config written to a library the OApp does not use is reported as such, not as a weakness.
 * Reads are made at the event's block; where the RPC has no archive state, at the latest block (`resolvedAt` says which).
 *
 * State (last block per chain) and events are written to docs/evidence/watch/, committed by the scheduler, and shown
 * on the Live market tab. Read-only: no key needed.
 *
 *   pnpm --filter @floor/resolver exec tsx src/watch-cli.ts [--lookback 200]
 *   ... --reresolve            re-read the effective state of every recorded event (after a rule fix)
 *   ... --range <chainId>:<from>:<to>   scan only that window and print, write nothing (tests, backfills)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import markets from "@floor/deployments/aave-markets.json" with { type: "json" };
import { createPublicClient, decodeEventLog, fallback, getAddress, http, parseAbi, type Address, type PublicClient } from "viem";
import { effectiveReceiveRoute, type EffectiveRoute } from "./effective.js";

const ROOT = resolve(new URL("../../../", import.meta.url).pathname);
const DIR = resolve(ROOT, "docs/evidence/watch");
const STATE = resolve(DIR, "state.json");
const EVENTS = resolve(DIR, "events.json");
const lookback = Number(process.argv[process.argv.indexOf("--lookback") + 1] || 200);
const rangeArg = process.argv.includes("--range") ? process.argv[process.argv.indexOf("--range") + 1]!.split(":").map(Number) : null;
const reresolve = process.argv.includes("--reresolve");
const CHUNK = 500n; // several free RPCs cap eth_getLogs ranges

const abi = parseAbi([
  "event UlnConfigSet(address oapp, uint32 eid, (uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs) config)",
  "event ReceiveLibrarySet(address receiver, uint32 eid, address newLib)",
  "event DelegateSet(address sender, address delegate)",
]);

type Lz = { chainKey: string; eid: number; endpoint: string; receiveUln302: string | null; logRpcs?: string[] };
type Tok = { kind: string; oapp: string; symbol: string };
const LZ = markets.layerzero as Record<string, Lz>;
const BRIDGED = markets.bridged as unknown as Record<string, Record<string, Tok>>;
/** fallback when no log-capable RPC was found */
const rpcsFor = (chainId: number) => markets.markets.find((m) => m.chainId === chainId)?.rpcs ?? [];
const clientFor = (chainId: number, lz: Lz) => {
  const rpcs = lz.logRpcs?.length ? lz.logRpcs : rpcsFor(chainId);
  return rpcs.length ? (createPublicClient({ transport: fallback(rpcs.map((u) => http(u, { timeout: 20_000, retryCount: 1 }))) }) as PublicClient) : null;
};

type WatchEvent = {
  chainId: number; chain: string; block: number; timestamp?: number; tx: string; logIndex: number; event: string; symbol: string; kind: string; oapp: string;
  eid?: number; emitter?: string;
  /** raw values from the event (kept for audit; NOT a score) */
  rawRequiredDVNs?: number; rawOptionalThreshold?: number; newLib?: string; delegate?: string;
  /** effective state of the route after the change, read onchain */
  effective?: EffectiveRoute & { resolvedAt: number | "latest"; inUse?: boolean };
  /** true only when the route is LIVE, the library that emitted the change is the one in use, and one operator can verify */
  singleVerifier?: boolean;
  // legacy fields from before effective resolution (dropped on --reresolve)
  requiredDVNs?: number; optionalThreshold?: number;
};

const state: { updatedAt?: string; chains: Record<string, { block: number; checkedAt: string; error?: string }> } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { chains: {} };
// --range starts empty so the window is scanned fresh, not deduplicated against what is already recorded.
const events: WatchEvent[] = existsSync(EVENTS) && !rangeArg ? JSON.parse(readFileSync(EVENTS, "utf8")) : [];
const seen = new Set(events.map((e) => `${e.chainId}:${e.tx}:${e.logIndex}`));
let found = 0;

/** Resolve the route's effective state at the event block, falling back to latest when the RPC has no archive state. */
async function resolveEvent(client: PublicClient, lz: Lz, e: WatchEvent): Promise<void> {
  if (e.eid === undefined || e.event === "DelegateSet") return;
  const endpoint = getAddress(lz.endpoint);
  const oapp = getAddress(e.oapp);
  let eff = await effectiveReceiveRoute(client, endpoint, oapp, e.eid, lz.chainKey, BigInt(e.block));
  let at: number | "latest" = e.block;
  if (eff.status === "UNKNOWN") {
    eff = await effectiveReceiveRoute(client, endpoint, oapp, e.eid, lz.chainKey);
    at = "latest";
  }
  // A UlnConfigSet on a library the OApp does not receive through changes nothing that matters today.
  const inUse = e.event === "UlnConfigSet" && e.emitter && eff.library ? eff.library.toLowerCase() === e.emitter.toLowerCase() : undefined;
  e.effective = { ...eff, resolvedAt: at, ...(inUse === undefined ? {} : { inUse }) };
  e.singleVerifier = eff.status === "LIVE" && inUse !== false && eff.verifiers !== null && eff.verifiers <= 1;
  delete e.requiredDVNs;
  delete e.optionalThreshold;
}

if (reresolve) {
  for (const e of events) {
    const lz = LZ[String(e.chainId)];
    const client = lz ? clientFor(e.chainId, lz) : null;
    if (!lz || !client) continue;
    if (e.rawRequiredDVNs === undefined && e.requiredDVNs !== undefined) {
      e.rawRequiredDVNs = e.requiredDVNs;
      e.rawOptionalThreshold = e.optionalThreshold;
    }
    // Events recorded before `emitter` existed: UlnConfigSet is only read from the chain's ReceiveUln302.
    if (e.event === "UlnConfigSet" && !e.emitter && lz.receiveUln302) e.emitter = getAddress(lz.receiveUln302);
    try {
      if (e.timestamp === undefined) e.timestamp = Number((await client.getBlock({ blockNumber: BigInt(e.block) })).timestamp);
      await resolveEvent(client, lz, e);
    } catch (err) {
      console.warn(`reresolve ${e.chain} ${e.tx}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  events.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || b.block - a.block);
  writeFileSync(EVENTS, JSON.stringify(events, null, 1) + "\n");
  const single = events.filter((e) => e.singleVerifier).length;
  console.log(`reresolve: ${events.length} events re-read; ${single} single-verifier; ${events.filter((e) => e.effective?.status === "CLOSED").length} on closed routes`);
  process.exit(0);
}

await Promise.all(
  Object.entries(LZ).map(async ([cid, lz]) => {
    const chainId = Number(cid);
    if (rangeArg && chainId !== rangeArg[0]) return;
    const tokens = Object.values(BRIDGED[cid] ?? {});
    const byOapp = new Map(tokens.map((t) => [t.oapp.toLowerCase(), t]));
    const client = clientFor(chainId, lz);
    if (!byOapp.size || !client) return;
    try {
      const latest = rangeArg ? BigInt(rangeArg[2]!) : await client.getBlockNumber();
      const prev = state.chains[cid]?.block;
      let from = rangeArg ? BigInt(rangeArg[1]!) : prev ? BigInt(prev) + 1n : latest - BigInt(lookback);
      const addresses = [lz.endpoint, lz.receiveUln302].filter(Boolean) as Address[];
      while (from <= latest) {
        const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
        const logs = await client.getLogs({ address: addresses, events: abi, fromBlock: from, toBlock: to });
        for (const log of logs) {
          const d = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName: string; args: Record<string, unknown> };
          const oapp = String(d.args.oapp ?? d.args.receiver ?? d.args.sender).toLowerCase();
          const t = byOapp.get(oapp);
          if (!t) continue;
          const key = `${chainId}:${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const cfg = d.args.config as { requiredDVNCount: number; optionalDVNThreshold: number } | undefined;
          const e: WatchEvent = {
            chainId, chain: lz.chainKey, block: Number(log.blockNumber), tx: log.transactionHash!, logIndex: log.logIndex!,
            event: d.eventName, symbol: t.symbol, kind: t.kind, oapp, emitter: getAddress(log.address),
            eid: d.args.eid !== undefined ? Number(d.args.eid) : undefined,
            rawRequiredDVNs: cfg?.requiredDVNCount, rawOptionalThreshold: cfg?.optionalDVNThreshold,
            newLib: d.args.newLib as string | undefined, delegate: d.args.delegate as string | undefined,
          };
          try {
            e.timestamp = Number((await client.getBlock({ blockNumber: log.blockNumber! })).timestamp);
          } catch {
            /* ordering falls back to discovery order */
          }
          await resolveEvent(client, lz, e);
          events.push(e);
          found++;
        }
        from = to + 1n;
      }
      if (!rangeArg) state.chains[cid] = { block: Number(latest), checkedAt: new Date().toISOString() };
    } catch (e) {
      state.chains[cid] = { ...(state.chains[cid] ?? { block: 0 }), checkedAt: new Date().toISOString(), error: (e as Error).message.split("\n")[0]!.slice(0, 140) };
    }
  }),
);

if (rangeArg) {
  console.log(JSON.stringify(events.filter((e) => e.chainId === rangeArg[0] && Number(e.block) >= rangeArg[1]! && Number(e.block) <= rangeArg[2]!), null, 1));
  process.exit(0);
}
state.updatedAt = new Date().toISOString();
mkdirSync(DIR, { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
// Newest first. Block numbers are per chain and not comparable across chains, so order by block time when known.
const order = (e: WatchEvent) => e.timestamp ?? 0;
writeFileSync(EVENTS, JSON.stringify(events.sort((a, b) => order(b) - order(a) || b.block - a.block).slice(0, 500), null, 1) + "\n");
const failed = Object.entries(state.chains).filter(([, s]) => s.error);
console.log(`watch: ${Object.keys(state.chains).length} chains checked, ${found} new config events on tracked bridges, ${failed.length} chain errors`);
for (const [c, s] of failed) console.log(`  chain ${c}: ${s.error}`);
