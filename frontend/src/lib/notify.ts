import "server-only";

/**
 * Getting a safety alert to a human, by email, via Resend.
 *
 * This replaced Twilio SMS after the trial account turned out to refuse
 * free-form message bodies — a safety alert is exactly the kind of text a
 * trial will not carry, and lifting that needs a paid upgrade. Email has no
 * equivalent gatekeeping. The alert row, the consent gate, and the message
 * itself are unchanged; only the wire is different.
 *
 * `server-only` makes a client import a build error rather than a leaked key,
 * and RESEND_API_KEY carries no NEXT_PUBLIC_ prefix so Next will not inline it
 * into the browser bundle regardless.
 *
 * Missing credentials are a supported state. The alert is still recorded and
 * the panel says so. A missing API key must never be why a safety feature
 * throws.
 */

export type SendResult =
  | { status: "sent"; id: string }
  | { status: "not_configured" }
  | { status: "failed"; error: string };

const ENDPOINT = "https://api.resend.com/emails";

// Resend's shared sender works with no domain to verify, at one cost: it will
// only deliver to the address that owns the Resend account. Good enough to
// demo with, and the reason ALERT_FROM_EMAIL exists for when a domain is set
// up and alerts need to reach anyone else.
const DEFAULT_FROM = "SafeNYC <onboarding@resend.dev>";

export function notifyConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(input: string | null | undefined): string | null {
  const value = (input ?? "").trim().toLowerCase();
  if (!value || value.length > 320 || !EMAIL.test(value)) return null;
  return value;
}

/** US 10-digit input, or anything already E.164, to E.164. Null if neither. */
export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) {
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  // A bare 10-digit number is assumed to be US/Canada: this is a New York
  // walking app, and guessing anything else would be worse than asking.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export async function sendAlertEmail(
  to: string,
  subject: string,
  body: string,
  mapUrl: string,
): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Logged so the loop is demonstrable without an account: the exact alert
    // that would have gone out appears in the dev server's output.
    console.warn(`[SafeNYC] email not configured; would have sent to ${to}: ${body}`);
    return { status: "not_configured" };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || DEFAULT_FROM,
        to: [to],
        subject,
        // Plain text as well as HTML: an alert that arrives as a wall of
        // markup on a locked screen has failed at the only moment it matters.
        text: `${body}\n\n${mapUrl}\n`,
        html:
          `<div style="font:16px/1.5 system-ui,sans-serif">` +
          `<p>${escapeHtml(body)}</p>` +
          `<p><a href="${escapeHtml(mapUrl)}">Open the last known position on a map</a></p>` +
          `<p style="color:#666;font-size:13px">Sent by SafeNYC because you turned on live location sharing. ` +
          `Turn it off in the app to stop these.</p></div>`,
      }),
      signal: AbortSignal.timeout(8000),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "failed", error: payload?.message ?? `HTTP ${res.status}` };
    }
    return { status: "sent", id: payload.id };
  } catch (e) {
    return {
      status: "failed",
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
