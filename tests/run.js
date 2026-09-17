/* ==========================================================================
   Test suite for tobi.getpolisha.com

   Runs the real built site from a local static server, in a real browser, at
   every width the design claims to support. No mocks except the contact
   endpoint -- a production enquiry is never sent from a test.

     cd tests && node run.js            # against ../ on a local server
     SITE=https://...  node run.js      # against a deployed URL
   ========================================================================== */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WIDTHS = [[1440, 900, 'desktop'], [1024, 800, 'tablet landscape'], [768, 1024, 'tablet'],
                [430, 932, 'large iPhone'], [390, 844, 'iPhone'], [360, 780, 'small mobile']];

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? '  -> ' + detail : '')); }
}

function serve() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, () => resolve(s));
  });
}

(async () => {
  const server = process.env.SITE ? null : await serve();
  const BASE = process.env.SITE || `http://127.0.0.1:${server.address().port}/`;
  console.log('testing ' + BASE + '\n');

  const browser = await chromium.launch();
  const mockContact = async page => {
    // The production endpoint is never called from a test.
    await page.route('**/api/contact', r => r.fulfill({
      status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  };

  // ---------------------------------------------------------------- widths
  for (const [w, h, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    // /_vercel/insights/script.js is injected by Vercel and legitimately
    // absent from a local static server. Every other error still counts.
    const ignorable = t => /_vercel\/insights/.test(t)
      || (/404/.test(t) && !process.env.SITE);
    page.on('console', m => { if (m.type() === 'error' && !ignorable(m.text())) errs.push(m.text()); });
    page.on('response', r => {
      if (r.status() >= 400 && !/_vercel\/insights/.test(r.url())) errs.push(r.status() + ' ' + r.url());
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      h1s: document.querySelectorAll('h1').length,
      headingOrder: (() => {
        const ls = [...document.querySelectorAll('h1,h2,h3')].map(e => +e.tagName[1]);
        for (let i = 1; i < ls.length; i++) if (ls[i] - ls[i - 1] > 1) return false;
        return true;
      })(),
      hidden: [...document.querySelectorAll('body *')].filter(e => getComputedStyle(e).opacity === '0'
               && e.getBoundingClientRect().height > 60).length,
      skipLink: !!document.querySelector('.skip-link[href="#main"]'),
      landmarks: !!document.querySelector('nav[aria-label]') && !!document.querySelector('main#main'),
      altMissing: [...document.querySelectorAll('img')].filter(i => i.getAttribute('alt') === null).length,
      labelled: [...document.querySelectorAll('#contact-form input:not([tabindex="-1"]), #contact-form textarea')]
                  .every(i => !!document.querySelector('label[for="' + i.id + '"]')),
      navVisible: getComputedStyle(document.querySelector('.nav-cta')).display !== 'none',
      brokenImg: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).length,
    }));

    check(`[${label} ${w}px] no horizontal overflow`, !r.overflow);
    check(`[${label} ${w}px] exactly one h1`, r.h1s === 1, 'found ' + r.h1s);
    check(`[${label} ${w}px] heading levels never skip`, r.headingOrder);
    check(`[${label} ${w}px] nothing hidden at opacity 0`, r.hidden === 0, r.hidden + ' blocks');
    check(`[${label} ${w}px] skip link present`, r.skipLink);
    check(`[${label} ${w}px] nav and main landmarks`, r.landmarks);
    check(`[${label} ${w}px] every image has alt`, r.altMissing === 0);
    check(`[${label} ${w}px] every form field labelled`, r.labelled);
    check(`[${label} ${w}px] primary call to action reachable`, r.navVisible);
    check(`[${label} ${w}px] no broken images`, r.brokenImg === 0);
    check(`[${label} ${w}px] no console or page errors`, errs.length === 0, errs[0]);
    await ctx.close();
  }

  // ------------------------------------------------------------ navigation
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    for (const href of ['#work', '#products', '#services', '#pricing', '#contact']) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const want = await page.evaluate(h => {
        const el = document.getElementById(h.slice(1));
        return el ? Math.round(el.getBoundingClientRect().top + window.pageYOffset) : null;
      }, href);
      check('nav target exists ' + href, want !== null);
      if (want === null) continue;
      await page.click(`.nav-links a[href="${href}"], .footer-links a[href="${href}"]`).catch(() => {});
      await page.waitForTimeout(1100);
      const got = Math.round(await page.evaluate(() => window.pageYOffset));
      check('nav scrolls to ' + href, Math.abs(got - want) < 90, 'wanted ' + want + ' got ' + got);
    }
    // the fallback must rescue a swallowed smooth scroll
    await page.evaluate(() => {
      const real = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (o) { if (o && o.behavior === 'smooth') return; return real.call(this, o); };
      window.scrollTo(0, 0);
    });
    const want = await page.evaluate(() => Math.round(document.getElementById('pricing').getBoundingClientRect().top + window.pageYOffset));
    await page.click('.nav-links a[href="#pricing"]');
    await page.waitForTimeout(1200);
    const got = Math.round(await page.evaluate(() => window.pageYOffset));
    check('nav still works when smooth scrolling is swallowed', Math.abs(got - want) < 90, 'wanted ' + want + ' got ' + got);
    await ctx.close();
  }

  // --------------------------------------------------------- project links
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const links = await page.evaluate(() => [...document.querySelectorAll('.pcard a.button')].map(a => ({
      href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() })));
    check('two product links present', links.length === 2, 'found ' + links.length);
    check('Verdict link points at the live product', links.some(l => l.href === 'https://verdict.getpolisha.com/'), JSON.stringify(links.map(l => l.href)));
    check('GetPolisha link points at the live product', links.some(l => l.href === 'https://getpolisha.com/'));
    check('product links open in a new tab safely', links.every(l => l.target === '_blank' && /noopener/.test(l.rel)));
    await ctx.close();
  }

  // ----------------------------------------------------------- gallery tabs
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const ids = ['tab-capacity', 'tab-approvals', 'tab-quality', 'tab-overview'];
    for (const id of ids) {
      await page.click('#' + id);
      await page.waitForTimeout(250);
      const st = await page.evaluate(i => {
        const tab = document.getElementById(i);
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        const img = panel.querySelector('img');
        return {
          selected: tab.getAttribute('aria-selected') === 'true',
          onlyOneSelected: document.querySelectorAll('[role="tab"][aria-selected="true"]').length === 1,
          panelShown: !panel.hidden,
          onlyOnePanel: [...document.querySelectorAll('.shot')].filter(s => !s.hidden).length === 1,
          captionMatches: document.getElementById('gallery-caption').textContent.trim()
                            .toLowerCase().startsWith(tab.textContent.trim().toLowerCase()),
          roving: tab.tabIndex === 0,
          imgEager: img.loading !== 'lazy',
          imgLoaded: img.complete && img.naturalWidth > 0,
        };
      }, id);
      check('tab ' + id + ' selects', st.selected && st.onlyOneSelected);
      check('tab ' + id + ' shows exactly its own panel', st.panelShown && st.onlyOnePanel);
      check('tab ' + id + ' updates the caption', st.captionMatches);
      check('tab ' + id + ' takes the roving tabindex', st.roving);
      check('tab ' + id + ' image is not lazy once selected', st.imgEager);
      check('tab ' + id + ' image actually loaded', st.imgLoaded);
    }
    // keyboard
    await page.focus('#tab-capacity');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    check('arrow key moves the gallery selection',
      await page.evaluate(() => document.activeElement.id === 'tab-approvals'
        && document.getElementById('tab-approvals').getAttribute('aria-selected') === 'true'));
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    check('End key jumps to the last screen',
      await page.evaluate(() => document.activeElement.id === 'tab-overview'));
    await ctx.close();
  }

  // ------------------------------------------------------ contact: validation
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await mockContact(page);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#cf-submit');
    await page.waitForTimeout(350);
    const v = await page.evaluate(() => ({
      errors: [...document.querySelectorAll('.field-error:not([hidden])')].length,
      messages: [...document.querySelectorAll('.field-error:not([hidden])')].map(e => e.textContent),
      invalid: [...document.querySelectorAll('[aria-invalid="true"]')].map(e => e.id),
      focused: document.activeElement.id,
      described: [...document.querySelectorAll('#contact-form input:not([tabindex="-1"]), #contact-form textarea')]
                   .every(i => !!i.getAttribute('aria-describedby')),
      live: !!document.querySelector('#cf-status[aria-live]'),
    }));
    check('empty submit raises an error per field', v.errors === 3, 'got ' + v.errors);
    check('error messages are plain language', v.messages.every(m => /please|would help|does not look/i.test(m)), JSON.stringify(v.messages));
    check('invalid fields marked with aria-invalid', v.invalid.length === 3);
    check('focus moves to the first invalid field', v.focused === 'cf-name', 'focus on ' + v.focused);
    check('errors are tied to their field for screen readers', v.described);
    check('status region announces politely', v.live);

    await page.fill('#cf-email', 'not-an-email');
    await page.fill('#cf-name', 'Test');
    await page.fill('#cf-message', 'short');
    await page.click('#cf-submit');
    await page.waitForTimeout(300);
    check('bad email is caught', await page.evaluate(() => !document.getElementById('cf-email-error').hidden));
    check('too-short message is caught', await page.evaluate(() => !document.getElementById('cf-message-error').hidden));
    await page.fill('#cf-email', 'someone@example.com');
    await page.waitForTimeout(250);
    check('typing clears the error', await page.evaluate(() => document.getElementById('cf-email-error').hidden));
    await ctx.close();
  }

  // -------------------------------------------------- contact: success/fail
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await mockContact(page);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.fill('#cf-name', 'Test Person');
    await page.fill('#cf-email', 'someone@example.com');
    await page.fill('#cf-message', 'Our approvals live in WhatsApp and we keep losing them.');
    await page.click('#cf-submit');
    await page.waitForTimeout(700);
    const ok = await page.evaluate(() => ({
      status: document.getElementById('cf-status').textContent,
      cls: document.getElementById('cf-status').className,
      cleared: !document.getElementById('cf-message').value,
      reenabled: !document.getElementById('cf-submit').disabled,
    }));
    check('success shows a clear confirmation', /thank you/i.test(ok.status) && /ok/.test(ok.cls), ok.status);
    check('success clears the form', ok.cleared);
    check('button is usable again after success', ok.reenabled);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.route('**/api/contact', r => r.fulfill({ status: 503, contentType: 'application/json',
      body: '{"ok":false,"error":"The form is not available right now. Please email tobaina@gmail.com directly."}' }));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const typed = 'This message must survive a failure.';
    await page.fill('#cf-name', 'Test'); await page.fill('#cf-email', 'a@b.co'); await page.fill('#cf-message', typed);
    await page.click('#cf-submit');
    await page.waitForTimeout(700);
    const bad = await page.evaluate(t => ({
      status: document.getElementById('cf-status').textContent,
      cls: document.getElementById('cf-status').className,
      kept: document.getElementById('cf-message').value === t,
    }), typed);
    check('failure names the fallback email address', /tobaina@gmail\.com/.test(bad.status), bad.status);
    check('failure is styled as an error', /bad/.test(bad.cls));
    check('failure never loses what the visitor typed', bad.kept);

    await page.unroute('**/api/contact');
    await page.route('**/api/contact', r => r.abort());
    await page.click('#cf-submit');
    await page.waitForTimeout(700);
    check('dropped connection still tells the visitor what to do',
      await page.evaluate(() => /tobaina@gmail\.com/.test(document.getElementById('cf-status').textContent)));
    await ctx.close();
  }

  // ------------------------------------------------------- spam protection
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const trap = await page.evaluate(() => {
      const el = document.getElementById('cf-company');
      const r = el.getBoundingClientRect();
      return { exists: !!el, offscreen: r.right < 0 || r.bottom < 0, notTabbable: el.tabIndex === -1,
               hiddenFromAT: !!el.closest('[aria-hidden="true"]') };
    });
    check('honeypot field exists', trap.exists);
    check('honeypot is off-screen', trap.offscreen);
    check('honeypot is out of the tab order', trap.notTabbable);
    check('honeypot hidden from assistive tech', trap.hiddenFromAT);
    await ctx.close();
  }

  // ------------------------------------------------ reduced motion + focus
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const want = await page.evaluate(() => Math.round(document.getElementById('pricing').getBoundingClientRect().top + window.pageYOffset));
    await page.click('.nav-links a[href="#pricing"]');
    await page.waitForTimeout(900);
    check('reduced motion still navigates',
      Math.abs(Math.round(await page.evaluate(() => window.pageYOffset)) - want) < 90);
    check('nothing hidden under reduced motion',
      await page.evaluate(() => [...document.querySelectorAll('body *')]
        .filter(e => getComputedStyle(e).opacity === '0' && e.getBoundingClientRect().height > 60).length === 0));
    // Fresh load: focus must start at the top of the document, not wherever a
    // previous interaction left it.
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    await page.keyboard.press('Tab');
    check('first tab stop is the skip link',
      await page.evaluate(() => document.activeElement.classList.contains('skip-link')),
      await page.evaluate(() => document.activeElement.className || document.activeElement.tagName));
    check('focus is visibly styled',
      await page.evaluate(() => {
        const el = document.querySelector('.nav-cta'); el.focus();
        const o = getComputedStyle(el).outlineStyle;
        return o !== 'none';
      }));
    await ctx.close();
  }

  // ----------------------------------------------------- structured data
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const ld = await page.evaluate(() => {
      const el = document.querySelector('script[type="application/ld+json"]');
      try { return JSON.parse(el.textContent); } catch (e) { return null; }
    });
    check('structured data parses', !!ld);
    const types = ld ? (ld['@graph'] || []).map(n => n['@type']) : [];
    check('describes a Person', types.includes('Person'));
    check('describes a ProfessionalService', types.includes('ProfessionalService'));
    check('describes a WebSite', types.includes('WebSite'));
    const blob = JSON.stringify(ld || {});
    check('structured data uses the right email', blob.includes('tobaina@gmail.com'));
    check('structured data claims no outcomes', !/revenue|customers|testimonial|award/i.test(blob));

    const meta = await page.evaluate(() => ({
      canonical: (document.querySelector('link[rel=canonical]') || {}).href,
      ogImage: (document.querySelector('meta[property="og:image"]') || {}).content,
      twitterCard: (document.querySelector('meta[name="twitter:card"]') || {}).content,
      title: document.title,
    }));
    check('canonical preserved', meta.canonical === 'https://tobi.getpolisha.com/');
    check('og image preserved', /og-image-2\.jpg$/.test(meta.ogImage || ''));
    check('twitter card preserved', meta.twitterCard === 'summary_large_image');
    check('title preserved', /Tobi Aina/.test(meta.title));
    await ctx.close();
  }

  await browser.close();
  if (server) server.close();

  console.log(failures.length ? 'FAILURES:\n  ' + failures.join('\n  ') + '\n' : '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
