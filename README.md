# PQTalk: a post-quantum private messenger with calls and walkie-talkie

PQTalk is a Signal-style messenger that runs in the browser on Windows, macOS, iOS, Android and Linux. It has 1:1 and group chats, photos, voice messages, read receipts, typing indicators, voice calls, and a walkie-talkie mode in every chat. People find each other by invite link or QR code, with no phone number or email. Everything is end-to-end encrypted, and every key exchange is hybrid post-quantum (X25519 + ML-KEM-768).

The only server is a small Cloudflare Worker that stores ciphertext until the recipient comes online. It can't read messages, see attachments, or tell who sent a message.

```
npm install
npm test                                   # crypto unit tests
cd server && npm install && npm run dev    # local mailbox server on :8787
VITE_SERVER_URL=http://127.0.0.1:8787 npm run dev
```

## Deploy (free)

1. **Server.** `cd server && npx wrangler login && npx wrangler deploy`. It runs on the Workers free plan (SQLite-backed Durable Objects). Copy the `https://pqtalk-server.<you>.workers.dev` URL it prints.
2. **App.** Every push to `main` builds and publishes the app to GitHub Pages with the server address from `.env.production` built in. To point it at a different server, change that file, or set the Actions variable `SERVER_URL`, which takes priority.
3. **Calls on strict cellular networks (optional).** Deploy `turn-worker/` (Cloudflare TURN, free tier) and paste its URL under Settings → Calls.

## How it maps to Signal

| Signal | PQTalk | Code |
|---|---|---|
| PQXDH (X25519 + ML-KEM) with signed prekeys and one-time prekeys | Same structure. The invite secret (or group secret) is also mixed in as a PSK, a quantum-safe authentication factor on top of the Ed25519 signatures. | `src/crypto/pqxdh.js` |
| Double Ratchet + SPQR (triple ratchet) | Double Ratchet where every DH turn also carries a fresh ML-KEM-768 key and a ciphertext to the peer's previous one, mixed into the root key. A failed decrypt never changes state. | `src/crypto/ratchet.js` |
| Sealed sender | The server sees only the recipient's random mailbox ID and an opaque session ID. Sender name and mailbox are inside the encryption. | `src/msg/engine.js` |
| Attachments | Encrypted on the device (AES-256-GCM, a random key per file). The key travels inside the message and the server stores the encrypted file for 30 days. | `src/msg/engine.js` |
| Groups | Client-side groups with pairwise fan-out. Members who aren't each other's contacts set up sessions using the group secret as the PSK. | `src/msg/engine.js` |
| Calls | Each call gets a room derived from the chat secret. The voice layer uses a hybrid PQ handshake, SFrame frame encryption and WebRTC. Walkie-talkie uses the same room in push-to-talk mode. | `src/msg/voice.js`, `src/room.js` |
| Safety numbers | Signal's algorithm | `src/crypto/identity.js` |

## Tests

- `npm test`: PQXDH agreement, tampering, ratchet ordering, replay, failed-decrypt safety, many ML-KEM turns, state persistence, and the voice-room crypto.
- `test/e2e_messenger.py`: three separate browser profiles against a local server (24 checks). It covers invites, 1:1 chat, receipts, typing, groups between strangers, photos, voice notes, offline delivery, a voice call with decrypted audio, and walkie-talkie.

## Not yet done

- **Push notifications.** You're notified only while the app is open in a tab. Background delivery needs Web Push or the native (Capacitor) builds.
- **Multiple devices per account, and backups.** Keys live on one device. Clearing browser data loses chats.
- **Group admin roles and removing members.** Members can add others or leave. Removing someone currently means making a new group.
- **Server abuse limits.** Size caps exist, but there's no rate limiting yet. Add Cloudflare rate-limiting rules before a public launch.
- **Disappearing messages, reactions, replies, editing and video.**
- **An independent security review.** Don't rely on this for high-risk use until it has had one.
- **Native shell for walkie-talkie with the screen locked.** iOS PushToTalk framework, Android foreground service, BLE PTT buttons.
