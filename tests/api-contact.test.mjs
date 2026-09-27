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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
