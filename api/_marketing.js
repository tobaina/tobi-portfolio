/* ==========================================================================
   The marketing list, shared by every endpoint that can add somebody to it.

   This was inside api/contact.js until the Workflow Audit became a second
   place a visitor can consent from. Two copies of a segment lookup is how a
   list silently splits in two: one endpoint creates "Free check opt-ins",
   the other creates it again a second later, and half the consented
   addresses end up somewhere nobody looks.

   The log prefix is passed in so each caller still says which endpoint it
   was, which is the only thing the move cost.
   ========================================================================== */
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

/* `tag` is threaded through rather than read from an enclosing scope: this
   function is called from addToMarketingList, and referring to that caller's
   local would be a ReferenceError thrown only inside the catch block, which
   is to say only during a Resend outage, which is the worst possible moment
   to discover it. */
async function resolveSegmentId(key, tag) {
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
        tag + "Could not resolve the shared segment:",
        error && error.message,
      );
      return null;
    })
    .finally(function () {
      inFlightSegment = null;
    });

  return inFlightSegment;
}

/* `who` names the endpoint in the logs. Without it both callers would log
   as "[contact]" and a list problem reported by the audit would send you
   reading the wrong file. It defaults so an older caller cannot break. */
async function addToMarketingList(email, key, who) {
  const tag = "[" + (who || "contact") + "] ";
  const segmentId = await resolveSegmentId(key, tag);
  if (!segmentId) {
    console.info(tag + 'No segment named "' + SEGMENT_NAME + '"; opted-in address not stored.');
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
      console.error(tag + "Resend rejected contact:", res.status);
      return "http_" + res.status;
    }
    return "added";
  } catch (error) {
    console.error(tag + "Could not reach Resend for the list:", error && error.message);
    return "fetch_threw";
  }
}

module.exports = {
  SEGMENT_NAME: SEGMENT_NAME,
  addToMarketingList: addToMarketingList,
  __resetSegmentCacheForTests: __resetSegmentCacheForTests,
};
