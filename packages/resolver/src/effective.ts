/**
 * Effective receive-side state of ONE LayerZero route (docs/07 rules 1, 2, 3 and 5), shared by the config watch and
 * the inbound probe so neither scores raw config.
 *
 *   EndpointV2.getReceiveLibrary(oapp, eid)  -> the library actually in use (and whether it is the default)
 *   BlockedMessageLib                        -> route CLOSED: nothing can be received (LayerZero's kill switch)
 *   <lib>.getUlnConfig(oapp, eid)            -> app config merged with the default (0 = inherit, 255 = NIL)
 *   @floor/core independence()               -> distinct operators an attacker must compromise; dead DVN = disabled
 *
 * Any failed read returns status UNKNOWN (never OK, never a finding).
 */
import { independence, type OperatorMap, type UlnConfig } from "@floor/core";
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { endpointAbi, ulnAbi } from "./abis.js";
import { operatorMap } from "./operators.js";

/**
 * LayerZero's BlockedMessageLib reports version (type(uint64).max, type(uint8).max, 2) and reverts every other call
 * with LZ_NotImplemented (LayerZero-v2 `BlockedMessageLib.sol`). Checked onchain on Metis, 2026-11-28:
 * 0x1ccBf0db9C192d969de57E25B3fF09A25bb1D862 returns exactly that tuple.
 */
const BLOCKED_VERSION = { major: (1n << 64n) - 1n, minor: 255, endpointVersion: 2 } as const;
const libAbi = parseAbi(["function version() view returns (uint64 major, uint8 minor, uint8 endpointVersion)"]);

export type RouteStatus = "LIVE" | "CLOSED" | "UNKNOWN";
export interface EffectiveRoute {
  eid: number;
  status: RouteStatus;
  /** why: "blocked message library", "dead DVN or unreachable threshold", "read failed: ..." */
  note?: string;
  library?: Address;
  libraryIsDefault?: boolean;
  /** distinct operators that must sign (null when not LIVE) */
  verifiers: number | null;
  operators?: string[];
  /** DVN addresses with no operator mapping on this chain (each counted as its own operator) */
  unmapped?: string[];
  confirmations?: string;
}

const mapCache = new Map<string, OperatorMap>();
/** Operator map for a chain key; chains without LayerZero DVN metadata get an empty map (every DVN = own operator). */
export function operatorsFor(chain: string): { map: OperatorMap; mapped: boolean } {
  if (!mapCache.has(chain)) {
    try {
      mapCache.set(chain, operatorMap(chain));
    } catch {
      mapCache.set(chain, {});
    }
  }
  const map = mapCache.get(chain)!;
  return { map, mapped: Object.keys(map).length > 0 };
}

export async function isBlockedLibrary(client: PublicClient, lib: Address, blockNumber?: bigint): Promise<boolean> {
  try {
    const [major, minor, ev] = (await client.readContract({ address: lib, abi: libAbi, functionName: "version", blockNumber } as never)) as readonly [bigint, number, number];
    return major === BLOCKED_VERSION.major && Number(minor) === BLOCKED_VERSION.minor && Number(ev) === BLOCKED_VERSION.endpointVersion;
  } catch {
    return false;
  }
}

type UlnTuple = { confirmations: bigint; requiredDVNCount: number; optionalDVNCount: number; optionalDVNThreshold: number; requiredDVNs: readonly Address[]; optionalDVNs: readonly Address[] };

export async function effectiveReceiveRoute(
  client: PublicClient,
  endpoint: Address,
  oapp: Address,
  eid: number,
  chain: string,
  blockNumber?: bigint,
): Promise<EffectiveRoute> {
  let lib: Address, isDefault: boolean;
  try {
    [lib, isDefault] = (await client.readContract({ address: endpoint, abi: endpointAbi, functionName: "getReceiveLibrary", args: [oapp, eid], blockNumber } as never)) as readonly [Address, boolean];
  } catch (e) {
    return { eid, status: "UNKNOWN", verifiers: null, note: `getReceiveLibrary failed: ${(e as Error).message.split("\n")[0]!.slice(0, 80)}` };
  }
  lib = getAddress(lib);
  if (await isBlockedLibrary(client, lib, blockNumber))
    return { eid, status: "CLOSED", verifiers: null, library: lib, libraryIsDefault: isDefault, note: "blocked message library: the route cannot receive anything" };
  let t: UlnTuple;
  try {
    t = (await client.readContract({ address: lib, abi: ulnAbi, functionName: "getUlnConfig", args: [oapp, eid], blockNumber } as never)) as UlnTuple;
  } catch (e) {
    return { eid, status: "UNKNOWN", verifiers: null, library: lib, libraryIsDefault: isDefault, note: `getUlnConfig failed on ${lib}: ${(e as Error).message.split("\n")[0]!.slice(0, 80)}` };
  }
  const cfg: UlnConfig = {
    confirmations: t.confirmations.toString(),
    requiredDVNCount: Number(t.requiredDVNCount),
    optionalDVNCount: Number(t.optionalDVNCount),
    optionalThreshold: Number(t.optionalDVNThreshold),
    requiredDVNs: t.requiredDVNs.map((a) => getAddress(a)),
    optionalDVNs: t.optionalDVNs.map((a) => getAddress(a)),
  };
  const { map } = operatorsFor(chain);
  const ind = independence(cfg, map);
  if (ind.blocked)
    return { eid, status: "CLOSED", verifiers: null, library: lib, libraryIsDefault: isDefault, confirmations: cfg.confirmations, note: "dead DVN or unreachable threshold: the route cannot verify messages" };
  return { eid, status: "LIVE", verifiers: ind.count, operators: ind.operators, unmapped: ind.unmapped, library: lib, libraryIsDefault: isDefault, confirmations: cfg.confirmations };
}
