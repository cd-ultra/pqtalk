# PQTalk mailbox server

Cloudflare Worker (free plan) that stores and forwards encrypted messages, prekey bundles,
encrypted attachments and voice-room signaling. It never sees plaintext.

- Local: `npm install && npm run dev` (http://localhost:8787)
- Deploy from your PC: `npx wrangler login && npx wrangler deploy`
- Deploy from the Cloudflare dashboard: Workers & Pages → Import a repository →
  project name `pqtalk-server`, root directory `server`, no build command,
  deploy command `npx wrangler deploy`, preview builds off.

A browser visit to the deployed address should show "PQTalk mailbox server".
