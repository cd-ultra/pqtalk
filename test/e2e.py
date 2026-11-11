"""Headless 3-peer end-to-end test (Chrome + fake mic, BroadcastChannel relay).

Usage:  npx vite preview --port 4173 &   python3 test/e2e.py [http://localhost:4173]
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173") + "/?transport=local"
CODE = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789"

def snapshot(p):
    return p.evaluate("""async () => {
      const r = window.__room; if (!r) return null;
      const peers = [];
      for (const x of r.peers.values()) {
        let energy = 0, rxPkts = 0, txPkts = 0, codec = '', fmtp = '';
        if (x.pc) { const st = await x.pc.getStats(); st.forEach(s => {
          if (s.type==='inbound-rtp' && s.kind==='audio') { energy = s.totalAudioEnergy||0; rxPkts = s.packetsReceived||0; }
          if (s.type==='outbound-rtp' && s.kind==='audio') txPkts = s.packetsSent||0;
          if (s.type==='codec' && /opus/i.test(s.mimeType)) { codec = s.mimeType; fmtp = s.sdpFmtpLine; }
        }); }
        peers.push({ nick: x.nick, status: x.status, talking: x.talking, dc: x.dc?.readyState, epoch: x.session?.epoch,
          energy, rxPkts, txPkts, codec, fmtp, txPps: x.stats?.txPps, txKbps: x.stats?.txKbps, route: x.stats?.route,
          audioLevelExt: /ssrc-audio-level/.test(x.pc?.localDescription?.sdp||''), ptime: (x.pc?.remoteDescription?.sdp||'').match(/a=ptime:(\\d+)/)?.[1] });
      }
      return { nick: r.nick, mode: r.mode, sk: r.sk?.epoch, frames: r.frameStats, talking: r.talking, peers };
    }""")

def wait(cond, timeout=30, step=0.5):
    t = time.time()
    while time.time() - t < timeout:
        v = cond()
        if v: return v
        time.sleep(step)
    raise AssertionError("timeout")

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(permissions=["microphone"])
    if os.environ.get("LEGACY"):  # force Chrome's older createEncodedStreams path
        ctx.add_init_script("delete window.RTCRtpScriptTransform")
    pages = []
    for name in ["Alice", "Bob", "Carol"]:
        pg = ctx.new_page()
        pg.on("pageerror", lambda e, n=name: print(f"[{n}] PAGEERROR {e}"))
        pg.on("console", lambda m, n=name: m.type == "error" and print(f"[{n}] console.error {m.text}"))
        pg.goto(URL)
        pg.fill("#nick", name); pg.fill("#code", CODE); pg.click("#btnJoin")
        pages.append(pg)

    def all_connected():
        s = [snapshot(p) for p in pages]
        return s if all(x and len(x["peers"]) == 2 and all(q["status"] == "connected" and q["dc"] == "open" for q in x["peers"]) for x in s) else None
    s = wait(all_connected, 40)
    print("mesh up; e2ee mode:", s[0]["mode"], "| sender-key epochs:", [x["sk"] for x in s])

    A, B, C = pages
    A.focus("body"); A.keyboard.down("Space")
    time.sleep(6)
    sA, sB, sC = snapshot(A), snapshot(B), snapshot(C)
    print("A tx:", json.dumps([{k: q[k] for k in ("nick", "txPps", "txKbps", "route", "ptime", "audioLevelExt")} for q in sA["peers"]]))
    print("codec/fmtp seen by B:", sB["peers"][0]["codec"], sB["peers"][0]["fmtp"])
    talkingSeen = [next(q for q in x["peers"] if q["nick"] == "Alice")["talking"] for x in (sB, sC)]
    rx = [next(q for q in x["peers"] if q["nick"] == "Alice") for x in (sB, sC)]
    print("B/C see Alice talking:", talkingSeen, "| rx energy:", [round(q["energy"], 4) for q in rx], "| rx pkts:", [q["rxPkts"] for q in rx])
    print("frame stats A/B/C:", sA["frames"], sB["frames"], sC["frames"])
    A.keyboard.up("Space")
    time.sleep(1.5)
    assert all(talkingSeen), "PTT state not propagated"
    assert all(q["energy"] > 0.001 for q in rx), "decoded audio energy ~0 => decryption/decoding failed"
    assert sB["frames"]["dec"] > 50 and sB["frames"]["drop"] < 5, "frames not decrypting"
    assert all(not q["audioLevelExt"] for q in sA["peers"]), "audio-level header ext not stripped"

    # idle => no packets
    p0 = snapshot(A)["peers"][0]["txPkts"]; time.sleep(3); p1 = snapshot(A)["peers"][0]["txPkts"]
    print("idle tx packets in 3 s:", p1 - p0)

    # leave => remaining members rotate sender keys
    ep_before = [snapshot(p)["sk"] for p in (A, B)]
    C.click("#btnLeave")
    wait(lambda: all(len(snapshot(p)["peers"]) == 1 for p in (A, B)), 15)
    time.sleep(2)
    ep_after = [snapshot(p)["sk"] for p in (A, B)]
    print("sender-key epochs before/after Carol left:", ep_before, ep_after)
    assert all(a != b for a, b in zip(ep_before, ep_after)), "sender key not rotated on leave"

    # audio still works A->B after rotation
    e0 = next(q for q in snapshot(B)["peers"])["energy"]
    A.keyboard.down("Space"); time.sleep(3); A.keyboard.up("Space"); time.sleep(0.5)
    e1 = next(q for q in snapshot(B)["peers"])["energy"]
    print("B energy after rotation talk:", round(e1 - e0, 4))
    assert e1 - e0 > 0.0005
    print("ALL E2E CHECKS PASSED")
    b.close()
