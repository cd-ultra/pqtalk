// Optional: free Cloudflare TURN (1,000 GB/month free tier) credential minter.
// Deploy with `npx wrangler deploy`, set secrets TURN_KEY_ID + TURN_KEY_API_TOKEN, and set
// ALLOWED_ORIGIN to your app's origin. Put the Worker URL in PQTalk > Settings > Credentials URL.
// TURN only relays already-encrypted packets (DTLS-SRTP + our SFrame layer); it can't read audio.
export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || origin, 'vary': 'origin' };
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
  },
};
