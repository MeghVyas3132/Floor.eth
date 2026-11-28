#!/usr/bin/env python3
"""
Keeps a failed or partial probe run from replacing good results.

A run on shared CI RPCs can come back with rows missing or with rows that are only an error ("RPC Request failed"),
and neither is a finding. Before 2026-11-28 this guard only compared row counts, so a run where every row errored
passed, and the Live market read those error rows as "inactive adapter". It now works per adapter:

  * a new row with an `error` (or no `outcome`) keeps the previous row for that adapter, marked
    `stale: true` with `staleSince` = the block of the run that failed, so the page can say the result is old;
  * a row missing from the new run is restored from the previous run, also marked stale;
  * if every row of a file failed, the whole file is restored and reported.

Exit code is 0 so the scheduler still commits what is good; the summary is printed for the job log.
"""
import glob, json, subprocess, sys

def previous(path):
    try:
        out = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True, check=True).stdout
        return json.loads(out)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None

def failed(row):
    return "error" in row or not row.get("outcome")

notes = []
for f in sorted(glob.glob("docs/evidence/inbound/latest-*.json")):
    old = previous(f)
    if old is None:
        continue  # new file: nothing to compare with
    new = json.load(open(f))
    old_rows = {r["oapp"].lower(): r for r in old.get("rows", [])}
    new_rows = new.get("rows", [])
    if new_rows and all(failed(r) for r in new_rows):
        subprocess.run(["git", "restore", f], check=True)
        notes.append(f"{f}: every row failed in this run, kept the previous file")
        continue
    kept = 0
    merged, seen = [], set()
    for r in new_rows:
        key = r["oapp"].lower()
        seen.add(key)
        prev = old_rows.get(key)
        if failed(r) and prev and not failed(prev):
            merged.append({**prev, "stale": True, "staleSince": new.get("block"), "lastError": r.get("error")})
            kept += 1
        else:
            merged.append(r)
    for key, prev in old_rows.items():
        if key not in seen and not failed(prev):
            merged.append({**prev, "stale": True, "staleSince": new.get("block"), "lastError": "missing from this run"})
            kept += 1
    if kept:
        new["rows"] = merged
        tally = {}
        for r in merged:
            o = r.get("outcome") or "ERROR"
            tally[o] = tally.get(o, 0) + 1
        new["tally"] = tally
        with open(f, "w") as fh:
            json.dump(new, fh, indent=1)
        notes.append(f"{f}: {kept} row(s) failed or missing, kept the previous result marked stale")

for n in notes:
    print("guard:", n)
print(f"guard: {len(notes)} file(s) adjusted")
sys.exit(0)
