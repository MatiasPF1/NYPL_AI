/**
 * Send one alert email, to prove the key works before a demo depends on it.
 *
 *   node --env-file=.env.local scripts/test-email.mjs you@example.com
 *
 * Run from the frontend/ directory. It uses the same variables and the same
 * REST call the app does, so a pass here means the app can send too — and a
 * failure prints Resend's own message, which is the only useful thing when a
 * send is refused.
 */

const [, , to] = process.argv;
const key = process.env.RESEND_API_KEY;
const from = process.env.ALERT_FROM_EMAIL || "SafeNYC <onboarding@resend.dev>";

if (!to) {
  console.error("usage: node --env-file=.env.local scripts/test-email.mjs you@example.com");
  process.exit(2);
}
if (!key) {
  console.error("RESEND_API_KEY is not set - is .env.local the file you passed to --env-file?");
  process.exit(2);
}

console.log(`from ${from}\nto   ${to}`);

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    from,
    to: [to],
    subject: "SafeNYC test alert",
    text: "If you are reading this, SafeNYC can reach you when a walk goes wrong.\n\nhttps://www.google.com/maps?q=40.75808,-73.98551\n",
    html: '<div style="font:16px/1.5 system-ui,sans-serif"><p>If you are reading this, SafeNYC can reach you when a walk goes wrong.</p><p><a href="https://www.google.com/maps?q=40.75808,-73.98551">Open the last known position on a map</a></p></div>',
  }),
});

const payload = await res.json().catch(() => ({}));

if (res.ok) {
  console.log(`\nsent. id ${payload.id}`);
  console.log("check the inbox, and the spam folder - a first message from a shared sender often lands there.");
  process.exit(0);
}

console.error(`\nrefused: HTTP ${res.status}`);
console.error(`  ${payload.message ?? payload.name ?? JSON.stringify(payload)}`);

// The two failures everybody hits, named so they are not a puzzle.
if (/only send testing emails to your own email|verify a domain/i.test(payload.message ?? "")) {
  console.error(
    "\n  -> The shared onboarding@resend.dev sender only delivers to the address that owns\n" +
      "     the Resend account. Send to that address, or verify a domain and set\n" +
      "     ALERT_FROM_EMAIL to something at it.",
  );
} else if (res.status === 401 || res.status === 403) {
  console.error("\n  -> The API key is wrong or was revoked. Make a new one under API Keys in the Resend dashboard.");
}
process.exit(1);
