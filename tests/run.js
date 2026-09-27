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
        hiringLinks: hiring ? [...hiring.querySelectorAll('a')].map(a => a.getAttribute('href')) : [],
        // A price is visible without scrolling past the hero.
        priceInHero: !!price && price.getBoundingClientRect().top < heroBottom + 1,
        priceText: price ? price.textContent : '',
      };
    });

    check('walkthrough section exists', r.walkthroughPresent);
    check('walkthrough stays hidden while no file is named', r.walkthroughHidden && r.walkthroughDeclaresNoFile);
    check('hidden walkthrough loads no media', r.walkthroughHasNoSource && r.walkthroughHasNoPoster);
    check('hiring section exists', r.hiringPresent);
    check('hiring offers LinkedIn and email',
      r.hiringLinks.some(h => /linkedin\.com/.test(h || '')) &&
      r.hiringLinks.some(h => /^mailto:/.test(h || '')),
      r.hiringLinks.join(' | '));
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
    check('announcement names website work', /website/i.test(r.notice), r.notice);
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
    const heroFigures = r.heroPrice.match(/CA\$[\d,]+/g) || [];
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
    check('an operations group exists', r.priceGroups.some(g => /operations/i.test(g)),
      r.priceGroups.join(' | '));
    check('an after-launch group exists', r.priceGroups.some(g => /after launch/i.test(g)),
      r.priceGroups.join(' | '));

    const priced = (t) => r.priceRows.find(x => new RegExp(t, 'i').test(x.title));
    const landing = priced('landing page');
    const site = priced('business site');
    const custom = priced('custom functionality');
    const diagnostic = priced('diagnostic');
    const build = priced('first-phase build');
    const full = priced('full operations system');
    const care = priced('care plan');
    const change = priced('change work');

    check('every priced row names an amount',
      r.priceRows.length >= 8 && r.priceRows.every(x => /CA\$\s?\d/.test(x.amount)),
      r.priceRows.map(x => x.title + '=' + x.amount).join(' | '));

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
    check('a first phase is reachable at CA$3,500-6,500',
      !!build && /CA\$3,500.6,500/.test(build.amount), build ? build.amount : 'missing');
    check('the ceiling for a full system still exists',
      !!full && /^from CA\$9,000$/.test(full.amount), full ? full.amount : 'missing');
    check('the first phase is priced below the full system',
      !!build && !!full, 'both rows must be present');
    // "Fixed scope in writing" told a buyer nothing about what arrives.
    check('the build says what is actually delivered',
      !!build && /handover/i.test(build.detail) && /production/i.test(build.detail),
      build ? build.detail : '');

    // The retainer is split, because one blended number set the wrong
    // expectation in both directions.
    check('hosting and change work are priced separately',
      !!care && !!change && care.amount !== change.amount,
      (care ? care.amount : '?') + ' / ' + (change ? change.amount : '?'));
    check('the care plan is CA$120/mo', !!care && /CA\$120\/mo/.test(care.amount),
      care ? care.amount : 'missing');

    /* Every superseded number, anywhere on the page. Each of these was live at
       some point, and each contradicted something else while it was. */
    for (const stale of ['CA\\$2,500', 'CA\\$1,800', 'CA\\$4,500', 'CA\\$6,000', 'CA\\$500.900', 'CA\\$250/mo', 'CA\\$900/mo']) {
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
    check('the launch offer is a percentage, not a fixed price',
      /%/.test(r.founding) && !/CA\$/.test(r.founding), r.founding.slice(0, 200));
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
