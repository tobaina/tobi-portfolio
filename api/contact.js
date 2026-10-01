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

const TO = "tobaina@gmail.com";

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

/* ⚠️  DO NOT "TIDY" THIS NAME. It is matched literally against what already
   exists in Resend and must stay byte-identical in all four places that know
   it: this file, polisha's src/lib/email.ts and scripts/resend-setup.mts, and
   cv-verdict-ai's src/lib/marketing/marketingList.server.ts. Renaming it
   would not rename the segment; it would create a second, empty one and split
   the list. */
const SEGMENT_NAME = "Free check opt-ins";

// Resolved once per instance. A success is cached; a failure is NOT, so a
// momentary Resend outage does not disable the list for the instance's life.
let cachedSegmentId = null;
let inFlightSegment = null;

function __resetSegmentCacheForTests() {
  cachedSegmentId = null;
  inFlightSegment = null;
}

async function resendJson(key, method, path, body) {
  const res = await fetch("https://api.resend.com" + path, {
    method: method,
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The status only. Never the key, the headers, or the body -- which on this
  // endpoint lists every segment name on the account.
  if (!res.ok) throw new Error(method + " " + path + " -> " + res.status);
  return res.json();
}

/* ⚠️  PAGINATES. `GET /segments` returns 20 per page by default, so an
   unpaginated call silently stops finding the list the day the account's 21st
   segment appears -- and the symptom is a duplicate segment being created and
   the list splitting, long after anyone remembers touching this. */
async function listSegments(key) {
  const all = [];
  let after;
  // Bounded rather than `while (true)`: a provider that always says has_more
  // must not spin forever on a request path.
  for (let page = 0; page < 20; page++) {
    const query = after
      ? "?limit=100&after=" + encodeURIComponent(after)
      : "?limit=100";
    const payload = await resendJson(key, "GET", "/segments" + query);
    const batch = (payload && payload.data) || [];
    all.push.apply(all, batch);
    if (!payload || !payload.has_more || batch.length === 0) break;
    after = batch[batch.length - 1] && batch[batch.length - 1].id;
    if (!after) break;
  }
  return all;
}

/* ⚠️  "OLDEST" IS THE RACE FIX, NOT A PREFERENCE. Two instances taking a
   first opt-in at the same moment can both find nothing and both create a
   segment. Everyone picking the oldest means they converge on the same one
   from the next request on, instead of each keeping whichever it created and
   the list splitting in two permanently. */
function oldestNamed(segments) {
  const matches = segments.filter(function (segment) {
    return segment && segment.name === SEGMENT_NAME;
  });
  if (matches.length === 0) return null;
  matches.sort(function (a, b) {
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });
  return (matches[0] && matches[0].id) || null;
}

async function resolveSegmentId(key) {
  const configured = process.env.RESEND_SEGMENT_ID;
  if (configured) return configured;
  if (cachedSegmentId) return cachedSegmentId;
  if (inFlightSegment) return inFlightSegment;

  inFlightSegment = (async function () {
    const existing = oldestNamed(await listSegments(key));
    if (existing) return existing;
    await resendJson(key, "POST", "/segments", { name: SEGMENT_NAME });
    // Re-list rather than trusting the id just created, so two instances that
    // raced both settle on the same (oldest) segment. One extra request, once,
    // on the first opt-in ever.
    return oldestNamed(await listSegments(key));
  })()
    .then(function (id) {
      if (id) cachedSegmentId = id;
      return id;
    })
    .catch(function (error) {
      console.error(
        "[contact] Could not resolve the shared segment:",
        error && error.message,
      );
      return null;
    })
    .finally(function () {
      inFlightSegment = null;
    });

  return inFlightSegment;
}

async function addToMarketingList(email, key) {
  const segmentId = await resolveSegmentId(key);
  if (!segmentId) {
    console.info('[contact] No segment named "' + SEGMENT_NAME + '"; opted-in address not stored.');
    return "no_segment";
  }
  try {
    const res = await fetch("https://api.resend.com/contacts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email, unsubscribed: false, segments: [segmentId] }),
    });
    if (!res.ok) {
      console.error("[contact] Resend rejected contact:", res.status);
      return "http_" + res.status;
    }
    return "added";
  } catch (error) {
    console.error("[contact] Could not reach Resend for the list:", error && error.message);
    return "fetch_threw";
  }
}

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
  website: "Website or landing page",
  redesign: "Existing website redesign",
  system: "Business system or portal",
  automation: "Automation",
  unsure: "Not sure yet",
};
const NEED_UNSTATED = "Not stated";
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
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    // Loud in the log, vague to the visitor -- configuration problems are
    // not the visitor's business.
    //
    // ⚠️  NO ADDRESS IN THIS MESSAGE. It used to name the inbox directly,
    // which republished a personal address to every visitor who hit a
    // misconfigured form. The page no longer shows an address anywhere, so
    // the fallback points at a route that does exist. When a business
    // address is chosen, name it here and in the two messages below.
    console.error("[contact] RESEND_API_KEY or EMAIL_FROM is not configured.");
    return res.status(503).json({
      ok: false,
      error: "The form is not available right now. Please reach us through the LinkedIn link on this page.",
    });
  }

  // Done before the notification so its outcome can go in the email. A
  // silent failure here would otherwise look exactly like a silent success.
  const listOutcome = subscribe ? await addToMarketingList(email, key) : "not_requested";

  const text =
    "New enquiry from tobi.getpolisha.com\n\n" +
    "Name:  " + name + "\n" +
    "Email: " + email + "\n" +
    "Phone: " + (phone || "Not given") + "\n" +
    "Firm:  " + (company || "Not given") + "\n" +
    "Needs: " + need + "\n" +
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
        error: "The message could not be sent. Please reach us through the LinkedIn link on this page.",
      });
    }
  } catch (error) {
    console.error("[contact] Could not reach Resend:", error && error.message);
    return res.status(502).json({
      ok: false,
      error: "The message could not be sent. Please reach us through the LinkedIn link on this page.",
    });
  }

  return res.status(200).json({ ok: true });
};

/* Test-only. Clears the in-process segment cache so tests/api-contact.test.mjs
   can exercise resolution more than once in a single node process, where the
   module is required exactly once and the cache would otherwise leak between
   cases. Clears memory and nothing else. */
module.exports.__resetSegmentCacheForTests = __resetSegmentCacheForTests;
