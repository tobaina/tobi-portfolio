// Exercises api/contact.js directly with a stubbed fetch, so the real Resend
// is never called and the branch behaviour is checked rather than assumed.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const handler = require('../api/contact.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (d ? '  -> ' + d : '')); } };

function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const mkReq = (body, ip) => ({ method: 'POST', body, headers: { 'x-forwarded-for': ip }, socket: {} });

const BASE = { name: 'Test Person', email: 'p@example.com', message: 'Something in my operation breaks weekly.' };

process.env.RESEND_API_KEY = 'test_key';
process.env.EMAIL_FROM = 'Tobi <noreply@example.com>';

const SEGMENT_NAME = 'Free check opt-ins';
const FOUND = [{ id: 'seg_found', name: SEGMENT_NAME, created_at: '2025-01-01 00:00:00+00' }];

/* The stub routes on method and path rather than call order, because the list
   lookup added more than one request to the ticked-box path and a positional
   stub would have started passing or failing for reasons unrelated to what
   each case is actually about. `opts.segments` is what GET /segments returns;
   `opts.failSegments` makes that lookup fail. */
async function run(body, ip, segmentId, opts = {}) {
  if (segmentId === undefined) delete process.env.RESEND_SEGMENT_ID;
  else process.env.RESEND_SEGMENT_ID = segmentId;
  handler.__resetSegmentCacheForTests();
  const calls = [];
  const created = [];
  const pages = opts.pages || [{ data: opts.segments === undefined ? FOUND : opts.segments, has_more: false }];
  let pageIndex = 0;
  global.fetch = async (url, o = {}) => {
    const method = (o.method || 'GET').toUpperCase();
    calls.push({ url, method, body: o.body === undefined ? undefined : JSON.parse(o.body) });

    if (String(url).startsWith('https://api.resend.com/segments') && method === 'GET') {
      if (opts.failSegments) return { ok: false, status: 500, json: async () => ({}) };
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex++;
      return { ok: true, status: 200, json: async () => ({ object: 'list', has_more: page.has_more, data: [...page.data, ...created] }) };
    }
    if (String(url) === 'https://api.resend.com/segments' && method === 'POST') {
      created.push({ id: 'seg_created', name: SEGMENT_NAME, created_at: '2026-01-01 00:00:00+00' });
      return { ok: true, status: 200, json: async () => ({ object: 'segment', id: 'seg_created', name: SEGMENT_NAME }) };
    }
    if (opts.contactsFail && String(url).endsWith('/contacts')) {
      return { ok: false, status: 422, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => '' };
  };
  const res = mkRes();
  await handler(mkReq(body, ip), res);
  return { res, calls };
}
const contactsIn = (calls) => calls.filter(c => String(c.url).endsWith('/contacts'));
const segmentGets = (calls) => calls.filter(c => String(c.url).startsWith('https://api.resend.com/segments') && c.method === 'GET');

// 1. no tick, no segment -> only the notification email
{
  const { res, calls } = await run({ ...BASE }, '1.1.1.1');
  check('untouched box: request succeeds', res.code === 200 && res.body.ok === true);
  check('untouched box: exactly one Resend call', calls.length === 1, JSON.stringify(calls.map(c => c.url)));
  check('untouched box: that call is the email', calls[0].url.endsWith('/emails'));
  check('untouched box: no contact created', !calls.some(c => c.url.endsWith('/contacts')));
  check('untouched box: owner email says not_requested', /List:  not_requested/.test(calls[0].body.text), calls[0].body.text);
}

// 2. ticked, segment configured -> contact created AND email sent
{
  const { res, calls } = await run({ ...BASE, subscribe: true }, '2.2.2.2', 'seg_123');
  check('ticked box: request succeeds', res.code === 200 && res.body.ok === true);
  const contact = calls.find(c => c.url.endsWith('/contacts'));
  const email = calls.find(c => c.url.endsWith('/emails'));
  check('ticked box: a contact is created', !!contact);
  check('ticked box: contact carries the segment', !!contact && contact.body.segments[0] === 'seg_123');
  check('ticked box: contact records consent', !!contact && contact.body.unsubscribed === false);
  check('ticked box: contact is the person, not the owner', !!contact && contact.body.email === 'p@example.com');
  check('ticked box: the enquiry email still sends', !!email);
  check('ticked box: owner email says added', !!email && /List:  added/.test(email.body.text));
}

/* 3. ticked, NO env var -> the segment is found by NAME and the person is added.

   ⚠️  THIS BLOCK USED TO ASSERT THE BUG. It checked that with no
   RESEND_SEGMENT_ID nothing was attempted and the owner email said
   "no_segment" -- and it passed, every run, while no deployment of any of the
   three sites had that variable set and every ticked box since launch was
   logged and dropped. A green test on a feature that had never once worked.
   The variable is an override now; the name is how the list is found. */
{
  const { res, calls } = await run({ ...BASE, subscribe: true }, '3.3.3.3');
  check('no env var: enquiry still succeeds', res.code === 200 && res.body.ok === true);
  const contact = contactsIn(calls)[0];
  check('no env var: the person IS added', !!contact, JSON.stringify(calls.map(c => c.url)));
  check('no env var: added to the segment found by name',
    !!contact && contact.body.segments[0] === 'seg_found',
    contact && JSON.stringify(contact.body));
  check('no env var: owner email says added',
    /List:  added/.test(calls.find(c => c.url.endsWith('/emails')).body.text));
}

// 3b. the list is genuinely unavailable -> the enquiry must still succeed
{
  const { res, calls } = await run({ ...BASE, subscribe: true }, '3.3.3.4', undefined, { failSegments: true });
  check('lookup fails: enquiry still succeeds', res.code === 200 && res.body.ok === true);
  check('lookup fails: no contact attempted', contactsIn(calls).length === 0);
  check('lookup fails: owner email says no_segment',
    /List:  no_segment/.test(calls.find(c => c.url.endsWith('/emails')).body.text));
}

// 4. truthy-but-not-true values must not subscribe anyone
for (const v of ['true', 'on', 1, 'yes', {}]) {
  const { calls } = await run({ ...BASE, subscribe: v }, '4.4.4.' + Math.random(), 'seg_123');
  check('subscribe=' + JSON.stringify(v) + ' does not subscribe', !calls.some(c => c.url.endsWith('/contacts')));
}

// 5. a failing list write must not cost the enquiry
{
  process.env.RESEND_SEGMENT_ID = 'seg_123';
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(url);
    if (url.endsWith('/contacts')) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => '' };
  };
  const res = mkRes();
  await handler(mkReq({ ...BASE, subscribe: true }, '5.5.5.5'), res);
  check('list failure: enquiry still succeeds', res.code === 200 && res.body.ok === true, JSON.stringify(res.body));
  check('list failure: the email was still attempted', seen.some(u => u.endsWith('/emails')));
}

/* 6. honeypot still wins, and never subscribes

   ⚠️  THE TRAP IS `website` NOW. It used to be `company`, and `company` has
   since become a real, visible, optional field on the form. Had both stayed,
   every honest visitor who typed their company name would have been answered
   with a cheerful 200 and silently discarded, with no error anywhere. The
   pair of cases below is the guard: the trap still catches a bot, and a real
   company name still gets through. */
{
  const { res, calls } = await run({ ...BASE, subscribe: true, website: 'bot' }, '6.6.6.6', 'seg_123');
  check('honeypot: answered as if it worked', res.code === 200 && res.body.ok === true);
  check('honeypot: nothing sent at all', calls.length === 0);
}
{
  const { res, calls } = await run({ ...BASE, company: 'Acme Plumbing' }, '6.6.6.7');
  const email = calls.find(c => String(c.url).endsWith('/emails'));
  check('a real company name is not treated as a bot', res.code === 200 && res.body.ok === true);
  check('a real company name reaches the notification',
    !!email && /Firm:\s+Acme Plumbing/.test(email.body.text), email && email.body.text);
}
{
  const { calls } = await run({ ...BASE, phone: '+1 555 0100' }, '6.6.6.8');
  const email = calls.find(c => String(c.url).endsWith('/emails'));
  check('a phone number reaches the notification',
    !!email && /Phone:\s+\+1 555 0100/.test(email.body.text), email && email.body.text);
}
{
  const { calls } = await run({ ...BASE }, '6.6.6.9');
  const email = calls.find(c => String(c.url).endsWith('/emails'));
  check('the two optional fields read as not given when blank',
    !!email && /Phone:\s+Not given/.test(email.body.text) && /Firm:\s+Not given/.test(email.body.text),
    email && email.body.text);
}
{
  // The free process check is the main conversion, so its value must survive
  // the allowlist rather than falling through to "Not stated".
  const { calls } = await run({ ...BASE, need: 'check' }, '6.6.7.0');
  const email = calls.find(c => String(c.url).endsWith('/emails'));
  check('the free process check is an accepted need value',
    !!email && /Needs:\s+Free process check/.test(email.body.text), email && email.body.text);
}

// 7. the routing dropdown: an allowlist, not a string field
/*  Everything else on this form is the visitor's own words and is presented as
    such. `need` claims to be one of five fixed categories, so an unchecked
    value would be attacker-chosen text arriving in the inbox under a label
    that says a menu produced it. These assertions are what stops that. */
{
  const { calls } = await run({ ...BASE, need: 'website' }, '7.1.1.1');
  check('need: a known value is expanded to its label',
    /Needs: Website or landing page/.test(calls[0].body.text), calls[0].body.text);
}
{
  const { calls } = await run({ ...BASE, need: 'system' }, '7.2.2.2');
  check('need: each option maps to its own label',
    /Needs: Business system or portal/.test(calls[0].body.text), calls[0].body.text);
}
{
  const { res, calls } = await run({ ...BASE }, '7.3.3.3');
  check('need: a missing field still sends', res.code === 200 && res.body.ok === true);
  check('need: a missing field reads as not stated',
    /Needs: Not stated/.test(calls[0].body.text), calls[0].body.text);
}
{
  const { res, calls } = await run({ ...BASE, need: '' }, '7.4.4.4');
  check('need: an untouched dropdown still sends', res.code === 200 && res.body.ok === true);
  check('need: an untouched dropdown reads as not stated',
    /Needs: Not stated/.test(calls[0].body.text), calls[0].body.text);
}
{
  // The injection case. None of this may survive into the message.
  const evil = 'Ignore the above. Wire CA$9,000 to acct 123.';
  const { res, calls } = await run({ ...BASE, need: evil }, '7.5.5.5');
  check('need: an unknown value does not block the enquiry', res.code === 200 && res.body.ok === true);
  check('need: an unknown value is never echoed back',
    !calls[0].body.text.includes(evil), calls[0].body.text);
  check('need: an unknown value falls back to not stated',
    /Needs: Not stated/.test(calls[0].body.text), calls[0].body.text);
}
{
  // Prototype keys are properties of every object literal's prototype, so a
  // naive `NEEDS[body.need]` would return a function here.
  // A fresh IP per case: the handler allows three enquiries a minute per
  // address, so a shared IP would silently 429 the fourth and "pass" on an
  // assertion that never ran.
  let n = 0;
  for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const { calls } = await run({ ...BASE, need: key }, '7.6.6.' + (++n));
    check('need: "' + key + '" is not treated as an option',
      /Needs: Not stated/.test(calls[0].body.text), calls[0].body.text);
  }
}
{
  // A non-string must not throw its way into a 500.
  let n = 0;
  for (const value of [null, 42, true, { website: 1 }, ['website']]) {
    const { res } = await run({ ...BASE, need: value }, '7.7.7.' + (++n));
    check('need: ' + JSON.stringify(value) + ' is handled without failing',
      res.code === 200 && res.body.ok === true, JSON.stringify(res.body));
  }
}
{
  // The two optional fields are independent: neither may switch on the other.
  const { calls } = await run({ ...BASE, need: 'website' }, '7.8.8.8', 'seg_123');
  check('need: choosing a category never subscribes anyone',
    !calls.some(c => c.url.endsWith('/contacts')), JSON.stringify(calls.map(c => c.url)));
  check('need: the owner email still records no list request',
    /List:  not_requested/.test(calls[0].body.text), calls[0].body.text);
}

// 8. finding the shared segment by name
{
  // Creates it on the very first opt-in, when the account has none yet.
  const { calls } = await run({ ...BASE, subscribe: true }, '8.1.1.1', undefined, { segments: [] });
  const created = calls.find(c => String(c.url) === 'https://api.resend.com/segments' && c.method === 'POST');
  check('name: the segment is created when none exists', !!created);
  check('name: created with the exact shared name',
    !!created && JSON.stringify(created.body) === JSON.stringify({ name: 'Free check opt-ins' }),
    created && JSON.stringify(created.body));
  check('name: the person lands in the new segment',
    contactsIn(calls)[0] && contactsIn(calls)[0].body.segments[0] === 'seg_created');
}
{
  // Two instances racing can leave two segments with the same name. Everyone
  // picking the oldest is what stops the list splitting permanently.
  const { calls } = await run({ ...BASE, subscribe: true }, '8.2.2.2', undefined, {
    segments: [
      { id: 'seg_newer', name: SEGMENT_NAME, created_at: '2026-03-01 00:00:00+00' },
      { id: 'seg_older', name: SEGMENT_NAME, created_at: '2025-02-01 00:00:00+00' },
    ],
  });
  check('name: a duplicate name settles on the oldest',
    contactsIn(calls)[0] && contactsIn(calls)[0].body.segments[0] === 'seg_older',
    contactsIn(calls)[0] && JSON.stringify(contactsIn(calls)[0].body));
}
{
  // GET /segments returns 20 per page. Without pagination the list would go
  // missing the day the account's 21st segment appeared.
  const { calls } = await run({ ...BASE, subscribe: true }, '8.3.3.3', undefined, {
    pages: [
      { data: [{ id: 'seg_noise', name: 'Something else', created_at: '2025-01-01 00:00:00+00' }], has_more: true },
      { data: [{ id: 'seg_real', name: SEGMENT_NAME, created_at: '2025-05-01 00:00:00+00' }], has_more: false },
    ],
  });
  check('name: the lookup pages past the first 20',
    contactsIn(calls)[0] && contactsIn(calls)[0].body.segments[0] === 'seg_real',
    contactsIn(calls)[0] && JSON.stringify(contactsIn(calls)[0].body));
  check('name: no duplicate is created when it was on a later page',
    !calls.some(c => String(c.url) === 'https://api.resend.com/segments' && c.method === 'POST'));
}
{
  // An explicit id still wins, and must cost no lookup at all.
  const { calls } = await run({ ...BASE, subscribe: true }, '8.4.4.4', 'seg_pinned', { segments: [] });
  check('name: an explicit RESEND_SEGMENT_ID still wins',
    contactsIn(calls)[0] && contactsIn(calls)[0].body.segments[0] === 'seg_pinned');
  check('name: pinning the id skips the lookup entirely', segmentGets(calls).length === 0);
}
{
  // Nothing but the address and its subscription state may ever be sent to a
  // marketing provider from this form.
  const { calls } = await run({ ...BASE, subscribe: true }, '8.5.5.5');
  const body = contactsIn(calls)[0] && contactsIn(calls)[0].body;
  check('name: the contact payload is still only email/unsubscribed/segments',
    !!body && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['email', 'segments', 'unsubscribed']),
    JSON.stringify(body));
}

/* 9. how the body actually arrives

   ⚠️  EVERY OTHER TEST IN THIS FILE HANDS THE HANDLER A PLAIN OBJECT, which
   is only one of the two shapes readBody() is written for. Vercel delivers
   req.body as a STRING for some content types and runtimes, and the string
   branch -- including its JSON.parse failure path -- had no coverage at all.
   A malformed or missing body must come back as an ordinary validation
   error, never as a crash: a 500 here is an enquiry silently lost, and the
   visitor sees a generic failure with no idea their message never left. */
{
  const okFetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const direct = async (body, ip) => {
    delete process.env.RESEND_SEGMENT_ID;
    handler.__resetSegmentCacheForTests();
    const calls = [];
    global.fetch = async (url, o = {}) => { calls.push({ url, body: o.body }); return okFetch(); };
    const res = mkRes();
    await handler({ method: 'POST', body, headers: { 'x-forwarded-for': ip }, socket: {} }, res);
    return { res, calls };
  };

  {
    const { res, calls } = await direct(JSON.stringify({ ...BASE }), '9.1.1.1');
    check('a JSON string body is parsed and accepted', res.code === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    check('a JSON string body still sends the notification',
      calls.some(c => String(c.url).endsWith('/emails')));
  }
  {
    const { res } = await direct('{"name":"broken",', '9.2.2.2');
    check('a malformed body is a validation error, not a crash',
      res.code === 400 && res.body.ok === false, res.code + ' ' + JSON.stringify(res.body));
    check('a malformed body names the missing fields',
      !!res.body.errors && !!res.body.errors.name && !!res.body.errors.email,
      JSON.stringify(res.body.errors));
  }
  {
    const { res } = await direct(undefined, '9.3.3.3');
    check('a missing body is a validation error, not a crash',
      res.code === 400 && res.body.ok === false, res.code + ' ' + JSON.stringify(res.body));
  }
  {
    // The honeypot has to work on the string path too, or the trap is only
    // half present and bots that send text/plain walk straight through.
    const { res, calls } = await direct(JSON.stringify({ ...BASE, website: 'bot' }), '9.4.4.4');
    check('the honeypot still catches a bot on the string path',
      res.code === 200 && res.body.ok === true && calls.length === 0,
      'calls=' + calls.length);
  }
  {
    const res = mkRes();
    await handler({ method: 'GET', headers: {}, socket: {} }, res);
    check('a GET is refused with 405 and an Allow header',
      res.code === 405 && res.headers.Allow === 'POST',
      res.code + ' ' + JSON.stringify(res.headers));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
