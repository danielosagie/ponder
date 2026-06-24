#!/usr/bin/env python3
"""Probe the H Company AgP handshake: how does a trajectory go pending -> emitting commands?"""
import json, os, sys, time, urllib.request, urllib.error

BASE = "https://agp.hcompany.ai/api/v1"
KEY = None
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env")):
    if line.startswith("HAI_API_KEY="):
        KEY = line.strip().split("=", 1)[1]
HDR = {"Authorization": f"Bearer {KEY}", "X-From-htab": "true",
       "Content-Type": "application/json", "Accept": "application/json"}

def req(method, path, body=None, timeout=30):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return -1, str(e)

def show(label, code, body):
    print(f"\n── {label} → HTTP {code}")
    if isinstance(body, (dict, list)):
        print(json.dumps(body, indent=2)[:1500])
    elif body:
        print(str(body)[:600])

# 1) create on the real production agent
code, traj = req("POST", "/agents/sagent-no-config-1dba92bd/trajectories", {
    "task": {"type": "interactive", "start_url": "https://example.com",
             "idle_timeout_s": 180, "instructions": "Read the main heading on this page and report it."},
    "launch": True, "store_calltrace": True, "metadata": {"source": "extension"},
})
show("create surferh trajectory", code, traj)
if not isinstance(traj, dict) or "id" not in traj:
    sys.exit(1)
tid = traj["id"]
print(f"\nTRAJ = {tid}  status={traj.get('status')}")

# 2) changes stream (brain events / observations / lifecycle)
code, ch = req("GET", f"/trajectories/{tid}/changes?from_index=0&wait_for_seconds=8", timeout=20)
show("changes (brain events)", code, ch)

# 3) commands (what the driver should execute)
code, cmds = req("GET", f"/commands/{tid}/commands?wait_for_seconds=8", timeout=20)
show("commands (driver work)", code, cmds)

# 4) if no commands, try kicking with a resume flow-control, then re-poll
if code == 204 or not cmds:
    code, fc = req("POST", f"/trajectories/{tid}/interaction",
                   {"type": "flow_control", "flow": "resume", "origin": "user_resume"})
    show("interaction resume", code, fc)
    time.sleep(1)
    code, cmds2 = req("GET", f"/commands/{tid}/commands?wait_for_seconds=12", timeout=22)
    show("commands after resume", code, cmds2)

# 5) final status
code, st = req("GET", f"/trajectories/{tid}", timeout=15)
if isinstance(st, dict):
    print(f"\nfinal status={st.get('status')} steps={st.get('metrics',{}).get('steps')} events={len(st.get('events',[]))}")
