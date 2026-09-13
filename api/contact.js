/* ==========================================================================
   POST /api/contact — the enquiry form's endpoint.

   Why this exists: every call to action on this site used to be a mailto:
   link. On a phone that often opens nothing at all, and the enquiry is lost
   silently. This turns an enquiry into an email that actually arrives.

   No dependencies. Resend is called over plain HTTPS with the global fetch
   built into the Node runtime, so this stays a zero-install static project.

   Two environment variables, both already set on the polisha project:
     RESEND_API_KEY  the Resend key
     EMAIL_FROM      a verified sender, e.g. "Polisha <noreply@yourdomain>"
   Neither is ever sent to the browser.
   ========================================================================== */

const TO = "tobaina@gmail.com";

const LIMITS = { name: 100, email: 254, message: 5000 };
const MIN_MESSAGE = 10;

// Best-effort throttle. Serverless instances are recycled, so this is a
// speed bump for casual abuse, not a security control.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;
const recent = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 500) {
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) recent.delete(key);
    }
  }
  return hits.length > RATE_MAX;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const body = readBody(req);

  // Honeypot. A real person never sees this field, so anything in it is a
  // bot. Answer as if it worked -- telling a bot it failed only teaches it
  // to try again.
  if (clean(body.company, 200)) {
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, LIMITS.name);
  const email = clean(body.email, LIMITS.email);
  const message = clean(body.message, LIMITS.message);

  const errors = {};
  if (!name) errors.name = "Please tell me your name.";
  if (!email) errors.email = "Please add an email address so I can reply.";
  else if (!looksLikeEmail(email)) errors.email = "That email address does not look right.";
  if (!message) errors.message = "Please describe what is happening.";
  else if (message.length < MIN_MESSAGE) errors.message = "A sentence or two would help.";

  if (Object.keys(errors).length) {
    return res.status(400).json({ ok: false, errors });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: "That is a few messages in a row. Try again in a minute." });
  }

  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    // Loud in the log, vague to the visitor -- configuration problems are
    // not the visitor's business, and they must never lose the message
    // without being told to use the email address instead.
    console.error("[contact] RESEND_API_KEY or EMAIL_FROM is not configured.");
    return res.status(503).json({
      ok: false,
      error: "The form is not available right now. Please email " + TO + " directly.",
    });
  }

  const text =
    "New enquiry from tobi.getpolisha.com\n\n" +
    "Name:  " + name + "\n" +
    "Email: " + email + "\n\n" +
    message + "\n";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from,
        to: [TO],
        reply_to: email,          // replying in the inbox reaches the sender
        subject: "Website enquiry — " + name,
        text: text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[contact] Resend refused the message:", response.status, detail);
      return res.status(502).json({
        ok: false,
        error: "The message could not be sent. Please email " + TO + " directly.",
      });
    }
  } catch (error) {
    console.error("[contact] Could not reach Resend:", error && error.message);
    return res.status(502).json({
      ok: false,
      error: "The message could not be sent. Please email " + TO + " directly.",
    });
  }

  return res.status(200).json({ ok: true });
};
