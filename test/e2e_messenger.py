"""End-to-end messenger test: 3 separate browser profiles (separate keys) through a local server.

  cd server && npx wrangler dev --port 8787 &
  VITE_SERVER_URL=http://127.0.0.1:8787 npx vite build && npx vite preview --port 4173 &
  python3 test/e2e_messenger.py
"""
import base64, os, struct, sys, time, zlib
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
SHOTS = os.environ.get("SHOTS")
results = []

def ok(cond, label):
    results.append((bool(cond), label)); print(("PASS " if cond else "FAIL ") + label); return cond

def wait(fn, timeout=25, step=0.4, label="condition"):
    t = time.time()
    while time.time() - t < timeout:
        try:
            v = fn()
            if v: return v
        except Exception: pass
        time.sleep(step)
    return None

def png(w=320, h=200):
    raw = b"".join(b"\x00" + b"".join(bytes(((x * 255 // w), (y * 255 // h), 160)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

def ev(p, js):
    return p.evaluate(js)

def open_conv(p, name):
    """Phone layout hides the chat list while a chat is open: tap Back until it shows."""
    for _ in range(4):
        if p.locator("#side").is_visible(): break
        p.evaluate("document.querySelector('#main .back, #main [data-act=back]')?.click()"); time.sleep(0.3)
    p.locator(".conv", has_text=name).first.click()
    p.wait_for_selector("#chatBar")

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    def person(name):
        ctx = b.new_context(permissions=["microphone", "clipboard-read", "clipboard-write"], viewport={"width": 420, "height": 860}, device_scale_factor=2)
        p = ctx.new_page()
        p.on("pageerror", lambda e: print(f"[{name}] PAGEERROR {e}"))
        p.on("console", lambda m: m.type == "error" and "favicon" not in m.text and print(f"[{name}] console.error {m.text}"))
        p.goto(URL)
        p.fill("#obName", name); p.click("#obGo")
        wait(lambda: ev(p, "!!window.__pq.m?.account && window.__pq.m.online === true"), label=f"{name} online")
        return ctx, p
    (ca, A), (cb, B), (cc, C) = person("George"), person("Sam Ortiz"), person("Priya")
    ok(all(ev(x, "window.__pq.m.online") for x in (A, B, C)), "three accounts registered and connected")

    # ---- invite + 1:1 ----
    A.click("#side [data-act=new]"); A.wait_for_selector(".qr svg")
    link = ev(A, "window.__pq.m.myInvite()")
    ok(link.startswith("http") and "#i=" in link and len(link) < 220, f"invite link is short ({len(link)} chars)")
    B.click("#side [data-act=new]"); B.fill("#pasteLink", link); B.click("[data-act=addLink]")
    B.wait_for_selector("#input")
    B.fill("#input", "Hi George, it's Sam"); B.click("#sendBtn")
    got = wait(lambda: A.locator(".conv b", has_text="Sam Ortiz").count() > 0, label="A sees Sam")
    ok(got, "A gets Sam's first message and learns his name (PQXDH prekey message)")
    open_conv(A, "Sam Ortiz"); A.wait_for_selector(".m .txt")
    ok("Hi George" in A.inner_text("#msgs"), "A reads the message")
    ok(wait(lambda: "George" in B.inner_text("#chatBar")), "Sam learns George's name from the hello reply")
    ok(wait(lambda: B.locator(".m.me [data-status=read]").count() > 0), "Sam sees a read receipt")
    A.fill("#input", "Hey Sam! Typing test");
    ok(wait(lambda: B.locator(".typing").count() > 0, timeout=8), "typing indicator shows")
    A.click("#sendBtn")
    ok(wait(lambda: "Typing test" in B.inner_text("#msgs")), "reply arrives (ratchet turn with ML-KEM step)")

    # ---- third person + group of people who aren't each other's contacts ----
    C.click("#side [data-act=new]"); C.fill("#pasteLink", link); C.click("[data-act=addLink]")
    C.wait_for_selector("#input"); C.fill("#input", "Priya here"); C.click("#sendBtn")
    ok(wait(lambda: A.locator(".conv b", has_text="Priya").count() > 0), "A gets Priya")
    A.evaluate("document.querySelector('[data-act=new]').click()"); A.click("#main [data-act=group]")
    A.fill("#newGName", "Weekend trip")
    for el in A.locator(".pick input").all(): el.check()
    A.click("[data-act=groupCreate]"); A.wait_for_selector("#input")
    ok(wait(lambda: B.locator(".conv b", has_text="Weekend trip").count() > 0 and C.locator(".conv b", has_text="Weekend trip").count() > 0), "B and C receive the group")
    A.fill("#input", "Group hello from George"); A.click("#sendBtn")
    open_conv(B, "Weekend trip"); open_conv(C, "Weekend trip")
    ok(wait(lambda: "Group hello" in B.inner_text("#msgs") and "Group hello" in C.inner_text("#msgs")), "group message reaches both")
    B.fill("#input", "Sam to the group"); B.click("#sendBtn")
    ok(wait(lambda: "Sam to the group" in C.inner_text("#msgs") and "Sam to the group" in A.inner_text("#msgs"), timeout=30),
       "Sam reaches Priya with no direct contact (session made through the group secret)")
    ok(wait(lambda: A.locator(".m.me [data-status=read]").count() > 0), "group read receipts aggregate")

    # ---- photo ----
    open("/tmp/test.png", "wb").write(png())
    A.set_input_files("#file", "/tmp/test.png")
    ok(wait(lambda: ev(B, "[...document.querySelectorAll('#msgs img[data-att]')].some(i => i.complete && i.naturalWidth > 100)"), timeout=30),
       "photo is encrypted, uploaded, downloaded and decrypted")

    # ---- voice note (fake mic) ----
    C.click("[data-act=record]"); time.sleep(2.2); C.click("[data-act=recSend]")
    ok(wait(lambda: B.locator(".voice").count() > 0 and A.locator(".voice").count() > 0, timeout=30), "voice note delivered")
    B.locator("[data-act=play]").last.click()
    ok(wait(lambda: ev(B, "(() => { const a = [...document.querySelectorAll('audio')]; return true })()") and B.locator("[data-act=play] path[d^='M7 4h']").count() > 0, timeout=8),
       "voice note plays")
    if SHOTS: B.screenshot(path=f"{SHOTS}/group.png")

    # ---- offline delivery ----
    C.close()
    A.fill("#input", "Sent while Priya was offline"); A.click("#sendBtn"); time.sleep(1.5)
    C = cc.new_page(); C.goto(URL)
    ok(wait(lambda: "offline" in C.inner_text("#side")), "offline message is waiting when Priya comes back")

    # ---- 1:1 voice call ----
    open_conv(A, "Sam Ortiz"); open_conv(B, "George")
    A.click("[data-act=call]")
    ok(wait(lambda: B.locator("[data-act=accept]").count() > 0, timeout=15), "Sam's phone rings")
    if SHOTS: B.screenshot(path=f"{SHOTS}/ringing.png")
    B.click("[data-act=accept]")
    live = wait(lambda: ev(A, "window.__pq.voice.state?.phase === 'live'") and ev(B, "window.__pq.voice.state?.phase === 'live'"), timeout=25)
    ok(live, "call connects")
    time.sleep(4)
    energy = ev(B, """async () => { let e = 0; for (const p of window.__pq.voice.state.room.peers.values()) {
        (await p.pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') e += s.totalAudioEnergy || 0; }); } return e; }""")
    fr = ev(B, "window.__pq.voice.state.room.frameStats")
    ok(energy > 0.001 and fr and fr["dec"] > 50, f"call audio decrypts end to end (energy {energy:.4f}, frames {fr})")
    if SHOTS: A.screenshot(path=f"{SHOTS}/call.png")
    A.click("[data-act=hangup]")
    ok(wait(lambda: ev(B, "window.__pq.voice.state === null"), timeout=10), "hang up ends the call on both sides")

    # ---- walkie-talkie in the group ----
    open_conv(A, "Weekend trip"); open_conv(C, "Weekend trip")
    A.click("[data-act=walkie]")
    ok(wait(lambda: C.locator(".banner", has_text="walkie").count() > 0, timeout=15), "Priya sees the walkie-talkie banner")
    C.click(".banner [data-act=walkie]")
    ok(wait(lambda: ev(A, "[...(window.__pq.voice.state?.room?.peers.values() ?? [])].some(p => p.status === 'connected')"), timeout=25), "walkie-talkie connects")
    A.focus("body"); A.keyboard.down("Space"); time.sleep(3)
    talking = ev(C, "[...window.__pq.voice.state.room.peers.values()].some(p => p.talking)")
    e2 = ev(C, """async () => { let e = 0; for (const p of window.__pq.voice.state.room.peers.values()) {
        (await p.pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') e += s.totalAudioEnergy || 0; }); } return e; }""")
    if SHOTS: A.screenshot(path=f"{SHOTS}/walkie.png")
    A.keyboard.up("Space")
    ok(talking and e2 > 0.0005, f"push-to-talk audio reaches Priya (energy {e2:.4f})")
    if SHOTS:
        A.click("[data-act=walkieLeave]"); C.click("[data-act=walkieLeave]")
        open_conv(A, "Sam Ortiz"); time.sleep(0.5); A.screenshot(path=f"{SHOTS}/chat.png")
        A.click("[data-act=info]"); time.sleep(0.4); A.screenshot(path=f"{SHOTS}/safety.png")
        A.evaluate("document.querySelector('#main [data-act=back]').click()"); time.sleep(0.4); A.evaluate("document.querySelector('#main .back').click()"); A.click("#side [data-act=new]"); A.wait_for_selector(".qr svg"); A.screenshot(path=f"{SHOTS}/invite.png")
        A.set_viewport_size({"width": 1280, "height": 800}); A.locator(".conv", has_text="Weekend trip").first.click(); time.sleep(0.6); A.screenshot(path=f"{SHOTS}/desktop.png")
    b.close()

failed = [l for c, l in results if not c]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
