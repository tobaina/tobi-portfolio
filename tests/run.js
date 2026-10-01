/* ==========================================================================
   Test suite for Polisha Systems (systems.getpolisha.com)

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
  const url = p => BASE.replace(/\/$/, '') + p;   // BASE ends in "/"
  const DEPLOYED = Boolean(process.env.SITE);      // local server has no vercel.json rewrites

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
      /* ⚠️  DO NOT PUT A FIXED SLEEP BACK HERE.
         This was waitForTimeout(250), which is ample against the local static
         server and not ample against a CDN on a cold cache. Two live runs
         failed "image actually loaded" on different tabs each time while
         every one of those files returned 200 to a direct request, which is
         the signature of a timing bug in the test rather than a broken image.
         A flaky assertion is worse than no assertion: it teaches you to ignore
         a red run. Wait for the real condition, bounded, and let the check
         below still fail on an image that genuinely never arrives. */
      await page.waitForFunction(i => {
        const t = document.getElementById(i);
        const p = document.getElementById(t.getAttribute('aria-controls'));
        const m = p.querySelector('img');
        return !p.hidden && m.complete && m.naturalWidth > 0;
      }, id, { timeout: 15000 }).catch(() => {});
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
      body: '{"ok":false,"error":"The form is not available right now. Please reach us through the LinkedIn link on this page."}' }));
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
    /* ⚠️  NO ADDRESS, ON PURPOSE. This used to require the personal inbox
       in the failure message, which republished it to every visitor who hit a
       broken form. The page shows no address at all now, so the requirement
       is that a failure still routes the visitor somewhere real. */
    check('failure still routes the visitor somewhere real',
      /linkedin/i.test(bad.status) && !/@/.test(bad.status), bad.status);
    check('failure is styled as an error', /bad/.test(bad.cls));
    check('failure never loses what the visitor typed', bad.kept);

    await page.unroute('**/api/contact');
    await page.route('**/api/contact', r => r.abort());
    await page.click('#cf-submit');
    await page.waitForTimeout(700);
    check('dropped connection still tells the visitor what to do',
      await page.evaluate(() => {
        const t = document.getElementById('cf-status').textContent;
        return t.trim().length > 0 && !/@/.test(t);
      }));
    await ctx.close();
  }

  // ------------------------------------------------------- spam protection
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const trap = await page.evaluate(() => {
      const el = document.getElementById('cf-website');
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

  // --------------------------------------------------- marketing consent
  {
    // Sending an enquiry is not consent to be marketed to. These assertions
    // exist so that can never quietly stop being true: a pre-ticked box, a
    // required box, or consent bundled into the send button would each be an
    // unlawful opt-in, and each is a one-character edit away at all times.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await mockContact(page);
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const box = await page.evaluate(() => {
      const el = document.getElementById('cf-subscribe');
      if (!el) return null;
      const label = document.querySelector('label[for="cf-subscribe"]');
      const note = document.getElementById('cf-subscribe-note');
      const wrap = el.closest('.consent');
      return {
        type: el.type,
        checked: el.checked,
        defaultChecked: el.defaultChecked,
        required: el.required,
        name: el.name,
        labelled: !!(label && label.textContent.trim().length > 10),
        described: el.getAttribute('aria-describedby') === 'cf-subscribe-note' && !!note,
        mentionsUnsubscribe: !!(note && /unsubscribe/i.test(note.textContent)),
        saysOptional: !!(note && /leave this unticked|only reply/i.test(note.textContent)),
        separateFromSubmit: !!(wrap && !wrap.querySelector('button')),
      };
    });

    check('marketing consent box exists', !!box);
    check('marketing consent is a checkbox', box && box.type === 'checkbox');
    check('marketing consent starts unticked', box && box.checked === false);
    check('marketing consent is never pre-ticked in the markup', box && box.defaultChecked === false);
    check('marketing consent is not required', box && box.required === false);
    check('marketing consent has its own label', box && box.labelled);
    check('marketing consent explanation is tied to the box', box && box.described);
    check('marketing consent promises an unsubscribe', box && box.mentionsUnsubscribe);
    check('marketing consent says what happens if you leave it', box && box.saysOptional);
    check('marketing consent is separate from the send button', box && box.separateFromSubmit);

    // The source of truth for the markup, not just the rendered state: a
    // `checked` attribute in index.html would pass a live .checked test only
    // until someone reset the form.
    const markup = await page.evaluate(() =>
      (document.getElementById('cf-subscribe') || {}).outerHTML || '');
    check('no checked attribute in the consent markup', !/\bchecked\b/i.test(markup), markup);

    // Untouched box -> subscribe:false on the wire.
    let sentBody = null;
    await page.route('**/api/contact', route => {
      sentBody = route.request().postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.fill('#cf-name', 'Test Person');
    await page.fill('#cf-email', 'test@example.com');
    await page.fill('#cf-message', 'Something in my operation is breaking every week.');
    await page.click('#cf-submit');
    await page.waitForTimeout(600);
    check('an untouched box sends subscribe:false',
      !!sentBody && JSON.parse(sentBody).subscribe === false, sentBody || 'no request');

    // Ticked box -> subscribe:true, and the message still sends.
    sentBody = null;
    await page.fill('#cf-name', 'Test Person');
    await page.fill('#cf-email', 'test@example.com');
    await page.fill('#cf-message', 'Something in my operation is breaking every week.');
    await page.check('#cf-subscribe');
    await page.click('#cf-submit');
    await page.waitForTimeout(600);
    check('a ticked box sends subscribe:true',
      !!sentBody && JSON.parse(sentBody).subscribe === true, sentBody || 'no request');
    check('the message still sends when subscribing',
      !!sentBody && JSON.parse(sentBody).message.length > 10);

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

  // -------------------------------------------- price, hiring, walkthrough
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const r = await page.evaluate(() => {
      const w = document.getElementById('walkthrough');
      const video = document.getElementById('walkthrough-video');
      const hiring = document.getElementById('hiring');
      const price = document.querySelector('.hero-price');
      const heroBottom = (document.querySelector('.hero-text') || {}).getBoundingClientRect
        ? document.querySelector('.hero-text').getBoundingClientRect().bottom : 0;
      return {
        // The walkthrough must be invisible AND inert until a file is named.
        walkthroughPresent: !!w,
        walkthroughHidden: !!w && w.hidden,
        walkthroughDeclaresNoFile: !!w && !(w.getAttribute('data-video') || '').trim(),
        walkthroughHasNoSource: !!video && video.querySelectorAll('source').length === 0,
        walkthroughHasNoPoster: !!video && !video.getAttribute('poster'),
        // The second audience is addressed, and can act on it.
        hiringPresent: !!hiring,
        mailtos: [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.getAttribute('href')),
        // A price is visible without scrolling past the hero.
        priceInHero: !!price && price.getBoundingClientRect().top < heroBottom + 1,
        priceText: price ? price.textContent : '',
      };
    });

    check('walkthrough section exists', r.walkthroughPresent);
    check('walkthrough stays hidden while no file is named', r.walkthroughHidden && r.walkthroughDeclaresNoFile);
    check('hidden walkthrough loads no media', r.walkthroughHasNoSource && r.walkthroughHasNoPoster);
    /* The hiring section was removed when this became a company site: it
       answered "are you available to hire", which is the wrong question on a
       page selling builds, and it was the last thing speaking in one person's
       voice. Asserted absent so it cannot drift back. */
    check('the hiring section is gone', !r.hiringPresent);
    check('no mailto anywhere on the page',
      r.mailtos.length === 0, r.mailtos.join(' | '));
    check('a price is shown in the hero', r.priceInHero);
    check('the hero price names a real currency amount', /CA\$\s?\d/.test(r.priceText), r.priceText.slice(0, 80));
    await ctx.close();
  }

  // --------------------------------------------- two routes through the page
  /* The page has one job that the old copy quietly failed: a visitor who wants
     a website has to be able to recognise themselves. These assertions are the
     ones that break if someone later edits the page back into an
     operations-only pitch without meaning to. */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const r = await page.evaluate(() => {
      const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
      const priceRows = [...document.querySelectorAll('.price-row')].map(row => ({
        title: text(row.querySelector('h3')),
        amount: text(row.querySelector('strong')),
        detail: text(row.querySelector('p')),
      }));
      const priceGroups = [...document.querySelectorAll('.price-group-head')].map(h => text(h));
      return {
        notice: text(document.querySelector('.notice')),
        noticeLinksToContact: !!document.querySelector('.notice a[href="#contact"]'),
        navLabels: [...document.querySelectorAll('.nav-links a')].map(a => text(a)),
        heroCopy: text(document.querySelector('.hero-copy')),
        heroServices: text(document.querySelector('.hero-services')),
        actions: [...document.querySelectorAll('.actions .button')]
          .map(a => ({ label: text(a), href: a.getAttribute('href') })),
        caseMoreHref: (document.querySelector('.case-more a') || {}).getAttribute
          ? document.querySelector('.case-more a').getAttribute('href') : null,
        caseDepthLabel: text(document.querySelector('.case-depth span')),
        provesCount: document.querySelectorAll('.pcard-proves').length,
        productCount: document.querySelectorAll('.pcard').length,
        getpolishaCard: text([...document.querySelectorAll('.pcard')]
          .find(c => /GetPolisha/.test(text(c.querySelector('h3')))) || null),
        minorServices: [...document.querySelectorAll('.service-minor h4')].map(h => text(h)),
        priceRows,
        priceGroups,
        heroPrice: text(document.querySelector('.hero-price')),
        priceNotes: [...document.querySelectorAll('.price-note')].map(n => text(n)).join(' '),
        founding: text(document.querySelector('.founding')),
        bodyText: document.body.innerText.replace(/\s+/g, ' '),
      };
    });

    // The announcement must invite both kinds of work and must not date itself.
    check('announcement invites a project', /taking on new projects/i.test(r.notice), r.notice);
    check('announcement carries no expiring date',
      !/this quarter|this month|this year/i.test(r.notice), r.notice);
    check('announcement links to the contact form', r.noticeLinksToContact);

    check('navigation says Services', r.navLabels.includes('Services'), r.navLabels.join(' | '));

    // The hero must speak to a website buyer as well as an operations buyer.
    check('hero copy offers website work', /website|online presence/i.test(r.heroCopy), r.heroCopy.slice(0, 120));
    check('hero names the service routes',
      /Websites/i.test(r.heroServices) && /Automation/i.test(r.heroServices), r.heroServices);
    check('hero offers a contact and a work route',
      r.actions.some(a => a.href === '#contact') && r.actions.some(a => a.href === '#work'),
      JSON.stringify(r.actions));

    // Engineering depth is kept, but it is no longer the first thing said.
    check('implementation figures are labelled as depth, not as the result',
      /behind the system/i.test(r.caseDepthLabel), r.caseDepthLabel);
    check('the case study offers a route to smaller work', r.caseMoreHref === '#services');

    // Each live product says what it proves.
    check('every product card says what it proves',
      r.productCount > 0 && r.provesCount === r.productCount,
      r.provesCount + ' of ' + r.productCount);

    /* ⚠️  ACCURACY, NOT COPY. getpolisha.com tells its own customers that a
       person completes every rewrite. The portfolio must not imply the
       rewriting is automated, whatever else it claims about the workflow. */
    check('the GetPolisha card does not claim an automated rewrite',
      !/automated (profile )?(rewrit|writing)/i.test(r.getpolishaCard), r.getpolishaCard.slice(0, 200));
    check('the GetPolisha card says a person does the rewriting',
      /by a person/i.test(r.getpolishaCard), r.getpolishaCard.slice(0, 200));

    // The wider offer exists, and stays secondary.
    check('secondary services are listed', r.minorServices.length === 4, r.minorServices.join(' | '));
    check('secondary services include website work',
      r.minorServices.some(t => /website/i.test(t)), r.minorServices.join(' | '));

    /* ── PRICING ──────────────────────────────────────────────────────────
       Three groups, and small website work carries a real number. A quote
       cycle costs the same on a CA$1,800 job as on a CA$18,000 one, so on
       small work "contact me for a quote" is a tax on both sides. These
       assertions exist because the most likely future regression is somebody
       quietly replacing a number with "get in touch". */
    /* ⚠️  THE HERO AND THE TABLE MUST AGREE, AND THIS IS CHECKED BY DERIVATION.
       This assertion used to hardcode one figure, so it passed while the hero
       and the table drifted apart around it, and then failed on the honest
       edit that moved the price. Every CA$ figure the hero names must appear
       in the table below. Nothing to update when a price changes; it only
       fails when the two genuinely disagree, which is the bug that once had
       this page quoting three different build prices at the same time. */
    /* ⚠️  TRIM TRAILING PUNCTUATION. `CA\$[\d,]+` is greedy over commas, so
       "from CA$4,800, always quoted" yielded "CA$4,800," and matched nothing
       in the table. The check then failed on a page whose prices agreed
       perfectly, which is the kind of false alarm that gets a suite ignored. */
    const heroFigures = (r.heroPrice.match(/CA\$[\d,]+/g) || []).map(f => f.replace(/,+$/, ''));
    const tableAmounts = r.priceRows.map(x => x.amount).join(' ');
    check('the hero names at least one price', heroFigures.length > 0, r.heroPrice.slice(0, 80));
    const orphaned = heroFigures.filter(f => !tableAmounts.includes(f));
    check('every price the hero names also appears in the table',
      orphaned.length === 0,
      'hero has ' + orphaned.join(', ') + ' | table has ' + tableAmounts);

    check('pricing is grouped rather than one ladder', r.priceGroups.length === 3,
      r.priceGroups.join(' | '));
    check('a website group exists', r.priceGroups.some(g => /website/i.test(g)),
      r.priceGroups.join(' | '));
    /* ⚠️  THE GROUP HEADING MUST MATCH THE ROWS UNDER IT AND THE HERO.
           This group was headed "Operations systems" while the row inside it
           and the hero sentence both said "Business systems", so a reader
           comparing the hero price to the table was matching two different
           words for one thing. The heading follows the rows now. */
    check('a business systems group exists', r.priceGroups.some(g => /business systems/i.test(g)),
      r.priceGroups.join(' | '));
    check('an after-launch group exists', r.priceGroups.some(g => /after launch/i.test(g)),
      r.priceGroups.join(' | '));

    const priced = (t) => r.priceRows.find(x => new RegExp(t, 'i').test(x.title));
    const landing = priced('landing page');
    const site = priced('business site');
    const custom = priced('custom functionality');
    const diagnostic = priced('diagnostic');
    const build = priced('business systems');
    const full = priced('larger systems');
    const care = priced('care plan');
    const change = priced('change work');

    /* One row deliberately carries no figure: the largest engagement is
       quoted after a check or a diagnostic, because publishing a ceiling was
       sending small owners away before they reached the free process check.
       Every OTHER row must still name a number, or "quoted" spreads. */
    const unpriced = r.priceRows.filter(x => !/CA\$\s?\d/.test(x.amount));
    check('every priced row but one names an amount',
      r.priceRows.length >= 8 && unpriced.length === 1,
      r.priceRows.map(x => x.title + '=' + x.amount).join(' | '));
    check('the unpriced row is the largest engagement',
      unpriced.length === 1 && /larger systems/i.test(unpriced[0].title),
      unpriced.map(x => x.title).join(' | '));

    // Small website work must stay a stated number, never a quote cycle.
    /* Anchored to the Canadian freelance band (roughly CA$599-2,995 one-time
       for a small-business site), not to agency pricing. These exact figures
       are pinned so a later edit has to be deliberate. */
    check('a landing page carries a fixed price',
      !!landing && /^CA\$1,200$/.test(landing.amount), landing ? landing.amount : 'missing');
    check('a business site carries a fixed price',
      !!site && /^CA\$2,900$/.test(site.amount), site ? site.amount : 'missing');
    check('custom functionality is a floor, not a fixed price',
      !!custom && /^from CA\$5,500$/.test(custom.amount), custom ? custom.amount : 'missing');
    check('no website row hides behind a quote cycle',
      ![landing, site, custom].some(x => x && /quote|scope|contact|enquir/i.test(x.amount)));

    check('the diagnostic is CA$400', !!diagnostic && /^CA\$400$/.test(diagnostic.amount),
      diagnostic ? diagnostic.amount : 'missing');
    // The diagnostic must read as credit, not as a toll gate.
    check('the diagnostic is credited against the build',
      !!diagnostic && /credited in full/i.test(diagnostic.detail), diagnostic ? diagnostic.detail : '');
    /* A reachable first phase AND a ceiling, rather than one wide range that
       asked a stranger to commit to the top of it. Both must exist: dropping
       the ceiling caps the business, dropping the first phase puts the entry
       price out of reach of the people most likely to say yes first. */
    check('business systems start at CA$4,800',
      !!build && /^from CA\$4,800$/.test(build.amount), build ? build.amount : 'missing');
    check('larger systems are quoted rather than priced',
      !!full && !/\d/.test(full.amount), full ? full.amount : 'missing');
    check('both system rows are present', !!build && !!full, 'both rows must be present');
    // "Fixed scope in writing" told a buyer nothing about what arrives.
    check('the build says what is actually delivered',
      !!build && /handover/i.test(build.detail) && /production/i.test(build.detail),
      build ? build.detail : '');

    /* ⚠️  DURATIONS ARE MEASURED, NOT MARKETING. These assertions exist
       because this row once promised a first-phase system build "in about
       two weeks" at a CA$3,500 floor -- a speed never achieved on any real
       project (AIDRR six weeks, GetPolisha four, Verdict four, this site
       two) and a floor of roughly CA$175/day across four actual weeks. A
       quoted duration is a promise to a buyer, so shortening one to sound
       competitive has to fail here rather than ship. If a future edit really
       does make the work faster, change the measured record in the comment
       above the row first, then these numbers. */
    check('business systems quote four weeks, not two',
      !!build && /four weeks/i.test(build.detail) && !/two weeks/i.test(build.detail),
      build ? build.detail : 'missing');
    check('larger systems are quoted at six weeks and up',
      !!full && /six weeks/i.test(full.detail), full ? full.detail : 'missing');
    check('the priced system row says a quote follows a check or a diagnostic',
      !!build && /quoted in writing/i.test(build.detail), build ? build.detail : 'missing');
    check('every website row states how long it takes',
      [landing, site, custom].every(x => x && /week/i.test(x.detail)),
      [landing, site, custom].map(x => x ? x.title + ': ' + x.detail : 'missing').join(' | '));

    /* The ladder has to stay monotonic in BOTH price and time, or the page
       argues against itself: a buyer who reads "four weeks" beside a floor
       lower than the shorter job's floor concludes one of the two numbers is
       untrue, and they are right. */
    /* Parse every CA$ figure in a cell, so a range like "CA$4,800-7,500"
       yields [4800, 7500] rather than the 48007500 that stripping non-digits
       from the whole string would produce -- a bug that made this comparison
       pass for the wrong reason no matter what the prices were. */
    const figures = (t) => (String(t).match(/[\d][\d,]*/g) || [])
      .map((n) => parseInt(n.replace(/,/g, ''), 10));
    const floorOf = (row) => (row ? figures(row.amount)[0] : NaN);
    const ceilingOf = (row) => {
      const f = row ? figures(row.amount) : [];
      return f.length ? f[f.length - 1] : NaN;
    };
    check('price parsing reads a range as two figures',
      JSON.stringify(figures('CA$4,800\u20137,500')) === '[4800,7500]',
      JSON.stringify(figures('CA$4,800\u20137,500')));
    check('the system floor sits above the fixed-price website work',
      floorOf(build) > ceilingOf(site),
      (build ? build.amount : '?') + ' vs ' + (site ? site.amount : '?'));

    // The retainer is split, because one blended number set the wrong
    // expectation in both directions.
    check('hosting and change work are priced separately',
      !!care && !!change && care.amount !== change.amount,
      (care ? care.amount : '?') + ' / ' + (change ? change.amount : '?'));
    check('the care plan is CA$120/mo', !!care && /CA\$120\/mo/.test(care.amount),
      care ? care.amount : 'missing');

    /* Every superseded number, anywhere on the page. Each of these was live at
       some point, and each contradicted something else while it was. */
    for (const stale of ['CA\\$2,500', 'CA\\$1,800', 'CA\\$4,500', 'CA\\$6,000', 'CA\\$500.900', 'CA\\$250/mo', 'CA\\$900/mo',
                         'CA\\$3,500', 'CA\\$6,500', 'CA\\$9,000',
                         'CA\\$12,000', 'CA\\$4,800.7,500', 'CA\\$6,000.12,000']) {
      check('no superseded price survives: ' + stale.replace(/\\\\/g, ''),
        !new RegExp(stale).test(r.bodyText));
    }

    check('pricing explains that the diagnostic is optional',
      /do not need the diagnostic/i.test(r.priceNotes), r.priceNotes.slice(0, 120));
    /* Terms on the page, not in an awkward email after the buyer has decided. */
    check('payment terms are stated before the first call',
      /half to book|40%/i.test(r.priceNotes), r.priceNotes.slice(0, 260));
    check('scope changes are quoted before they are built',
      /quoted before it is built/i.test(r.priceNotes), r.priceNotes.slice(0, 400));

    /* ⚠️  THE LAUNCH OFFER IS A PERCENTAGE, AND THAT IS THE POINT.
       Every earlier version named a figure, and a named figure sits somewhere
       relative to the published prices. Twice it landed below a floor on the
       same page, which drags the anchor down permanently, and it had to be
       re-picked by hand whenever any price moved -- which is how the page
       ended up quoting three different build prices at once. A percentage is
       correct against every row for ever and cannot contradict one. */
    check('the launch offer is bounded by a count',
      /first two/i.test(r.founding), r.founding.slice(0, 160));
    /* ⚠️  THE RULE IS "NO FIXED FIGURE", NOT "MUST BE A PERCENTAGE". This
       used to require a % sign, which quietly made one legitimate offer
       unshippable: "first two system builds free" names no figure either, and
       so cannot drift out of step with a price row, which is the entire
       reason the original rule existed. A percentage and a free offer both
       pass; "CA$1,000 off" does not, because that is the one that has to be
       re-picked by hand every time any row moves. */
    check('the launch offer names no fixed amount',
      !/CA\$/.test(r.founding) && (/%/.test(r.founding) || /\bfree\b/i.test(r.founding)),
      r.founding.slice(0, 200));
    check('the launch offer says what it buys',
      /case study/i.test(r.founding), r.founding.slice(0, 200));
    check('the launch offer is not conditional on a testimonial',
      !/testimonial|review/i.test(r.founding), r.founding.slice(0, 220));

    await ctx.close();
  }

  // ------------------------------------------------- iOS zoom on form focus
  /* iOS Safari zooms the whole page when a focused control computes to under
     16px, and does not zoom back out on blur -- so one tap on "Your name"
     leaves a phone visitor pinching their way back to the next field, on the
     one screen where an enquiry is either sent or abandoned. Every control was
     15px, under the threshold by the smallest margin that still costs you the
     enquiry. This asserts the whole form, not one field, so a new control
     cannot reintroduce it. */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const controls = await page.evaluate(() => {
      const form = document.getElementById('contact-form');
      if (!form) return null;
      const sel = 'input:not([type=checkbox]):not([type=radio]), select, textarea';
      return [...form.querySelectorAll(sel)].map(el => ({
        id: el.id || el.name || el.tagName.toLowerCase(),
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
    });

    check('the contact form has controls to check', !!controls && controls.length >= 4,
      controls ? String(controls.length) : 'no form');
    const tooSmall = (controls || []).filter(c => c.size < 16);
    check('no form control is under 16px, which is what makes iOS zoom',
      tooSmall.length === 0,
      tooSmall.map(c => c.id + '=' + c.size + 'px').join(', '));

    await ctx.close();
  }

  // ------------------------------------------------ contact form routing field
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const r = await page.evaluate(() => {
      const select = document.getElementById('cf-need');
      const label = document.querySelector('label[for="cf-need"]');
      const heading = document.querySelector('.contact-copy h2');
      const messageLabel = document.querySelector('label[for="cf-message"]');
      return {
        present: !!select,
        labelled: !!label && label.textContent.trim().length > 0,
        required: !!select && select.hasAttribute('required'),
        defaultValue: select ? select.value : null,
        options: select ? [...select.options].map(o => o.value) : [],
        hasUnsure: select ? [...select.options].some(o => /not sure/i.test(o.textContent)) : false,
        heading: heading ? heading.textContent.trim() : '',
        messageLabel: messageLabel ? messageLabel.textContent.trim() : '',
      };
    });

    check('the enquiry names a routing field', r.present);
    check('the routing field has a real label', r.labelled);
    // Somebody who does not know what they need must still be able to send.
    check('the routing field is optional', r.present && !r.required);
    check('the routing field starts unanswered', r.defaultValue === '', String(r.defaultValue));
    check('the routing field offers a "not sure" answer', r.hasUnsure);
    check('the contact heading welcomes both kinds of work',
      /build or improve/i.test(r.heading), r.heading);
    check('the message box asks for now-and-next, not only what is broken',
      /what you have now/i.test(r.messageLabel), r.messageLabel);

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
    check('describes an Organization, not a Person',
      types.includes('Organization') && !types.includes('Person'), types.join(', '));
    check('describes a ProfessionalService', types.includes('ProfessionalService'));
    check('describes a WebSite', types.includes('WebSite'));
    const blob = JSON.stringify(ld || {});
    check('structured data publishes no personal address', !blob.includes('tobaina@gmail.com'));
    check('structured data claims no outcomes', !/revenue|customers|testimonial|award/i.test(blob));

    const meta = await page.evaluate(() => ({
      canonical: (document.querySelector('link[rel=canonical]') || {}).href,
      ogImage: (document.querySelector('meta[property="og:image"]') || {}).content,
      twitterCard: (document.querySelector('meta[name="twitter:card"]') || {}).content,
      title: document.title,
    }));
    /* ⚠️  ONE CANONICAL HOME, ASSERTED FROM BOTH DOMAINS.
           This suite is run against tobi.getpolisha.com AND
           systems.getpolisha.com, which serve byte-identical HTML. Two live
           addresses with no canonical between them is duplicate content, and
           search engines pick the winner rather than the business doing it.
           systems.getpolisha.com is the company address, so the canonical is
           that one from BOTH hosts. Do not make this relative to BASE, which
           would let each host declare itself canonical and defeat the point. */
    check('canonical names the company address from either host',
      meta.canonical === 'https://systems.getpolisha.com/', meta.canonical);
    check('og image preserved', /og-image-2\.jpg$/.test(meta.ogImage || ''));
    check('twitter card preserved', meta.twitterCard === 'summary_large_image');
    check('title carries the company name', /Polisha Systems/.test(meta.title), meta.title);
    await ctx.close();
  }

  /* ============================================ the social card =========
     ⚠️  share.html IS A SECOND COPY OF THIS SITE'S IDENTITY, AND IT IS THE
     ONE STRANGERS SEE FIRST. vercel.json rewrites "/" to /share.html for
     LinkedIn, Facebook, Twitter, Slack, WhatsApp, Telegram, Discord and
     Reddit crawlers, so the preview card on every shared link is built from
     that file and NOT from index.html.

     This block exists because share.html was missed during the repositioning
     and spent weeks telling every social crawler "Tobi Aina" and "I build the
     systems", while index.html said Polisha Systems and "we". Nobody sees that
     by loading the site in a browser. Update one file, update both.
     ====================================================================== */
  {
    const ctx = await browser.newContext();

    const direct = await ctx.request.get(url('/share.html'));
    check('share.html is served', direct.status() === 200, String(direct.status()));
    const shareHtml = await direct.text();

    check('the card names the company', /Polisha Systems/.test(shareHtml));
    check('the card names no person',
      !/Tobi|Tomi|Aina/i.test(shareHtml), (shareHtml.match(/Tobi|Tomi|Aina/i) || [''])[0]);
    check('the card speaks as a company',
      !/\bI\b|\bmy\b/.test(shareHtml), (shareHtml.match(/\bI\b|\bmy\b/) || [''])[0]);
    check('the card points at the company address',
      /og:url content=https:\/\/systems\.getpolisha\.com\//.test(shareHtml));
    check('the card carries an image', /og:image content=\S*og-image-2\.jpg/.test(shareHtml));
    check('the card sends humans on to the site', /location\.replace\('\/'\)/.test(shareHtml));

    /* The rewrite itself, not just the file: a correct share.html behind a
       broken user-agent rule is still a wrong preview card. The local static
       server does not read vercel.json, so this one is only meaningful
       against a deployment. */
    if (DEPLOYED) {
      /* ⚠️  THE CARD MUST BE A REWRITE (200 AT "/"), NEVER A REDIRECT.
         middleware.js used to answer crawlers with a 302 to /share.html, and
         middleware runs BEFORE rewrites, so the correct rewrite sitting in
         vercel.json never fired. A crawler that does not follow redirects got
         the body "Redirecting..." and built no card at all. The middleware was
         deleted. MEASURED AFTERWARDS: the vercel.json rewrite still does not
         fire, and a crawler now receives index.html at 200. That is fine,
         because index.html's own tags are correct and sit in its first 1.8 KB,
         but it means share.html is a spare that nothing reaches.
         maxRedirects: 0 is the whole point of this assertion. Removing it
         makes the test pass against the broken behaviour. */
      const asCrawler = await ctx.request.get(BASE, {
        headers: { 'user-agent': 'LinkedInBot/1.0 (compatible; Mozilla/5.0)' },
        maxRedirects: 0,
      });
      check('the crawler is answered directly, not redirected',
        asCrawler.status() === 200, String(asCrawler.status()));

      const crawled = await asCrawler.text();
      check('a social crawler is served the card',
        /Polisha Systems/.test(crawled) && !/Tomi|Tobi Aina/i.test(crawled),
        crawled.slice(0, 200));
      check('the crawler response carries an og:title',
        /og:title/.test(crawled));

      /* ⚠️  CRAWLERS TRUNCATE. The card is only as good as the bytes that
         arrive before a scraper stops reading, and several stop well short of
         a whole document. index.html is ~45 KB and the tags live near the top
         purely because nothing has been inserted above them yet. This pins
         that: put a large inline style, script or banner above the og block
         and this fails before a stranger sees a blank card on LinkedIn. */
      const ogAt = crawled.indexOf('og:title');
      check('the og tags arrive inside the first 4 KB',
        ogAt > -1 && ogAt < 4096, 'og:title at byte ' + ogAt);
    }

    await ctx.close();
  }

  /* ========================================== one team, no one face =====
     The team section used to carry a single portrait under the heading "Your
     team". One face under that heading does not read as a small team, it
     reads as one person with a plural pronoun, which is the exact impression
     the repositioning exists to correct. The portrait and both its asset
     files were removed rather than joined by invented colleagues.
     ====================================================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const team = await page.evaluate(() => {
      const el = document.querySelector('.founder');
      if (!el) return null;
      return {
        images: el.querySelectorAll('img, picture').length,
        text: el.innerText.replace(/\s+/g, ' '),
        button: (el.querySelector('.button') || {}).innerText || '',
      };
    });
    check('the team section exists', team !== null);
    check('the team section shows no single portrait', team.images === 0, String(team.images));
    check('the team section still claims accountability',
      /accountable/i.test(team.text));
    check('more than one role is described',
      /separate roles|two roles/i.test(team.text), team.text.slice(0, 160));
    check('the social button promises no company page it does not have',
      !/follow us/i.test(team.button), team.button);

    const portraits = await Promise.all(
      ['/assets/tobi-portrait.jpg', '/assets/tobi-portrait.webp'].map(
        (u) => page.request.get(url(u)).then((r) => u + ':' + r.status())));
    check('the portrait files are gone',
      portraits.every((r) => /:40[34]$/.test(r)), portraits.join(' '));

    await ctx.close();
  }

  /* ================================================== company voice ======
     ⚠️  THIS SITE SPEAKS AS A COMPANY. IT USED TO SPEAK AS ONE PERSON.
     The repositioning to Polisha Systems turned roughly forty sentences from
     "I build" into "we build", and the failure mode is not a broken page, it
     is one stray "I" in a paragraph nobody rereads. A person arriving from a
     meeting with two people, who then reads "I will tell you honestly",
     learns that the company is one person with a plural pronoun.

     The single permitted exception is the newsletter checkbox, where "Send me
     occasional notes" is the READER speaking about themselves, not the
     business. It is matched exactly rather than allowed by regex, so a second
     first-person sentence cannot hide behind it.
     ====================================================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const NEWSLETTER = 'Send me occasional notes on operations systems';
    const copy = await page.evaluate((exception) => {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      return { full: text, stripped: text.split(exception).join(' ') };
    }, NEWSLETTER);

    check('the newsletter exception is still on the page',
      copy.full.includes(NEWSLETTER));

    const voice = [
      [/\bI\b/, 'first person "I"'],
      [/\bmy\b/i, '"my"'],
      [/\bme\b/i, '"me" outside the newsletter line'],
      [/\bmine\b/i, '"mine"'],
    ];
    for (const [re, label] of voice) {
      const hit = copy.stripped.match(re);
      check('company voice: no ' + label, !hit,
        hit ? '...' + copy.stripped.slice(Math.max(0, hit.index - 60), hit.index + 60) + '...' : '');
    }

    const banned = [
      [/Tomi/i, 'a second name'],
      [/Tobi Aina/i, 'a personal name'],
      [/Cambridge|Kitchener|Waterloo/i, 'a location limit'],
      [/\bhiring\b/i, 'the hiring pitch'],
      [/tobaina@gmail/i, 'a personal address'],
      [/no-code/i, '"no-code"'],
      [/generic developer/i, '"generic developer"'],
      [/[\u2013\u2014]/, 'an en or em dash'],
    ];
    for (const [re, label] of banned) {
      const hit = copy.full.match(re);
      check('copy contains no ' + label, !hit,
        hit ? '...' + copy.full.slice(Math.max(0, hit.index - 60), hit.index + 60) + '...' : '');
    }
    await ctx.close();
  }

  /* ============================================ the free process check ===
     The only no-cost step on the page and the main conversion, so it is
     asserted structurally rather than left to the eye. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const chk = await page.evaluate(() => {
      const sec = document.getElementById('process-check');
      return {
        present: !!sec,
        steps: sec ? sec.querySelectorAll('.check-step').length : 0,
        numbers: sec ? [...sec.querySelectorAll('.check-num')].map(n => n.textContent.trim()) : [],
        note: sec ? (sec.querySelector('.check-note') || {}).innerText || '' : '',
        ctas: [...document.querySelectorAll('[data-need="check"]')].length,
      };
    });
    check('the free process check section exists', chk.present);
    check('it is a three step sequence', chk.steps === 3, 'got ' + chk.steps);
    check('the steps are numbered in order',
      chk.numbers.join('') === '123', chk.numbers.join(','));
    check('it separates the free check from the paid diagnostic',
      /diagnostic/i.test(chk.note) && /free process check/i.test(chk.note), chk.note);
    check('more than one call to action offers the free check', chk.ctas >= 2, 'got ' + chk.ctas);

    /* Clicking the hero call to action must arrive at the form with the
       option already chosen. Without this the visitor is asked, immediately
       after saying what they want, to say it again. */
    await page.click('[data-need="check"]');
    await page.waitForTimeout(300);
    const selected = await page.evaluate(() => document.getElementById('cf-need').value);
    check('the call to action preselects the free process check',
      selected === 'check', 'select is "' + selected + '"');
    await ctx.close();
  }

  await browser.close();
  if (server) server.close();

  console.log(failures.length ? 'FAILURES:\n  ' + failures.join('\n  ') + '\n' : '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
