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
    for (const href of ['#problems', '#how', '#work', '#contact']) {
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
    const want = await page.evaluate(() => Math.round(document.getElementById('problems').getBoundingClientRect().top + window.pageYOffset));
    await page.click('.nav-links a[href="#problems"]');
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
    /* These two links are the only claim on this page a stranger can go and
       check: everything else, Direct Apply included, is a screen they cannot
       log into. They are therefore load bearing for cold traffic, and the
       assertions follow them wherever in the page they live. */
    const links = await page.evaluate(() => [...document.querySelectorAll('#products .pstrip-links a')].map(a => ({
      href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() })));
    check('two product links present', links.length === 2, 'found ' + links.length);
    check('Verdict link points at the live product', links.some(l => l.href === 'https://verdict.getpolisha.com/'), JSON.stringify(links.map(l => l.href)));
    check('GetPolisha link points at the live product', links.some(l => l.href === 'https://getpolisha.com/'));
    check('product links open in a new tab safely', links.every(l => l.target === '_blank' && /noopener/.test(l.rel)));
    check('each product link is named, not a bare "here"',
      links.every(l => /Verdict|GetPolisha/i.test(l.text)), JSON.stringify(links.map(l => l.text)));
    /* ⚠️  THE SIZE CHECK IS THE POINT OF THIS BLOCK, NOT A NICETY.
       What stood here was two cards with screenshots and feature lists, about
       1,100px and a quarter of the scroll. It was cut to a strip on purpose
       and the obvious way for it to come back is one screenshot at a time, so
       the height and the image count are both pinned. If this fails because
       the strip legitimately needs more room, raise the number deliberately
       and say why. Do not delete the check. */
    const strip = await page.evaluate(() => {
      const el = document.getElementById('products');
      return {
        present: !!el,
        height: el ? Math.round(el.getBoundingClientRect().height) : 0,
        images: el ? el.querySelectorAll('img, picture, svg').length : -1,
        lists: el ? el.querySelectorAll('.pcard, .product-grid').length : -1,
        navLink: !!document.querySelector('a[href="#products"]'),
      };
    });
    check('the proof strip is present', strip.present, JSON.stringify(strip));
    check('the strip has not grown back into a card section',
      strip.height > 0 && strip.height <= 320, JSON.stringify(strip));
    check('the strip carries no screenshots', strip.images === 0, JSON.stringify(strip));
    check('the old product cards have not returned', strip.lists === 0, JSON.stringify(strip));
    check('the strip is reachable from the footer', strip.navLink, JSON.stringify(strip));

    /* Every in-page anchor must land on something. The footer carried a
       "Services" link to #services for weeks and there has never been a
       section with that id: it did nothing when clicked. */
    const deadAnchors = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')]
      .map(a => a.getAttribute('href'))
      .filter(h => h && h !== '#' && !document.querySelector(h)));
    check('every in-page link lands on a real section',
      deadAnchors.length === 0, JSON.stringify(deadAnchors));
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
      body: '{"ok":false,"error":"The form is not available right now. Please email us at hello@getpolisha.com and we will pick it up from there."}' }));
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
    /* ⚠️  AN ADDRESS IS REQUIRED AGAIN, AND A PERSONAL ONE IS STILL FORBIDDEN.
       This assertion has now been written three ways, which is the whole
       history of the problem. It first required the personal inbox, which
       republished a private address to every visitor who hit a broken form.
       It was then inverted to forbid any address at all, and pointed the
       visitor at the LinkedIn link instead, which was always the weaker
       answer because a company page cannot be messaged by the public. There
       is now a business mailbox, so the rule is finally the right one: name
       it, and never name a personal one. */
    check('failure routes the visitor to the business address',
      /hello@getpolisha\.com/i.test(bad.status), bad.status);
    check('failure never republishes a personal address',
      !/gmail|tobaina/i.test(bad.status), bad.status);
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
    const want = await page.evaluate(() => Math.round(document.getElementById('problems').getBoundingClientRect().top + window.pageYOffset));
    await page.click('.nav-links a[href="#problems"]');
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

  // ------------------------------------- the one price, and what replaced
  /* =====================================================================
     THE PRICING TABLE WAS DELETED ON PURPOSE. THE ONE LINE WAS NOT.

     The table was 391 words and most of two screens, the single largest
     block on a page whose real problem was that it ran for ten and a half
     screens. Cutting it was right. Cutting EVERY number with it was not,
     and that is what this block defends.

     A floor does two jobs that nothing else on the page does: it filters
     out an enquiry with three hundred dollars behind it, and it signals a
     business rather than a freelancer. Delete the line and the cost does
     not disappear, it moves onto the calendar, where every first call
     opens with budget instead of with the problem.

     So: exactly two figures, in the hero, and NOWHERE ELSE. The "no second
     price" assertion is the important one. A table creeping back in one row
     at a time is how this page got to ten screens the first time.
     ===================================================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const r = await page.evaluate(() => {
      const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
      const price = document.querySelector('.hero-price');
      const heroText = document.querySelector('.hero-text');
      const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(n => n.textContent).join(' ');
      return {
        heroPrice: text(price),
        priceInHero: !!price && !!heroText && heroText.contains(price),
        bodyText: document.body.innerText.replace(/\s+/g, ' '),
        /* ⚠️  THE PRICE SWEEP DELIBERATELY EXCLUDES THE ENQUIRY FORM.
           The budget dropdown offers CA$1,500 / CA$5,000 / CA$15,000, and
           those are the VISITOR telling us their budget, not prices we
           charge. Sweeping them would either fail honest copy or force them
           onto the allowlist, where a real unapproved price could then hide
           behind them. The guard is about what we publish as our price. */
        pricedText: (() => {
          const clone = document.body.cloneNode(true);
          const form = clone.querySelector('#contact');
          if (form) form.remove();
          return clone.innerText.replace(/\s+/g, ' ');
        })(),
        ld,
        gone: ['services', 'process-check', 'walkthrough', 'hiring']
          .filter(id => !!document.getElementById(id)),
        tableBits: document.querySelectorAll('.price-row, .price-group-head, .price-list').length,
        mailtos: [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.getAttribute('href')),
        navLabels: [...document.querySelectorAll('.nav-links a')].map(a => text(a)),
        heroCopyCount: document.querySelectorAll('.hero-copy').length,
        heroCopy: text(document.querySelector('.hero-copy')),
        heroServicesFirst: (document.querySelector('.hero-services li') || {}).textContent || '',
        heroServices: text(document.querySelector('.hero-services')),
        heroServicesText: (document.querySelector('.hero-services') || {}).textContent || '',
        heroServicesTag: (document.querySelector('.hero-services') || {}).tagName || '',
        heroServicesCount: document.querySelectorAll('.hero-services li').length,
        actions: [...document.querySelectorAll('.actions .button')]
          .map(a => ({ label: text(a), href: a.getAttribute('href') })),
        caseDepthLabel: text(document.querySelector('.case-depth span')),
        productsLine: text(document.querySelector('.pstrip-copy')),
        notice: text(document.querySelector('.notice')),
        noticeLinksToContact: !!document.querySelector('.notice a[href="#contact"]'),
        hasPricing: !!document.getElementById('pricing'),
        diagnosticText: text(document.getElementById('diagnostic')),
        quoteBlocks: document.querySelectorAll('blockquote, .testimonial, .quote').length,
      };
    });

    /* ⚠️  THE HERO CARRIES NO PRICE, AND THIS ASSERTION IS INVERTED ON
       PURPOSE. A line naming both build floors used to sit under the call to
       action, and the argument for it was that a floor filters out an enquiry
       with a few hundred dollars behind it. That job is now done in the
       pricing section, where a visitor goes when they want a number. Pricing
       lives in one place, so the hero can make the argument instead of
       opening the negotiation. Do not reintroduce it here. */
    check('the hero no longer opens with a price', !r.heroPrice, r.heroPrice);
    check('prices still exist, in the pricing section', r.hasPricing);

    /* ⚠️  AN ALLOWLIST, NOT A COUNT, AND THAT CHANGE WAS DELIBERATE.
       This used to assert that exactly two figures existed anywhere on the
       page, which was right while the only prices were the two build floors
       in the hero. The diagnostic and the three support tiers are prices we
       chose to publish, so a bare count would now fail on purpose-built copy
       and teach whoever hit it to delete the guard.
       What still must not happen is a price appearing that nobody decided on,
       which is how the old 391-word table grew back one row at a time. So the
       set of amounts is pinned instead: add a price here only at the moment
       you add it to the page AND to the offer catalogue in the structured
       data, which the next assertion cross-checks. */
    const ALLOWED_PRICES = ['CA$400', 'CA$1,200', 'CA$4,800', 'CA$120', 'CA$450'];
    const amounts = r.pricedText.match(/CA\$[\d,]+/g) || [];
    const unapproved = [...new Set(amounts)].filter(a => !ALLOWED_PRICES.includes(a));
    check('every money figure on the page is one we decided on',
      unapproved.length === 0, unapproved.join(' '));
    check('the two build floors are still stated',
      amounts.includes('CA$1,200') && amounts.includes('CA$4,800'), amounts.join(' '));
    /* ⚠️  CA$400 IS NOW AN ANCHOR, NOT A PRICE. The diagnostic is free while
       we take on our first clients. Naming what it normally costs is what
       stops "free" reading as a sales call, so the figure must stay AND the
       word free must stay. Remove either and the offer loses its meaning. */
    check('the diagnostic still names what it normally costs',
      amounts.includes('CA$400'), amounts.join(' '));
    check('the diagnostic is offered free',
      /free/i.test(r.diagnosticText) && /normally/i.test(r.diagnosticText),
      r.diagnosticText.slice(0, 200));
    check('the reason it is free is stated, not just the price',
      /first clients/i.test(r.diagnosticText), r.diagnosticText.slice(0, 200));
    check('all three support tiers are priced',
      ['CA$120', 'CA$450', 'CA$1,200'].every(a => amounts.includes(a)), amounts.join(' '));

    /* Structured data is a second copy of the same claim, and a stale second
       copy is what search engines surface. It must agree with the line. */
    /* Structured data is a second copy of the same claim, and a stale second
       copy is what a search engine surfaces. Each published price must appear
       in the catalogue, and the catalogue must publish nothing extra. */
    const ldPrices = (r.ld.match(/"price": ?"(\d+)"/g) || [])
      .map(m => 'CA$' + Number(m.replace(/\D/g, '')).toLocaleString('en-CA'));
    /* ⚠️  THE DIAGNOSTIC IS THE ONE OFFER WHOSE TWO FIGURES DIFFER ON
       PURPOSE. Its price in the catalogue is 0, because that is what it
       actually costs right now, while the page shows CA$400 as the anchor for
       what it normally costs. Both are true and neither should be changed to
       match the other, so it is excluded from the cross-check and asserted on
       its own below. Every other price must still agree in both directions. */
    const vis = [...new Set(amounts)].filter(a => a !== 'CA$400');
    const cat = ldPrices.filter(a => a !== 'CA$0');
    check('every visible price appears in the offer catalogue',
      vis.every(a => cat.includes(a)),
      'visible ' + vis.join(' ') + ' | catalogue ' + cat.join(' '));
    check('the offer catalogue publishes no price the page does not show',
      cat.every(a => ALLOWED_PRICES.includes(a)), cat.join(' '));
    check('the catalogue publishes the diagnostic as free',
      ldPrices.includes('CA$0'), ldPrices.join(' '));

    // ---- what was removed stays removed
    /* #pricing is NOT in that list any more. It came back deliberately, as
       a two column section rather than the 391 word table it replaced. */
    check('the deleted sections are gone', r.gone.length === 0, r.gone.join(', '));
    check('the pricing section is back', !!r.navLabels.length && r.hasPricing);
    check('no fragment of the pricing table survives',
      r.tableBits === 0, String(r.tableBits));
    /* A draft of this page replaced the working form with a mailto. On a
       phone a mailto often does nothing at all, and the address it used had
       never been chosen. The form is the only contact route. */
    check('no mailto replaces the contact form',
      r.mailtos.length === 0, r.mailtos.join(' '));

    // ---- the structure that replaced it
    check('navigation offers problems and how it works',
      r.navLabels.some(l => /problem/i.test(l)) && r.navLabels.some(l => /how it works/i.test(l)),
      r.navLabels.join(' | '));
    check('navigation no longer points at deleted sections',
      !r.navLabels.some(l => /^services$/i.test(l)), r.navLabels.join(' | '));
    check('navigation reaches the prices', r.navLabels.some(l => /^pricing$/i.test(l)),
      r.navLabels.join(' | '));

    /* The hero carried two paragraphs saying the same thing, the second of
       them duplicating the services strip two lines below it. */
    check('the hero says it once', r.heroCopyCount === 1, String(r.heroCopyCount));

    /* ⚠️  THE HERO MUST NOT LEAD WITH WEBSITES. This is positioning, not
       wording. The line opened "We design websites and build the tools behind
       growing businesses", which put the most crowded and most price shopped
       thing we sell in the first four words, directly under a headline about
       turning a process into a system. A visitor categorises a company from
       that sentence. Websites stay in it, because we sell them, but they
       belong at the end where they read as part of a system. The same order
       has to hold in the strip underneath, or the two contradict each other. */
    check('the hero does not open by selling websites',
      !/^we design websites/i.test(r.heroCopy) && !/^websites/i.test(r.heroCopy.trim()), r.heroCopy);
    check('the hero still names the tools before the websites',
      r.heroCopy.toLowerCase().indexOf('tools') < r.heroCopy.toLowerCase().indexOf('website'), r.heroCopy);
    check('websites are still offered, just not first',
      /website/i.test(r.heroCopy), r.heroCopy);
    check('the service strip leads with the same thing the sentence does',
      !/website/i.test(r.heroServicesFirst), r.heroServicesFirst);
    check('hero copy still offers website work',
      /website/i.test(r.bodyText.slice(0, 900)), r.bodyText.slice(0, 160));
    check('hero names the service routes',
      /Websites/i.test(r.heroServices) && /Automation/i.test(r.heroServices), r.heroServices);
    /* ⚠️  THE SERVICE LABELS MUST NOT RUN TOGETHER IN THE TEXT.
       This line was briefly a flex row of spans. Flex collapses the whitespace
       between its items, so the element's text content read literally as
       "WebsitesCRMERP style systemsPortalsAutomation" — which is what a screen
       reader announced and what landed on the clipboard, even though it looked
       spaced on screen. It is a <ul> now, announced as a list with each item
       read separately. A visual separator is not a substitute for one in the
       text, so this checks the text, not the pixels. */
    check('the service labels are separated in the text, not only on screen',
      !/[a-z][A-Z]/.test(r.heroServicesText.replace(/\s+/g, ' ').trim()),
      r.heroServicesText);
    check('the services are marked up as a list',
      r.heroServicesTag === 'UL' && r.heroServicesCount === 5,
      r.heroServicesTag + ' with ' + r.heroServicesCount);
    /* ⚠️  THE SECOND HERO BUTTON IS THE AUDIT NOW, ON PURPOSE.
       It used to scroll to the problems grid, which asked a stranger to read.
       The audit asks them a question about their own business instead and
       answers it with a number, which is the only thing on this page a cold
       visitor can get value from without talking to anybody. The problems
       grid is still one scroll down and still in the navigation.
       What must stay true: the hero offers the paid route and a free route,
       and the free one does not require a conversation. */
    check('the hero offers a way to talk to us', r.actions.some(a => a.href === '#contact'),
      JSON.stringify(r.actions));
    check('the hero offers a free route that needs no conversation',
      r.actions.some(a => a.href === '/audit'), JSON.stringify(r.actions));
    check('the problems grid is still reachable from the navigation',
      r.navLabels.some(l => /problem/i.test(l)), r.navLabels.join(' | '));

    // ---- claims that must never appear
    check('no hiring copy', !/we are hiring|join (our|the) team/i.test(r.bodyText));
    /* ⚠️  THE WORD IS NOT THE PROBLEM, THE CLAIM IS.
       This used to fail on the word "testimonial" anywhere, which now trips
       on the founding offer, where we ask a first client FOR one in exchange
       for included work. Asking for a testimonial we do not have is honest;
       implying we already have them is not. So the check moved from the word
       to the claim, and to the markup a quote would need. */
    check('no social proof is claimed that we do not have',
      !/trusted by|our clients include|clients say|customers love|rated \d/i.test(r.bodyText),
      (r.bodyText.match(/trusted by|our clients include|clients say|customers love|rated \d/i) || [''])[0]);
    check('no quote is presented as a client testimonial',
      r.quoteBlocks === 0, String(r.quoteBlocks));
    check('implementation figures stay labelled as depth, not as the result',
      /behind the system/i.test(r.caseDepthLabel), r.caseDepthLabel);

    // ---- products are ours, and said to be
    check('the products are still claimed as our own',
      /products of our own/i.test(r.productsLine), r.productsLine);
    check('the products line says we run them, not only that we built them',
      /\brun\b/i.test(r.productsLine), r.productsLine);
    check('the products are still declared as ours and not as client work',
      /not client work/i.test(r.productsLine), r.productsLine);
    check('the strip still invites the visitor to open one',
      /open either one/i.test(r.productsLine), r.productsLine);

    // ---- the announcement
    check('announcement invites a project', /taking on new projects/i.test(r.notice), r.notice);
    check('announcement carries no expiring date',
      !/this quarter|this month|this year/i.test(r.notice), r.notice);
    check('announcement links to the contact form', r.noticeLinksToContact);

    await ctx.close();
  }

  // ------------------------------------------------ problems we solve grid
  /* =====================================================================
     This grid replaced a "what we build" service list, and the difference
     is the entire positioning of the page. A service list asks a visitor to
     already know whether they need a CRM, an automation or a custom app.
     They do not. They know their spreadsheet is a mess.

     Each tile therefore has two halves that must both survive: the sentence
     the BUYER would say, in their words and in quotation marks, and the
     answer in ours. A tile that loses its quote has been quietly turned
     back into a service card.
     ===================================================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const g = await page.evaluate(() => {
      const opts = [...document.querySelectorAll('#cf-need option')].map(o => o.value);
      return {
        present: !!document.getElementById('problems'),
        tiles: [...document.querySelectorAll('.pain')].map(t => ({
          said: (t.querySelector('.pain-said') || {}).textContent || '',
          fix: (t.querySelector('.pain-fix') || {}).textContent || '',
          href: t.getAttribute('href'),
          need: t.getAttribute('data-need'),
          track: t.getAttribute('data-track'),
        })),
        needOptions: opts,
      };
    });

    check('the problems section exists', g.present);
    check('it offers six problems', g.tiles.length === 6, 'got ' + g.tiles.length);
    check('every tile quotes the buyer',
      g.tiles.every(t => /^\s*[“"]/.test(t.said) && /[”"]\s*$/.test(t.said)),
      (g.tiles.find(t => !/^\s*[“"]/.test(t.said)) || {}).said || '');
    check('every tile answers in our voice',
      g.tiles.every(t => /^\s*We\b/.test(t.fix)),
      (g.tiles.find(t => !/^\s*We\b/.test(t.fix)) || {}).fix || '');
    check('every tile routes to the form',
      g.tiles.every(t => t.href === '#contact'),
      g.tiles.map(t => t.href).join(' '));
    /* The point of data-need is that the enquiry arrives already classified.
       A value the dropdown does not have silently does nothing. */
    check('every tile carries a need the dropdown actually offers',
      g.tiles.every(t => g.needOptions.includes(t.need)),
      g.tiles.map(t => t.need).filter(n => !g.needOptions.includes(n)).join(' '));
    check('every tile is measurable',
      g.tiles.every(t => /^pain_/.test(t.track || '')),
      g.tiles.map(t => t.track).join(' '));

    /* Both routes must be represented. A draft of this page dropped websites
       from the grid entirely while still selling them in the hero. */
    const said = g.tiles.map(t => t.said).join(' ');
    check('the website route appears among the problems',
      /website/i.test(said), said.slice(0, 200));
    check('the operations route appears among the problems',
      /spreadsheet|by hand|schedule/i.test(said), said.slice(0, 200));

    /* Clicking a tile must land on the form with that option chosen. */
    await page.click('.pain[data-need="website"]');
    await page.waitForTimeout(350);
    const picked = await page.evaluate(() => document.getElementById('cf-need').value);
    check('a tile preselects its option in the form',
      picked === 'website', 'select is "' + picked + '"');

    await ctx.close();
  }

  // ----------------------------------------- the offer and its guarantee
  /* =====================================================================
     THE DIAGNOSTIC IS THE FIRST THING ANYBODY BUYS, AND IT WENT MISSING.
     When the pricing table was cut, this went with it, which left the best
     thing on the page being given away with nothing to buy afterwards. It
     is asserted structurally so that cannot happen quietly again.

     The guarantee is the part to protect. "If we do not find at least 5
     hours a week of recoverable time, you pay nothing" is only honourable
     because it names a number AND a definition. Soften it into adjectives
     and it becomes an argument with a client instead of a promise.
     ===================================================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const o = await page.evaluate(() => {
      const t = el => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
      const card = document.querySelector('.offer-card');
      return {
        present: !!document.getElementById('diagnostic'),
        price: t(document.querySelector('.offer-head strong')),
        deliverables: document.querySelectorAll('.offer-list li').length,
        terms: t(document.querySelector('.offer-terms')),
        guarantee: t(document.querySelector('.offer-guarantee')),
        cta: !!document.querySelector('.offer-card a[data-need="diagnostic"]'),
        freeRoute: t(document.querySelector('.offer-alt')),
        cardText: t(card),
        hasBoundaries: !!document.querySelector('.boundaries'),
        patterns: [...document.querySelectorAll('.pattern-list li')].map(li => t(li)),
        bodyText: document.body.innerText.replace(/\s+/g, ' '),
      };
    });

    check('the diagnostic section exists', o.present);
    /* ⚠️  INVERTED. This required a price of CA$400 in the heading. The
       diagnostic is free while we take on our first clients, so the heading
       must say so. The CA$400 did not disappear, it moved into the terms line
       underneath as the anchor, and the assertion for that is in the pricing
       block above. */
    check('the diagnostic heading says it is free', /free/i.test(o.price), o.price);
    check('no price sits in the diagnostic heading any more',
      !/CA\$/.test(o.price), o.price);
    check('it lists what the client actually receives',
      o.deliverables === 6, String(o.deliverables));
    /* ⚠️  ALSO INVERTED, AND FOR A REASON THAT IS EASY TO MISS. The terms
       line used to promise the CA$400 was credited in full against a build
       started within 30 days. That was the risk reversal while the diagnostic
       was paid. Nothing is at risk in a free session, so crediting it would
       be meaningless, and a promise that means nothing is worse than none.
       What replaces it is the reason it is free, which is what keeps it from
       reading as a sales call. */
    check('the credit promise is gone, because there is nothing to credit',
      !/credited in full/i.test(o.terms), o.terms);
    check('the terms say what it normally costs and why it is free now',
      /normally/i.test(o.terms) && /CA\$400/.test(o.terms) && /first clients/i.test(o.terms),
      o.terms);

    /* ⚠️  THE GUARANTEE AND THE BOUNDARIES BLOCK WERE BOTH REMOVED, ON PURPOSE.

       The offer briefly carried "if we do not find at least 5 hours a week of
       recoverable time, you pay nothing", and a panel listing what we refuse
       to automate. Both were taken out as a business decision, not an
       oversight, so these assertions assert their ABSENCE rather than being
       quietly deleted. The reasoning, so a future reader does not re-add them
       by accident:

       A strong guarantee from a company nobody has heard of invites the
       question of why it needs one, and administering refunds is overhead a
       two person shop does not want. The credit against a build survives and
       is the quieter, more credible risk reversal.

       The boundaries panel went with it. It was the only place this site
       named artificial intelligence, and the decision since has gone further
       than the word: nothing may suggest a machine doing work a person would
       otherwise do. "What should stay human" only parses if something
       non-human is running the job, so that framing is out too, here and on
       the audit.

       "Automation" is NOT in scope and must not be stripped. It is the
       service itself, it appears in their own strategy document, and removing
       it would leave the business unable to describe what it sells. The line
       is between automating a process, which we do and say, and implying a
       machine exercises judgement, which we neither do nor say. */
    check('no guarantee is published',
      !/you pay nothing|hours a week of recoverable/i.test(o.cardText),
      o.cardText.slice(0, 200));
    check('scarcity is stated honestly rather than as urgency',
      /two a month/i.test(o.terms), o.terms);
    check('the boundaries panel is gone', !o.hasBoundaries);
    /* The framing, not just the word. "Stay human" and "in the loop" both
       imply something else is otherwise doing the work. */
    check('nothing suggests a machine doing a person\'s job',
      !/\bstay human\b|\bin the loop\b|\bassistant\b|\bintelligen/i.test(o.bodyText),
      (o.bodyText.match(/.{40}(stay human|in the loop|assistant|intelligen).{40}/i) || [''])[0]);
    /* ...while the service itself is still describable. */
    check('we can still say what we actually do',
      /automation/i.test(o.bodyText));

    /* ⚠️  THOSE TWO LETTERS APPEAR NOWHERE ON THIS SITE.
       Not as a claim, not as a limit, not in a caveat. This was relaxed once
       to allow a single qualified mention and has been tightened back. The
       check is on the RENDERED text of the page, so a source comment cannot
       trip it and cannot excuse it either. */
    check('artificial intelligence is never named',
      !/\bAI\b/.test(o.bodyText),
      (o.bodyText.match(/.{40}\bAI\b.{40}/) || [''])[0]);

    /* Ten patterns, each of which is running in the system above. Nothing
       goes in this list that is not already built. */
    check('the reusable patterns are listed', o.patterns.length === 10,
      String(o.patterns.length));
    check('no pattern claims an industry we have not worked in',
      !o.patterns.some(x => /healthcare|finance|legal|retail/i.test(x)),
      o.patterns.join(' | '));

    await ctx.close();
  }

  // --------------------------------------------- support tiers and terms
  /* What a client buys in a retainer is being able to reach us, not a number
     of hours, so a tier without a stated response time is a subscription to
     nothing. Website care and system care are also DIFFERENT PRODUCTS: one
     ladder for both was the original pricing mistake, because a website going
     down costs a day of enquiries and a system going down stops a business.
     These assertions exist to stop them being merged back together. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const t = await page.evaluate(() => {
      const txt = el => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
      return {
        present: !!document.getElementById('pricing'),
        lines: [...document.querySelectorAll('.price-line')].map(l => ({
          label: txt(l.querySelector('span')),
          amount: txt(l.querySelector('strong')),
        })),
        founding: txt(document.querySelector('.founding')),
        ownership: txt(document.querySelector('.price-note')),
      };
    });

    check('the pricing section exists', t.present);

    const monthly = t.lines.filter(l => /\/mo/.test(l.amount));
    check('three support tiers are published', monthly.length === 3,
      JSON.stringify(monthly.map(m => m.label.slice(0, 20))));
    check('every support tier states a response time',
      monthly.every(m => /working day|same day/i.test(m.amount)),
      monthly.map(m => m.amount).join(' | '));
    check('website care and system care are separate products',
      monthly.some(m => /website care/i.test(m.label))
        && monthly.some(m => /system care/i.test(m.label)),
      monthly.map(m => m.label.slice(0, 20)).join(' | '));

    check('the build terms promise ownership',
      /own the code/i.test(t.ownership), t.ownership.slice(0, 160));

    /* A trade, not a discount. A discount trains clients to expect discounts
       and reads as low confidence in the price. */
    check('the founding offer is a trade rather than a discount',
      /case study/i.test(t.founding) && !/% off|discount/i.test(t.founding),
      t.founding.slice(0, 200));
    check('the founding offer states real capacity',
      /two new builds a month/i.test(t.founding), t.founding.slice(0, 220));

    await ctx.close();
  }

  // --------------------------------------------------- the budget field
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const b = await page.evaluate(() => {
      const sel = document.getElementById('cf-budget');
      const label = sel && document.querySelector('label[for="cf-budget"]');
      return {
        present: !!sel,
        required: !!sel && sel.required,
        labelled: !!label && label.textContent.trim().length > 0,
        marksOptional: !!label && /optional/i.test(label.textContent),
        defaultValue: sel ? sel.value : null,
        options: sel ? [...sel.options].map(o => o.value).filter(Boolean) : [],
        hasUnsure: sel ? [...sel.options].some(o => /not sure/i.test(o.textContent)) : false,
      };
    });

    check('the enquiry offers a budget field', b.present);
    check('the budget field has a real label', b.labelled);
    /* Required here loses the people who genuinely do not know yet, who are
       often exactly the ones a diagnostic helps most. */
    check('the budget field is optional', b.present && !b.required);
    check('it is marked optional to the reader', b.marksOptional);
    check('it starts unanswered', b.defaultValue === '', String(b.defaultValue));
    check('it offers a "not sure" answer', b.hasUnsure);
    check('it offers a usable number of ranges',
      b.options.length >= 4, String(b.options.length));

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
    /* ⚠️  THIS ASSERTS THE PROPERTY, NOT A PHRASE.
       It used to match the literal string "build or improve", which pinned
       the wording rather than the requirement and failed the moment the
       heading was rewritten to something that still did the job. The
       requirement is that a website buyer and an operations buyer can both
       see themselves in it: one route that invites something to be made,
       one that invites a problem. The old heading, "What is your team still
       doing manually?", offered only the second, and a visitor who simply
       wanted a website had no answer to it and no reason to write. */
    check('the contact heading welcomes both kinds of work',
      /\b(build|website|make)\b/i.test(r.heading)
        && /\b(slow|improve|time|problem|manual|difficult)\w*\b/i.test(r.heading),
      r.heading);
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

    /* ⚠️  THE SECOND EXCEPTION: THE CUSTOMER'S OWN WORDS.
       The problems grid quotes a buyer saying "My team keeps doing the same
       work by hand." That is the reader speaking about themselves, exactly
       like the newsletter checkbox, and it is the whole reason the grid
       works. It is NOT the company slipping into the first person.
       Stripped STRUCTURALLY, by element, not by regex, so prose can never
       hide inside the exception, and every stripped item is separately
       required to be wrapped in quotation marks. */
    const copy = await page.evaluate((exception) => {
      const quotes = [...document.querySelectorAll('.pain-said')].map(e => e.innerText.trim());
      const text = document.body.innerText.replace(/\s+/g, ' ');
      let stripped = text.split(exception).join(' ');
      quotes.forEach(q => { stripped = stripped.split(q.replace(/\s+/g, ' ')).join(' '); });
      return { full: text, stripped, quotes };
    }, NEWSLETTER);

    check('the newsletter exception is still on the page',
      copy.full.includes(NEWSLETTER));
    check('every customer quote is actually quoted',
      copy.quotes.length > 0 && copy.quotes.every(q => /^[\u201c"]/.test(q) && /[\u201d"]$/.test(q)),
      copy.quotes.find(q => !/^[\u201c"]/.test(q)) || '');

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
      [/@gmail\.com/i, 'any personal mail provider'],
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

  /* =========================================== the free first step ======
     The main conversion, so it is asserted structurally rather than left to
     the eye. There were two free human first steps for a while, a 30 minute
     process check and, later, a diagnostic that stopped being paid. Two free
     versions of the same conversation is one too many, so they collapsed into
     the diagnostic and these assertions follow it. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const chk = await page.evaluate(() => {
      const sec = document.getElementById('how');
      const steps = sec ? [...sec.querySelectorAll('.flow-step')] : [];
      return {
        present: !!sec,
        steps: steps.length,
        numbers: steps.map(st => (st.querySelector('.flow-num') || {}).textContent || ''),
        first: steps.length ? steps[0].innerText : '',
        last: steps.length ? steps[steps.length - 1].innerText : '',
        all: steps.map(st => st.innerText).join(' ').replace(/\s+/g, ' '),
        ctas: [...document.querySelectorAll('[data-need="diagnostic"]')].length,
        staleCheckCtas: [...document.querySelectorAll('[data-need="check"]')].length,
      };
    });
    check('the how it works section exists', chk.present);
    /* Five, not four. "Improve" is where the retainer lives, and leaving
       it off made the process appear to end at handover, which is also where
       our only recurring revenue would have ended. */
    check('it is a five step sequence', chk.steps === 5, 'got ' + chk.steps);
    check('the steps are numbered in order',
      chk.numbers.join('') === '12345', chk.numbers.join(','));
    /* Step one IS the free diagnostic. It had a section to itself before,
       which made the first step of a process look like a separate product. */
    check('step one is the free diagnostic',
      /free/i.test(chk.first) && /diagnostic/i.test(chk.first), chk.first.slice(0, 120));
    check('ownership and handover are still promised in the flow',
      /own/i.test(chk.all) && /handover/i.test(chk.all), chk.all.slice(0, 200));
    check('the last step carries the work forward past handover',
      /improv/i.test(chk.last) && /support|change work/i.test(chk.last),
      chk.last.slice(0, 160));
    check('a call to action still offers the free diagnostic', chk.ctas >= 1, 'got ' + chk.ctas);
    /* ⚠️  A data-need POINTING AT AN OPTION THAT NO LONGER EXISTS SILENTLY
       DOES NOTHING. That has already happened once on this page. The "check"
       option was removed from the form, so any link still asking for it would
       land the visitor on an unselected dropdown with no error anywhere. */
    check('nothing still asks the form for the removed option',
      chk.staleCheckCtas === 0, 'got ' + chk.staleCheckCtas);

    /* Clicking the hero call to action must arrive at the form with the
       option already chosen. Without this the visitor is asked, immediately
       after saying what they want, to say it again. */
    await page.click('[data-need="diagnostic"]');
    await page.waitForTimeout(300);
    const selected = await page.evaluate(() => document.getElementById('cf-need').value);
    check('the call to action preselects the diagnostic',
      selected === 'diagnostic', 'select is "' + selected + '"');
    const opts = await page.evaluate(() =>
      [...document.querySelectorAll('#cf-need option')].map(o => o.value));
    check('every data-need on the page matches a real option',
      [...new Set(await page.evaluate(() =>
        [...document.querySelectorAll('[data-need]')].map(e => e.dataset.need)))]
        .every(n => opts.includes(n)), JSON.stringify(opts));
    await ctx.close();
  }

  /* =====================================================================
     THE DEVICE SWEEP
     ⚠️  THESE ARE NOT STYLE CHECKS. Every one of them is here because the
     page failed it on a real device size, measured rather than assumed:
     8px label text, 18px footer links, a phone with no navigation at all,
     and twice now a flex container eating the space between two words.
     They run at every width the design claims to support, plus 320px,
     which is the narrowest screen still in use.
     ===================================================================== */
  {
    const SWEEP = [320, 360, 390, 414, 430, 600, 700, 760, 768, 820, 900, 1024, 1280, 1440, 1512];
    for (const page_url of ['/', '/audit.html']) {
      const label = page_url === '/' ? 'the landing page' : 'the audit page';
      for (const w of SWEEP) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 860 } });
        const page = await ctx.newPage();
        await page.goto(BASE + page_url.replace(/^\//, ''), { waitUntil: 'networkidle' });
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            const b = el.getBoundingClientRect();
            if (!b.width && !b.height) continue;
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed' || cs.display === 'none') continue;
            const left = b.left + scrollX, right = b.right + scrollX;
            /* Skip-links and honeypots are parked thousands of pixels off
               screen on purpose. Anything merely a little too wide is not. */
            if (left < -1000) continue;
            if (right > vw + 1 || left < -1) {
              out.push(el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''));
            }
          }
          const small = [];
          for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="tab"]')) {
            const b = el.getBoundingClientRect();
            if (!b.width && !b.height) continue;
            if (getComputedStyle(el).display === 'none') continue;
            if (el.type === 'hidden') continue;
            /* A link inside a sentence is exempt from the target size rule,
               and padding one out would break the line it belongs to. */
            const p = el.parentElement;
            const inline = el.tagName === 'A' && p && /^(P|LI|SPAN|TD|LABEL|H1|H2|H3|B|STRONG)$/.test(p.tagName)
              && p.textContent.trim().length > el.textContent.trim().length + 12;
            if (inline) continue;
            if (b.height < 24 || b.width < 24) {
              small.push(el.tagName.toLowerCase() + ' "' + (el.textContent || '').trim().slice(0, 18) + '" ' + Math.round(b.width) + 'x' + Math.round(b.height));
            }
          }
          const tiny = new Set();
          for (const el of document.querySelectorAll('p,li,span,a,td,th,div,label,small,summary,b')) {
            if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
            if (el.textContent.trim().length < 8) continue;
            if (parseFloat(getComputedStyle(el).fontSize) < 10) {
              tiny.add(el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''));
            }
          }
          /* A flex or grid container collapses the whitespace between its
             children, so a label and its arrow run together in the text
             even though they look separated on screen. */
          const glued = [...document.querySelectorAll('a,li,p,span,b')]
            .map(e => e.textContent.replace(/\s+/g, ' ').trim())
            .filter(t => t.length < 80 && /[a-z](↗|→|✓)/i.test(t));
          return { vw, scrollW: document.documentElement.scrollWidth,
                   out: [...new Set(out)], small, tiny: [...tiny], glued: [...new Set(glued)] };
        });
        check('no sideways scrolling on ' + label + ' at ' + w + 'px',
          r.scrollW <= r.vw + 1, r.scrollW + ' > ' + r.vw);
        check('nothing hangs off the edge of ' + label + ' at ' + w + 'px',
          r.out.length === 0, r.out.join(', '));
        check('every standalone control is at least 24px on ' + label + ' at ' + w + 'px',
          r.small.length === 0, r.small.join(' | '));
        check('no text below 10px on ' + label + ' at ' + w + 'px',
          r.tiny.length === 0, r.tiny.join(', '));
        check('no label runs into its arrow on ' + label + ' at ' + w + 'px',
          r.glued.length === 0, r.glued.join(' | '));
        await ctx.close();
      }
    }
  }

  /* ------------------------------------------------------ The LinkedIn link
     ⚠️  THIS LINK WAS A PERSONAL PROFILE FOR WEEKS. Every other trace of a
     named individual was deliberately removed from this page, and this one
     survived because it is a button rather than a sentence. It now points at
     the company page, and these fail if it ever points back at a profile. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const li = await page.evaluate(() => {
      const a = document.querySelector('a[data-track="linkedin"]');
      const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(s => s.textContent).join(' ');
      return {
        href: a ? a.getAttribute('href') : null,
        text: a ? a.textContent.trim() : null,
        newTab: a ? (a.target === '_blank' && /noopener/.test(a.rel)) : false,
        profileLinksAnywhere: [...document.querySelectorAll('a[href]')]
          .map(x => x.getAttribute('href'))
          .filter(h => /linkedin\.com\/in\//i.test(h)),
        sameAs: /linkedin\.com\/company\/polisha-systems/.test(ld),
      };
    });
    check('the LinkedIn button points at the company page',
      !!li.href && /linkedin\.com\/company\//i.test(li.href), String(li.href));
    check('no link on the page reaches a personal LinkedIn profile',
      li.profileLinksAnywhere.length === 0, li.profileLinksAnywhere.join(', '));
    check('the button says follow, not connect, which is the verb for a person',
      /follow/i.test(li.text || '') && !/connect/i.test(li.text || ''), String(li.text));
    check('the LinkedIn button opens in a new tab safely', li.newTab, JSON.stringify(li));
    check('the structured data claims the company page as ours', li.sameAs, String(li.sameAs));
    await ctx.close();
  }

  /* --------------------------------------------------------------- The menu
     A phone had no navigation at all: below 700px every link was hidden and
     only the button survived, on a page eleven screens tall. These assert
     that the menu exists where it is needed, is absent where it is not, and
     that using it actually arrives somewhere a visitor can read. */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const shown = await page.evaluate(() => ({
      menu: getComputedStyle(document.querySelector('details.menu')).display !== 'none',
      links: getComputedStyle(document.querySelector('.nav-links')).display !== 'none',
      items: [...document.querySelectorAll('.menu-panel a')].map(a => a.getAttribute('href')),
      open: document.querySelector('details.menu').open,
    }));
    check('a phone has a menu', shown.menu, JSON.stringify(shown));
    check('the inline links are not also shown on a phone', !shown.links, JSON.stringify(shown));
    check('the menu starts closed', !shown.open, JSON.stringify(shown));
    check('the menu reaches every section of the page',
      shown.items.length >= 5 && shown.items.every(h => h && h.startsWith('#')), JSON.stringify(shown.items));
    check('every menu item lands on a real section', await page.evaluate(
      () => [...document.querySelectorAll('.menu-panel a')].every(a => document.querySelector(a.getAttribute('href')))));

    await page.click('details.menu > summary');
    await page.waitForTimeout(200);
    check('the menu opens', await page.evaluate(() => document.querySelector('details.menu').open));

    await page.click('.menu-panel a[href="#pricing"]');
    await page.waitForTimeout(1200);
    const landed = await page.evaluate(() => {
      const h = document.querySelector('header.shell').getBoundingClientRect();
      const t = document.getElementById('pricing').getBoundingClientRect();
      return { headerBottom: Math.round(h.bottom), targetTop: Math.round(t.top),
               stillOpen: document.querySelector('details.menu').open };
    });
    check('the menu closes once a link is used', !landed.stillOpen, JSON.stringify(landed));
    /* ⚠️  A STICKY HEADER WITHOUT scroll-margin HIDES EVERY HEADING IT JUMPS
       TO. The section must arrive BELOW the header, not behind it. */
    check('a menu jump lands clear of the sticky header',
      landed.targetTop >= landed.headerBottom, JSON.stringify(landed));
    await ctx.close();
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const desk = await page.evaluate(() => ({
      menu: getComputedStyle(document.querySelector('details.menu')).display !== 'none',
      links: getComputedStyle(document.querySelector('.nav-links')).display !== 'none',
      sticky: getComputedStyle(document.querySelector('header.shell')).position,
    }));
    check('the menu is not shown on a desktop', !desk.menu, JSON.stringify(desk));
    check('the inline links are shown on a desktop', desk.links, JSON.stringify(desk));
    check('the desktop header is left alone', desk.sticky !== 'sticky', JSON.stringify(desk));
    await ctx.close();
  }

  await browser.close();
  if (server) server.close();

  console.log(failures.length ? 'FAILURES:\n  ' + failures.join('\n  ') + '\n' : '');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
