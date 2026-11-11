# PQTalk: serverless, post-quantum E2EE push-to-talk

This is a browser walkie-talkie for group channels. It runs on Windows, macOS, iOS, Android and Linux, and you join with a code you share over Signal or iMessage. Audio goes **directly between devices** over WebRTC (Opus). Every audio frame is encrypted with keys that only channel members hold, and those keys come from a **hybrid post-quantum** handshake modeled on Signal's PQXDH, Sender Keys and ratchets.

```
npm install
npm run dev          # https needed for mic on phones: use `vite --host` + a tunnel, or deploy
npm run build        # static files in dist/ → GitHub Pages / Cloudflare Pages / Netlify (free)
npm test             # crypto unit tests (node)
npx vite preview --port 4173 & python3 test/e2e.py          # 3-browser headless test
LEGACY=1 python3 test/e2e.py                                 # same, older Chrome API path
```
Local multi-tab testing without the public relays: open `/?transport=local` in several tabs.

## Architecture

```
            room code (160-bit, shared out of band via Signal)
                 │ HKDF
     ┌───────────┼──────────────────┐
  roomId      signalKey            PSK
 (relay topic) (AES-GCM envelope)  (mixed into every handshake)

 Public MQTT brokers (3, fan-out) ── only see AES-GCM blobs on topic pqtalk/v1/<roomId>
        │  HELLO (Ed25519-signed: X25519 eph + ML-KEM-768 ek)
        │  KEM   (signed ML-KEM ciphertext, both directions)
        │  SDP/ICE, encrypted again under the pairwise session
        ▼
  WebRTC mesh (P2P, STUN; TURN optional) ── DTLS-SRTP (outer layer)
        └─ Encoded-frame transform in a Worker ── SFrame-style sender-key E2EE (inner layer)
```

### Crypto, mapped to Signal

| Signal | PQTalk | File |
|---|---|---|
| PQXDH (X25519 + ML-KEM) | Interactive hybrid handshake: `HKDF(X25519 ‖ ML-KEM-768(A→B) ‖ ML-KEM-768(B→A), salt=H(PSK ‖ transcript))`. Both sides encapsulate, signed by Ed25519 identity keys and bound to the room. | `src/crypto/handshake.js` |
| Symmetric-key ratchet | Per-direction HMAC chains; one key per message, deleted after use; out-of-order delivery and replay protection | `src/crypto/session.js` |
| DH / SPQR ratchet steps (PCS) | Fresh X25519 + ML-KEM-768 exchange every 5 min, mixed into a root chain | `src/crypto/session.js` |
| Sender Keys (groups) | Each member's chain key is sent to every other member over the pairwise PQ sessions. Rotated on every join or leave and every 10 min. | `src/room.js` |
| SFrame / call media E2EE | AES-128-CTR + HMAC-SHA256-80 (RFC 9605 audio suite). The hash ratchet steps every 256 frames and old keys are wiped. 15 B overhead per frame. | `src/crypto/sframe.js`, `src/e2ee-worker.js` |
| Safety numbers | Signal's algorithm (5200× SHA-512, 60 digits) | `src/crypto/identity.js` |

Where it differs from Signal, on purpose:
- **No prekey server.** Both peers are online, so the handshake is interactive. The room PSK, a symmetric secret, authenticates membership in a quantum-safe way. Identity signatures are Ed25519, the same as Signal, which doesn't use PQ signatures either. The quantum threat that matters today is *harvest-now-decrypt-later*, and the ML-KEM hybrid covers that.
- **Anyone with the code is a member.** Treat the code like a password, and compare safety numbers to detect impostors.

### Leak hardening
- The RFC 6464 `ssrc-audio-level` RTP header extension is stripped. It travels in the clear and would reveal who is talking and how loud.
- Opus runs in **CBR**. VBR packet sizes can leak words even through encryption.
- With push-to-talk, **nothing is sent while idle**. The app replaces the track with null rather than muting it.
- The app refuses to run in browsers without encoded-frame transforms, so it never falls back to DTLS-only encryption.

## Data usage (measured in headless Chrome, 12 kbps, 60 ms packets)
About **17 packets/s and roughly 22 kbps on the wire per listener** while talking. That breaks down as 12 kbps Opus, 2 kbps E2EE, 1.6 kbps RTP and about 5 kbps IP/UDP/SRTP. Idle uses ≈0 (pings only). In a mesh, the talker uploads one copy per listener. An hour of continuous talk to 3 people is about 30 MB up. Settings let you go down to 6 kbps.

## NAT traversal / TURN (free options)
STUN alone (Cloudflare and Google) works for most home and office networks. Some cellular carriers use CGNAT, which needs TURN. TURN only forwards ciphertext. Pick one:
- **Metered Open Relay**: free tier with 20 GB/month. Sign up and paste the credentials URL into Settings.
- **Cloudflare Realtime TURN**: 1,000 GB/month free. Deploy `turn-worker/`, a free Cloudflare Worker that keeps your API token server-side, and paste its URL into Settings.
- You can include the TURN settings in invite links so that members don't each need to configure them.

"Hide my IP" forces relay-only, so peers only ever see the TURN server's address.

## Known limits of the web build (they drive the Capacitor phase)
- **Background receive:** iOS Safari suspends the page when you lock the screen or switch apps. The app holds a screen wake lock as a stopgap.
- **Bluetooth:** headsets work as system audio devices. On desktop and Android Chrome you can pick devices in Settings. On iOS the OS controls routing, and the speaker vs. earpiece choice can't be made from the web. BT headset buttons arrive as media keys on a best-effort basis; use latch mode.
- **Mesh size:** roughly 6–8 talkers before uplink and CPU suffer. Larger channels would need an SFU, which would still be E2EE because of the SFrame layer.

## Capacitor roadmap
1. Wrap `dist/` with Capacitor (iOS + Android). Reuse all JS.
2. iOS: **PushToTalk framework** (`PTChannelManager`), the system PTT UI and lock-screen transmit, plus a background audio mode. Wake devices with a PTT push. Push needs a tiny relay, but the payload can be E2EE (sender id only).
3. Android: a foreground service of type `microphone|connectedDevice`, and `MediaSession` for BT PTT buttons. Use BLE (`@capacitor-community/bluetooth-le`) for dedicated BLE PTT buttons.
4. Store identity keys in the Keychain or Android Keystore instead of localStorage.
5. If WebView audio is unreliable in the background, move the WebRTC audio path into a native Capacitor plugin (libwebrtc) and keep the JS crypto/UI.
