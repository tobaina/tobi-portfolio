/* ==========================================================================
   POST /api/contact, the enquiry form's endpoint.

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

/* ⚠️  THIS WAS A PERSONAL GMAIL ADDRESS UNTIL THE DOMAIN HAD MAIL.
   Every enquiry for work quoted in four figures landed in a personal inbox,
   and the fallback copy below could not name an address because there was no
   business one to name. getpolisha.com now has MX, SPF, DKIM and DMARC, and
   this mailbox is answered by more than one person, so an enquiry no longer
   depends on one individual reading it. */
const { senderFrom } = require("./_sender.js");

const TO = "hello@getpolisha.com";

/* --------------------------------------------------------------------------
   ONE LIST, NOT THREE

   getpolisha.com already keeps its marketing list as a Resend segment
   (src/lib/email.ts, addToMarketingAudience). Before this, an address that
   arrived through this form went nowhere but an inbox, so the same person
   could be a "contact" here and a "subscriber" there with no single place to
   mail from. Ticking the box on this form now writes into that same segment.

   WHY RESEND AND NOT A LIST OF OUR OWN: the promise beside the box is
   "unsubscribe any time", and keeping it needs somewhere durable to record
   that someone left. This is a static site with no database. A Resend
   segment is that store: broadcasts sent to it carry a working unsubscribe
   link and the List-Unsubscribe header Gmail and Apple Mail act on, and the
   suppression outlives any deploy.

   ⚠️  UNREACHABLE WITHOUT A DELIBERATE TICK. `unsubscribed: false` records
   the consent just given, which does resubscribe someone who previously left
   and has now opted in again. That is right, but only because getting here requires
   the box. If a caller ever appears that does not require one, this line
   quietly becomes a way of undoing people's unsubscribes.

   FOUND BY NAME, NOT BY AN ENVIRONMENT VARIABLE.

   ⚠️  This used to require RESEND_SEGMENT_ID, and no deployment of any of the
   three sites ever had it set. So from launch until this change every ticked
   box on every site was logged and dropped, and because this returned a tidy
   "no_segment" and the enquiry carried on, nothing ever looked broken. A
   required variable nobody sets is not configuration, it is an off switch
   that defaults to off.

   The segment is now looked up by the same name polisha's
   scripts/resend-setup.mts creates and reuses, so all three sites and that
   script converge on one segment with no shared state but the name.
   RESEND_SEGMENT_ID still wins when set, so an explicit override keeps
   working. A missing list must never cost someone their message, so every
   failure here is logged and swallowed.
   -------------------------------------------------------------------------- */

/* The segment lookup and the opt-in write live in api/_marketing.js, because
   the Workflow Audit is a second endpoint somebody can consent from and two
   copies of that logic would quietly create two segments with the same name.
   Underscore-prefixed so Vercel bundles it without routing to it. */
const { addToMarketingList, __resetSegmentCacheForTests } = require("./_marketing.js");

const LIMITS = { name: 100, email: 254, message: 5000, phone: 40, company: 200 };

/* The contact form's "What do you need help with?" dropdown.
   ⚠️  ALLOWLIST, NOT A STRING FIELD. Everything else on this form is the
   visitor's own words and is clearly labelled as such in the notification.
   This one is a fixed set of categories, so it is looked up rather than
   copied: a hand-written POST can send `need: "<anything>"` just as easily
   as the real form can, and an unvalidated value would be attacker-chosen
   text appearing in our inbox under a label that says it came from a menu.
   An unknown value is treated exactly like an untouched dropdown. */
const NEEDS = {
  check: "Free process check",
  diagnostic: "Operations Diagnostic",
  website: "Website or landing page",
  redesign: "Existing website redesign",
  system: "Business system or portal",
  automation: "Automation",
  unsure: "Not sure yet",
};
const NEED_UNSTATED = "Not stated";

/* ⚠️  READ FROM AN ALLOWLIST, EXACTLY LIKE `need`, NEVER AS FREE TEXT.
   A budget arrives from a dropdown, so the only values that may reach our
   inbox are the ones we put in that dropdown. Accepting the string as typed
   would let anything at all appear in a notification under a label that says
   it came from a menu, which is how a field like this becomes a way to write
   arbitrary text into somebody's mailbox. An unknown value is treated exactly
   like an untouched dropdown. */
const BUDGETS = {
  unsure: "Not sure yet",
  under1500: "Under CA$1,500",
  "1500to5000": "CA$1,500 to CA$5,000",
  "5000to15000": "CA$5,000 to CA$15,000",
  over15000: "Over CA$15,000",
};
const BUDGET_UNSTATED = "Not stated";
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
  //
  // ⚠️  THE TRAP IS `website`, NOT `company`. It used to be `company`, which
  // is now a real, visible, optional field on the form. If this still read
  // `company`, every honest visitor who filled in their company name would
  // have been answered with a cheerful 200 and silently discarded. Keep this
  // name in step with the hidden input in index.html.
  if (clean(body.website, 200)) {
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, LIMITS.name);
  const email = clean(body.email, LIMITS.email);
  const message = clean(body.message, LIMITS.message);
  // Both optional, both the visitor's own words, both capped and labelled as
  // free text in the notification so they are never mistaken for a value this
  // form validated.
  const phone = clean(body.phone, LIMITS.phone);
  const company = clean(body.company, LIMITS.company);
  // Strictly `=== true`. A missing field, "false", "off", 0 or anything else
  // a stray client might send is a no, because the only thing that may turn
  // this on is somebody ticking the box.
  const subscribe = body.subscribe === true;
  // Never required. A blank, missing or unrecognised value all mean the same
  // thing, and none of them may stop a message arriving.
  const need =
    Object.prototype.hasOwnProperty.call(NEEDS, body.need) ? NEEDS[body.need] : NEED_UNSTATED;
  // Same rules as `need`: optional, allowlisted, and never able to block a
  // message. Somebody who will not name a budget must still be able to write.
  const budget =
    Object.prototype.hasOwnProperty.call(BUDGETS, body.budget)
      ? BUDGETS[body.budget]
      : BUDGET_UNSTATED;

  const errors = {};
  if (!name) errors.name = "Please tell us your name.";
  if (!email) errors.email = "Please add an email address so we can reply.";
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
  /* The address comes from the environment, the name never does. See
     api/_sender.js for why. */
  const from = senderFrom(process.env.EMAIL_FROM);

  if (!key || !from) {
    // Loud in the log, vague to the visitor -- configuration problems are
    // not the visitor's business.
    //
    // ⚠️  THE ADDRESS IS BACK IN THIS MESSAGE, AND ONLY BECAUSE IT IS NOW A
    // BUSINESS ONE. It named a personal inbox once, which republished a
    // private address to every visitor who hit a misconfigured form, so it
    // was replaced by a pointer at the LinkedIn link. That pointer was always
    // the weaker answer: a company page cannot be messaged by the public. A
    // visitor whose message just failed needs somewhere to send it, and
    // hello@getpolisha.com is somewhere.
    console.error("[contact] RESEND_API_KEY or EMAIL_FROM is not configured.");
    return res.status(503).json({
      ok: false,
      error: "The form is not available right now. Please email us at hello@getpolisha.com and we will pick it up from there.",
    });
  }

  // Done before the notification so its outcome can go in the email. A
  // silent failure here would otherwise look exactly like a silent success.
  const listOutcome = subscribe ? await addToMarketingList(email, key) : "not_requested";

  const text =
    "New enquiry from systems.getpolisha.com\n\n" +
    "Name:  " + name + "\n" +
    "Email: " + email + "\n" +
    "Phone: " + (phone || "Not given") + "\n" +
    "Firm:  " + (company || "Not given") + "\n" +
    "Needs: " + need + "\n" +
    "Budget: " + budget + "\n" +
    "List:  " + listOutcome + "\n\n" +
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
        subject: "Website enquiry: " + name,
        text: text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[contact] Resend refused the message:", response.status, detail);
      return res.status(502).json({
        ok: false,
        error: "The message could not be sent. Please email us at hello@getpolisha.com and we will pick it up from there.",
      });
    }
  } catch (error) {
    console.error("[contact] Could not reach Resend:", error && error.message);
    return res.status(502).json({
      ok: false,
      error: "The message could not be sent. Please email us at hello@getpolisha.com and we will pick it up from there.",
    });
  }

  return res.status(200).json({ ok: true });
};

/* Test-only. Clears the in-process segment cache so tests/api-contact.test.mjs
   can exercise resolution more than once in a single node process, where the
   module is required exactly once and the cache would otherwise leak between
   cases. Clears memory and nothing else. */
module.exports.__resetSegmentCacheForTests = __resetSegmentCacheForTests;
