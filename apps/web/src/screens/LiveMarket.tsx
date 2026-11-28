import { useEffect, useMemo, useState } from "react";
import { MARKETS, readMarket, type MarketState, type Reserve } from "@floor/live";
import aaveMarkets from "@floor/deployments/aave-markets.json";
import { Card, Stat } from "../components/ui";

/**
 * Live market: every Aave V3 market read straight from its chain every minute (packages/live), joined with the
 * inbound-limit probe of LayerZero adapters (docs/evidence/inbound, also published on Arkiv as floor.adapter).
 * No Floor server: the browser reads the chains itself.
 */
type ProbeRoute = { eid: number; status: "LIVE" | "CLOSED" | "UNKNOWN"; verifiers: number | null };
type ProbeRow = {
  oapp: string; outcome?: string; error?: string; kind?: string; eids?: number[]; escrowTokens?: number | null;
  results?: { outcome: string; maxAcceptedSD: string | null; proof: string }[]; sharedDecimals?: number;
  /** eid -> peer address (lowercase); present from the 2026-11-28 probe on */
  peers?: Record<string, string>; routes?: ProbeRoute[];
  /** fewest independent verifiers among the LIVE routes that have no inbound limit (null = not read) */
  weakestUnboundedVerifiers?: number | null;
  stale?: boolean; staleSince?: number;
};
// Probe results: the scheduler's hourly latest-*.json when present, else the 2026-11-07 run (same file suffixes).
const dated = import.meta.glob("../../../../docs/evidence/inbound/2026-11-07-*.json", { eager: true, import: "default" }) as Record<string, { block: number; rows: ProbeRow[] }>;
const latest = import.meta.glob("../../../../docs/evidence/inbound/latest-*.json", { eager: true, import: "default" }) as Record<string, { block: number; rows: ProbeRow[] }>;
const suffix = (p: string) => p.replace(/^.*\/(2026-11-07|latest)-/, "");
const probeFiles = new Map<string, { block: number; rows: ProbeRow[]; latest: boolean }>();
for (const [p, d] of Object.entries(dated)) probeFiles.set(suffix(p), { ...d, latest: false });
for (const [p, d] of Object.entries(latest)) if (d?.rows?.length) probeFiles.set(suffix(p), { ...d, latest: true });
type Probe = ProbeRow & { outcome: string; block: number };
const PROBE = new Map<string, Probe>();
for (const d of probeFiles.values()) for (const r of d.rows) PROBE.set(r.oapp.toLowerCase(), { ...r, outcome: r.error ? "ERROR" : r.outcome ?? "ERROR", block: d.block });
const PROBE_SOURCE = [...probeFiles.values()].some((d) => d.latest) ? "hourly probe" : "inbound probe, 2026-11-07";
/** OFT address (lowercase) -> probe rows of the adapters that list it as a peer: the adapters that really back it. */
const BACKERS = new Map<string, Probe[]>();
for (const p of PROBE.values()) for (const peer of Object.values(p.peers ?? {})) BACKERS.set(peer, [...(BACKERS.get(peer) ?? []), p]);

// Config watch (every 15 min): last block checked per chain, and config changes on tracked bridges.
type WatchState = { updatedAt?: string; chains: Record<string, { block: number; checkedAt: string; error?: string }> };
type WatchEvent = {
  chainId: number; chain: string; block: number; tx: string; event: string; symbol: string; kind: string; eid?: number;
  effective?: { status: "LIVE" | "CLOSED" | "UNKNOWN"; verifiers: number | null; inUse?: boolean; note?: string };
  singleVerifier?: boolean;
  /** legacy rows written before effective resolution: raw event value, not a score */
  requiredDVNs?: number;
};
const watchFiles = import.meta.glob("../../../../docs/evidence/watch/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const WATCH = (Object.entries(watchFiles).find(([p]) => p.endsWith("state.json"))?.[1] ?? { chains: {} }) as WatchState;
const EVENTS = (Object.entries(watchFiles).find(([p]) => p.endsWith("events.json"))?.[1] ?? []) as WatchEvent[];

/**
 * Adapters with no route that can receive today: no peers, LayerZero v1 (outside the v2 probe), or every peer route
 * closed (blocked library / dead verifier). A FAILED probe is not "inactive": it is unknown, and shown as such.
 */
const INACTIVE = new Set(["NO_PEERS", "LZ_V1", "NO_LIVE_ROUTES"]);
const activeAdapter = (oapp?: string) => { const p = oapp ? PROBE.get(oapp.toLowerCase()) : undefined; return p && !INACTIVE.has(p.outcome) ? p : undefined; };
/** Home-chain adapters per LayerZero token symbol: only a fallback when the probe recorded no peers (old runs). */
const HOME = new Map<string, string[]>();
for (const tokens of Object.values(aaveMarkets.bridged as Record<string, Record<string, { kind: string; oapp: string; symbol: string }>>))
  for (const t of Object.values(tokens)) if (t.kind === "layerzero-adapter") HOME.set(t.symbol, [...(HOME.get(t.symbol) ?? []), t.oapp]);

/**
 * Severity of one probed adapter, in the order a lender should care:
 *   kelp       no inbound limit AND a route one operator can verify (the Kelp pattern)
 *   uncapped   no inbound limit, every such route needs >= 2 independent verifiers (a weakness, not an exploit path)
 *   unread     no inbound limit, verifier set not read (runs before 2026-11-28): not scored either way
 *   capped / unknown / failed / inactive
 */
type Severity = "kelp" | "uncapped" | "unread" | "capped" | "unknown" | "failed" | "inactive";
function severity(p?: Probe): Severity {
  if (!p) return "unknown";
  if (INACTIVE.has(p.outcome)) return "inactive";
  if (p.outcome === "ERROR") return "failed";
  if (p.outcome === "INBOUND_LIMIT") return "capped";
  if (p.outcome !== "NO_INBOUND_LIMIT") return "unknown";
  if (p.weakestUnboundedVerifiers == null) return "unread";
  return p.weakestUnboundedVerifiers <= 1 ? "kelp" : "uncapped";
}
const RANK: Severity[] = ["inactive", "capped", "unknown", "failed", "unread", "uncapped", "kelp"];
const worstOf = (ps: Probe[]) => ps.reduce<Probe | undefined>((w, p) => (!w || RANK.indexOf(severity(p)) > RANK.indexOf(severity(w)) ? p : w), undefined);

/** The adapters backing an OFT minted on this chain: by peer address when recorded, else by symbol (labelled). */
function backing(r: Reserve): { probe?: Probe; bySymbol: boolean } {
  const byPeer = r.bridge.oapp ? BACKERS.get(r.bridge.oapp.toLowerCase()) ?? [] : [];
  if (byPeer.length) return { probe: worstOf(byPeer.filter((p) => !INACTIVE.has(p.outcome))) ?? byPeer[0], bySymbol: false };
  const bySym = (r.bridge.lzSymbol ? HOME.get(r.bridge.lzSymbol) ?? [] : []).map((o) => PROBE.get(o.toLowerCase())).filter(Boolean) as Probe[];
  return { probe: worstOf(bySym.filter((p) => !INACTIVE.has(p.outcome))), bySymbol: true };
}
type Exposure = "minted" | "home-escrow" | "none";
function exposure(r: Reserve): Exposure {
  if (r.bridge.kind === "layerzero-oft") return "minted";
  if (r.bridge.kind === "layerzero-adapter") {
    const p = PROBE.get(r.bridge.oapp?.toLowerCase() ?? "");
    if (p && !INACTIVE.has(p.outcome)) return "home-escrow";
  }
  return "none";
}

const REFRESH_MS = 60_000;
const usd = (n: number | null | undefined) => (n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`);
const tokens = (n: number | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 0 }));
const ago = (t: number, now: number) => `${Math.max(0, Math.round((now - t) / 1000))} s ago`;

type Row = Reserve & { market: string; chainId: number };

/** One probed adapter, in words a reader can act on (raw codes live in docs/evidence/inbound). */
function probeText(p?: Probe) {
  const sev = severity(p);
  const mints = p?.results?.some((x) => /credits by minting/.test(x.proof));
  const stale = p?.stale ? <span className="muted"> (result from block {p.block.toLocaleString("en-US")}; latest run failed)</span> : null;
  const v = p?.weakestUnboundedVerifiers;
  const what = mints ? "mints on an inbound message with no cap" : "no inbound limit: one message can release the whole escrow";
  switch (sev) {
    case "kelp": return <><b className="bad">{what}, and one verifier can approve it (the Kelp pattern)</b>{stale}</>;
    case "uncapped": return <><span className="caution">{what}; needs {v} independent verifiers to approve</span>{stale}</>;
    case "unread": return <><span className="caution">{what}; verifier set not read in this run</span>{stale}</>;
    case "capped": return <><span className="ok">inbound rate limit present</span>{stale}</>;
    case "failed": return <span className="muted">probe failed in the latest run: not checked</span>;
    case "inactive": return <span className="muted">no route can receive today</span>;
    default: return p ? <span className="muted">probe inconclusive ({p.outcome.toLowerCase().replace(/_/g, " ")})</span> : <span className="muted">not probed</span>;
  }
}

/**
 * Aave retires collateral by setting the liquidation threshold to 0.1% (10 bps) with LTV at or near 0: loans already
 * open stay backed, new borrowing against it stops. Those reserves still carry exposure, so they stay in the table,
 * but they are labelled and counted apart rather than shown as "0%".
 */
const WIND_DOWN_LT_BPS = 10;
const windingDown = (r: Reserve) => !r.collateralViaEModeOnly && r.liquidationThresholdBps > 0 && r.liquidationThresholdBps <= WIND_DOWN_LT_BPS;
const ltText = (r: Reserve) =>
  r.collateralViaEModeOnly ? "E-mode only"
  : windingDown(r) ? <span className="muted">0.1% · wind-down</span>
  : `${(r.liquidationThresholdBps / 100).toFixed(0)}%`;

function bridgeCell(r: Row) {
  const e = exposure(r);
  if (e === "minted") {
    const b = backing(r);
    return <span>Minted here by LayerZero messages. Backing adapter: {probeText(b.probe)}{b.probe && b.bySymbol ? <span className="muted"> (matched by symbol, not by peer)</span> : null}</span>;
  }
  if (e === "home-escrow") return <span>Home chain; its adapter backs other chains: {probeText(activeAdapter(r.bridge.oapp))}</span>;
  if (r.bridge.kind === "layerzero-adapter") {
    const p = PROBE.get(r.bridge.oapp?.toLowerCase() ?? "");
    return <span className="muted">{p?.outcome === "NO_LIVE_ROUTES" ? "LayerZero adapter, every route closed" : p ? "LayerZero adapter with no peers" : "LayerZero adapter, not probed"}</span>;
  }
  return <span className="muted">no LayerZero bridge found</span>;
}

/** What the route looks like after a config change, read onchain (never the raw event value). */
function watchCell(e: WatchEvent) {
  const f = e.effective;
  if (e.event === "DelegateSet") return <span className="muted">who can change the config</span>;
  if (!f) return <span className="muted">not resolved{e.requiredDVNs != null ? ` (raw event value ${e.requiredDVNs}; 0 means "use default")` : ""}</span>;
  if (f.status === "CLOSED") return <span className="ok">route closed ({f.note?.startsWith("blocked") ? "blocked library" : "verifier can never sign"})</span>;
  if (f.status === "UNKNOWN") return <span className="muted">could not read</span>;
  if (f.inUse === false) return <span className="muted">config on a library this token does not use</span>;
  if (e.singleVerifier) return <b className="bad">1 verifier can approve messages</b>;
  return <span>{f.verifiers} independent verifiers</span>;
}

export function LiveMarket() {
  const [states, setStates] = useState<Record<string, MarketState>>({});
  const [now, setNow] = useState(Date.now());
  const [market, setMarket] = useState("all");
  const [bridgedOnly, setBridgedOnly] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      for (const m of MARKETS) readMarket(m).then((s) => !stop && setStates((prev) => ({ ...prev, [m.id]: s.ok || !prev[m.id]?.ok ? s : prev[m.id]! })));
    };
    tick();
    const t = setInterval(tick, REFRESH_MS);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(t); clearInterval(c); };
  }, []);

  const all = Object.values(states);
  const rows: Row[] = useMemo(
    () => all.flatMap((s) => s.reserves.filter((r) => r.collateral).map((r) => ({ ...r, market: s.name, chainId: s.chainId }))),
    [states],
  );
  const shown = rows
    .filter((r) => (market === "all" || r.market === market) && (!bridgedOnly || exposure(r) !== "none"))
    .sort((a, b) => (b.suppliedUsd ?? 0) - (a.suppliedUsd ?? 0));
  const minted = rows.filter((r) => exposure(r) === "minted");
  const sevOf = (r: Row) => severity(exposure(r) === "minted" ? backing(r).probe : exposure(r) === "home-escrow" ? activeAdapter(r.bridge.oapp) : undefined);
  const exposed = rows.filter((r) => exposure(r) !== "none");
  const kelp = exposed.filter((r) => sevOf(r) === "kelp");
  const uncapped = exposed.filter((r) => ["uncapped", "unread"].includes(sevOf(r)));
  const notChecked = exposed.filter((r) => ["failed", "unknown"].includes(sevOf(r)));
  const live = all.filter((s) => s.ok).length;
  const oldest = all.filter((s) => s.ok).reduce((m, s) => Math.min(m, s.readAt), Infinity);
  const stale = oldest !== Infinity && now - oldest > 3 * REFRESH_MS;

  return (
    <>
      <h1>Live market</h1>
      <p className="lede">
        Every Aave V3 market, read straight from its chain by this page every minute: which assets are accepted as collateral, how much is supplied, and
        which of them are bridged by LayerZero. <span className={stale ? "warn" : "muted"}>Markets live: {live}/{MARKETS.length}{oldest !== Infinity ? ` · oldest read ${ago(oldest, now)}` : " · reading…"}</span>
      </p>
      <div className="stats">
        <Stat value={String(rows.length)} label="collateral assets" source={`${live} markets · ${rows.filter(windingDown).length} being wound down`} />
        <Stat value={usd(rows.reduce((s, r) => s + (r.suppliedUsd ?? 0), 0))} label="supplied as collateral" source="Aave oracle prices" />
        <Stat value={`${minted.length} · ${usd(minted.reduce((s, r) => s + (r.suppliedUsd ?? 0), 0))}`} label="collateral minted by LayerZero messages on its chain" source="LayerZero OFT registry" />
        <Stat value={`${kelp.length} · ${usd(kelp.reduce((s, r) => s + (r.suppliedUsd ?? 0), 0))}`} label="LayerZero collateral with the Kelp pattern: no inbound limit AND one verifier can approve a message" source={PROBE_SOURCE} />
        <Stat value={String(uncapped.length)} label="no inbound limit, but every such route needs 2+ independent verifiers (weakness, not an exploit path)" source={PROBE_SOURCE} />
        {notChecked.length ? <Stat value={String(notChecked.length)} label="LayerZero collateral the latest probe could not check (unknown, not safe)" source={PROBE_SOURCE} /> : null}
      </div>
      <Card
        title={`Collateral (${shown.length})`}
        right={
          <div className="row">
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value="all">All markets</option>
              {MARKETS.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
            </select>
            <label><input type="checkbox" checked={bridgedOnly} onChange={(e) => setBridgedOnly(e.target.checked)} /> LayerZero exposure only</label>
          </div>
        }
      >
        <div className="tablebox">
          <table>
            <thead><tr><th>Market</th><th>Asset</th><th>Supplied</th><th>Bridge</th><th>Adapter escrow (live)</th><th>Liq. threshold</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.market}-${r.asset}`}>
                  <td>{r.market}</td>
                  <td><b>{r.symbol}</b></td>
                  <td className="num">{usd(r.suppliedUsd)}</td>
                  <td>{bridgeCell(r)}</td>
                  <td className="num">{r.bridge.escrow != null ? `${tokens(r.bridge.escrow)} ${r.symbol}` : "—"}</td>
                  <td className="num">{ltText(r)}</td>
                  <td>{r.frozen ? <span className="warn">frozen</span> : r.active ? "active" : "inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Config watch (every 15 minutes)">
        <p className="muted">
          LayerZero config changes (verifier set, receive library, delegate) on every chain with an Aave V3 market, for every LayerZero deployment of an
          Aave-listed token. {WATCH.updatedAt ? <>Last run: {ago(Date.parse(WATCH.updatedAt), now)}; chains checked: {Object.values(WATCH.chains).filter((c) => !c.error).length}/{Object.keys(WATCH.chains).length}.</> : "Not run yet."}
        </p>
        {EVENTS.length === 0 ? (
          <p>No config changes on tracked bridges since the watch started. (Replaying Kelp's April 2025 block, the watch flags the rsETH change: one required verifier.)</p>
        ) : (
          <div className="tablebox">
            <table>
              <thead><tr><th>Chain</th><th>Block</th><th>Token</th><th>Change</th><th>Route</th><th>Route after the change (effective)</th></tr></thead>
              <tbody>{EVENTS.slice(0, 20).map((e) => <tr key={`${e.chainId}-${e.tx}-${e.block}-${e.event}`}><td>{e.chain}</td><td className="num">{e.block.toLocaleString("en-US")}</td><td><b>{e.symbol}</b></td><td>{e.event}</td><td className="num">{e.eid ?? "—"}</td><td>{watchCell(e)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Markets">
        <div className="tablebox">
          <table>
            <thead><tr><th>Market</th><th>Chain</th><th>Block</th><th>Read</th><th>Collateral assets</th></tr></thead>
            <tbody>
              {MARKETS.map((m) => {
                const s = states[m.id];
                return (
                  <tr key={m.id}>
                    <td>{m.name}</td><td className="num">{m.chainId}</td>
                    <td className="num">{s?.block?.toLocaleString("en-US") ?? "—"}</td>
                    <td>{!s ? "reading…" : s.ok ? ago(s.readAt, now) : <span className="bad">failed: {s.error}</span>}</td>
                    <td className="num">{s?.reserves.filter((r) => r.collateral).length ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="muted">
        Sources: Aave V3 address book (markets), each market's Pool, AaveProtocolDataProvider and AaveOracle (live), LayerZero's OFT registry (bridging), Floor's inbound probe of
        LayerZero adapters (docs/evidence/inbound; also on Arkiv as floor.adapter). Grades for LayerZero OFT routes come from the scheduled scan.
      </p>
    </>
  );
}
