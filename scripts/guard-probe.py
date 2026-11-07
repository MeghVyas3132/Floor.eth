#!/usr/bin/env python3
"""
Keeps a partial probe run from replacing good results. A run on shared CI RPCs can come back with adapters missing
(rate limits), and a missing row is not a finding. For each docs/evidence/inbound/latest-<chain>.json, if the new
file has fewer rows than the version in git, the new file is discarded (git restore) and the run is reported.
"""
import glob, json, subprocess, sys

dropped = []
for f in sorted(glob.glob("docs/evidence/inbound/latest-*.json")):
    try:
        old = json.loads(subprocess.run(["git", "show", f"HEAD:{f}"], capture_output=True, text=True, check=True).stdout)
    except subprocess.CalledProcessError:
        continue  # new file: nothing to compare with
    new = json.load(open(f))
    if len(new.get("rows", [])) < len(old.get("rows", [])):
        subprocess.run(["git", "restore", f], check=True)
        dropped.append(f"{f}: {len(new.get('rows', []))} rows < {len(old.get('rows', []))}, kept the previous result")
for d in dropped:
    print("guard:", d)
print(f"guard: {len(dropped)} partial result(s) discarded")
sys.exit(0)
