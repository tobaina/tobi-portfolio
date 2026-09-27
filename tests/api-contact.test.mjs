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

async function run(body, ip, segmentId) {
  if (segmentId === undefined) delete process.env.RESEND_SEGMENT_ID;
  else process.env.RESEND_SEGMENT_ID = segmentId;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '' };
  };
  const res = mkRes();
  await handler(mkReq(body, ip), res);
  return { res, calls };
}

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

// 3. ticked, NO segment configured -> enquiry must still succeed
{
  const { res, calls } = await run({ ...BASE, subscribe: true }, '3.3.3.3');
  check('no segment: enquiry still succeeds', res.code === 200 && res.body.ok === true);
  check('no segment: no contact attempted', !calls.some(c => c.url.endsWith('/contacts')));
  check('no segment: owner email says no_segment', /List:  no_segment/.test(calls[0].body.text));
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

// 6. honeypot still wins, and never subscribes
{
  const { res, calls } = await run({ ...BASE, subscribe: true, company: 'bot' }, '6.6.6.6', 'seg_123');
  check('honeypot: answered as if it worked', res.code === 200 && res.body.ok === true);
  check('honeypot: nothing sent at all', calls.length === 0);
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
