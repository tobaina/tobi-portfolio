/* ==========================================================================
   api/audit.js and audit-score.js

   Two things are worth more than the rest of this file:
     1. The HONESTY CAP. A lead magnet that inflates its own number is the
        exact thing this business claims not to be, so the cap is asserted
        from both directions: it fires when the arithmetic exceeds what the
        visitor said their admin costs, and it does NOT fire otherwise.
     2. The server RE-SCORES. The browser posts a figure and anybody can post
        anything, so the notification must carry the recomputed number and
        flag a mismatch rather than repeat what it was told.
   ========================================================================== */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const score = require('../audit-score.js');
const handler = require('../api/audit.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

process.env.RESEND_API_KEY = 'test_key';
process.env.EMAIL_FROM = 'Polisha <noreply@example.com>';

const FULL = {
  volume: 'v2', channels: ['email', 'phone', 'chat', 'form'], manual: 'all', minutes: 'm30',
  duplication: 'many', tracking: 'memory', chasing: 'three',
  reminders: ['appointments', 'payment', 'status'], misses: 'daily',
  admin: 'a10plus', human: ['quoting', 'complaints'], priority: 'intake',
};
const TINY = {
  volume: 'v0', channels: ['email'], manual: 'none', minutes: 'm5',
  duplication: 'never', tracking: 'system', chasing: 'none', reminders: [],
  misses: 'never', admin: 'a2', human: ['quoting'], priority: 'reporting',
};

// ------------------------------------------------------------- scoring ---
{
  check('there are twelve questions', score.QUESTIONS.length === 12,
    String(score.QUESTIONS.length));
  check('every question has at least two options',
    score.QUESTIONS.every(q => q.options.length >= 2));
  check('every question id is unique',
    new Set(score.QUESTIONS.map(q => q.id)).size === score.QUESTIONS.length);

  const r = score.score(FULL);
  check('a heavy workload produces hours', r.hours > 0, String(r.hours));
  check('the parts add up to the raw figure',
    Math.abs(r.parts.reduce((t, p) => t + p.hours, 0) - r.rawHours) < 0.6,
    r.parts.map(p => p.hours).join('+') + ' vs ' + r.rawHours);

  /* ⚠️  THE CAP. Removing it would make every headline number bigger and
     every one of them undefendable. */
  check('the cap fires when the arithmetic exceeds the stated admin time',
    r.cappedByOwnEstimate === true && r.hours === r.capHours && r.rawHours > r.capHours,
    'raw ' + r.rawHours + ' cap ' + r.capHours + ' shown ' + r.hours);
  check('the capped result never exceeds what they said they spend',
    r.hours <= r.capHours, r.hours + ' > ' + r.capHours);

  const uncapped = score.score({ ...FULL, admin: 'a10plus', volume: 'v0', minutes: 'm5', manual: 'some', duplication: 'few', chasing: 'under1', reminders: ['payment'] });
  check('the cap does not fire when the arithmetic fits inside it',
    uncapped.cappedByOwnEstimate === false, JSON.stringify({ raw: uncapped.rawHours, cap: uncapped.capHours }));
}
{
  /* ⚠️  "NOT YET" MUST SURVIVE. The site promises we will say when nothing
     is worth building. If this verdict is ever tuned away, that promise
     becomes decoration. */
  const r = score.score(TINY);
  check('a tiny workload is told not to build yet',
    r.verdict.key === 'notYet', r.verdict.key + ' at ' + r.hours + 'h');
  check('the not-yet verdict offers no sales call',
    r.verdict.cta === 'none', r.verdict.cta);
  check('it says so in plain words',
    /would not build you a system yet/i.test(r.verdict.headline), r.verdict.headline);
}
{
  const empty = score.score({});
  check('no answers is zero hours, not NaN',
    empty.hours === 0 && Number.isFinite(empty.hours), String(empty.hours));
  check('no answers still returns a verdict', !!empty.verdict.key);
  check('no answers offers no opportunities', empty.opportunities.length === 0);
  check('garbage answers are ignored rather than counted',
    score.score({ volume: 'nonsense', minutes: {}, reminders: 'not-an-array' }).hours === 0);
}
{
  const r = score.score(FULL);
  check('opportunities are ranked by cost', 
    r.opportunities.every((o, i) => i === 0 || r.opportunities[i - 1].hours >= o.hours),
    r.opportunities.map(o => o.hours).join(' '));
  check('at most three opportunities are offered', r.opportunities.length <= 3);
  check('a zero-hour component is never offered as an opportunity',
    r.opportunities.every(o => o.hours > 0));
  check('what stays human is echoed back from their own answer',
    r.human.length === 2 && /Quoting/i.test(r.human[0]), r.human.join(' | '));
}

// ----------------------------------------------------------------- API ---
function mkRes() {
  const res = { code: 0, body: null, headers: {} };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
async function post(body, ip = '1.1.1.1', opts = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
    if (String(url).endsWith('/emails')) {
      if (opts.failVisitor && calls.length === 1) return { ok: false, status: 422, text: async () => 'bad' };
      return { ok: true, status: 200, json: async () => ({ id: 'e1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  const res = mkRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {}, body }, res);
  return { res, calls };
}

const WHO = { name: 'Test Person', email: 'p@example.com' };

{
  const { res } = await post({ ...WHO, answers: FULL, hours: 16 }, '2.1.1.1');
  check('a complete submission is accepted', res.code === 200 && res.body.ok === true,
    res.code + ' ' + JSON.stringify(res.body));
}
{
  const { calls } = await post({ ...WHO, answers: FULL, hours: 16 }, '2.2.2.2');
  const emails = calls.filter(c => c.url.endsWith('/emails'));
  check('two emails are sent: the visitor copy and our lead', emails.length === 2,
    String(emails.length));
  check('the visitor gets their own copy first',
    emails[0].body.to[0] === 'p@example.com', JSON.stringify(emails[0].body.to));
  check('the visitor copy carries the hours figure',
    /hours a week/i.test(emails[0].body.subject), emails[0].body.subject);
  check('the visitor copy shows the working',
    /WHERE THAT COMES FROM/.test(emails[0].body.text));
  check('our lead is scored in its subject',
    /worthBuilding/.test(emails[1].body.subject), emails[1].body.subject);
}
{
  /* The whole point of re-scoring. A posted figure is a claim, not a fact. */
  const { calls } = await post({ ...WHO, answers: TINY, hours: 97 }, '2.3.3.3');
  const lead = calls.filter(c => c.url.endsWith('/emails'))[1];
  check('a client-supplied figure never becomes the lead figure',
    /Hours:   0/.test(lead.body.text), lead.body.text.slice(0, 200));
  check('a mismatch between claimed and recomputed is flagged',
    /Client reported 97h/.test(lead.body.text), lead.body.text.slice(0, 300));
}
{
  const { res, calls } = await post(
    { ...WHO, answers: { volume: 'v2; DROP TABLE', reminders: ['payment', 'evil'] } }, '2.4.4.4');
  const lead = calls.filter(c => c.url.endsWith('/emails'))[1];
  check('an unlisted answer is dropped, not echoed', res.code === 200 && !/DROP TABLE/.test(lead.body.text));
  check('a valid answer beside an invalid one survives',
    /"reminders":\["payment"\]/.test(lead.body.text), lead.body.text.slice(-200));
}
{
  const { res, calls } = await post({ ...WHO, website: 'bot', answers: FULL }, '2.5.5.5');
  check('the honeypot catches a bot silently',
    res.code === 200 && res.body.ok === true && calls.length === 0, 'calls=' + calls.length);
}
{
  const { res } = await post({ email: 'p@example.com', answers: FULL }, '2.6.6.6');
  check('a missing name is a validation error', res.code === 400 && !!res.body.errors.name);
}
{
  const { res } = await post({ ...WHO, email: 'nope', answers: FULL }, '2.7.7.7');
  check('a bad email is a validation error', res.code === 400 && !!res.body.errors.email);
}
{
  const { calls } = await post({ ...WHO, answers: FULL, subscribe: true }, '2.8.8.8');
  check('ticking the box reaches the segment lookup',
    calls.some(c => /\/segments/.test(c.url)), calls.map(c => c.url).join(' '));
}
{
  const { calls } = await post({ ...WHO, answers: FULL }, '2.9.9.9');
  check('an unticked box never touches the list',
    !calls.some(c => /\/segments|\/contacts/.test(c.url)), calls.map(c => c.url).join(' '));
}
{
  /* If the visitor's copy fails, the form promised something it did not
     deliver, so it must not report success. */
  const { res } = await post({ ...WHO, answers: FULL }, '3.1.1.1', { failVisitor: true });
  check('a failed visitor copy is reported as a failure, not a success',
    res.code === 502 && res.body.ok === false, res.code + ' ' + JSON.stringify(res.body));
}
{
  /* Those two letters appear nowhere, including in the copy we email out. */
  const { calls } = await post({ ...WHO, answers: FULL }, '5.1.1.1');
  const sent = calls.filter(c => c.url.endsWith('/emails'));
  check('the emailed result never names artificial intelligence',
    sent.every(c => !/\bAI\b/.test(c.body.text)),
    (sent.map(c => c.body.text).join(' ').match(/.{30}\bAI\b.{30}/) || [''])[0]);
}
{
  const res = mkRes();
  await handler({ method: 'GET', headers: {}, socket: {} }, res);
  check('a GET is refused with 405 and an Allow header',
    res.code === 405 && res.headers.Allow === 'POST', res.code);
}
{
  let last;
  for (let i = 0; i < 5; i++) last = await post({ ...WHO, answers: FULL }, '4.4.4.4');
  check('repeated submissions from one address are rate limited',
    last.res.code === 429, String(last.res.code));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
