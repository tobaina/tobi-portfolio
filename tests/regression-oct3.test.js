/* ==========================================================================
   Regressions reported from the live site on 3 October 2026.

   1. A single-choice audit question advanced by itself while the Next button
      was still on screen. The click aimed at Next landed on an option of the
      question that had just appeared, so an answer nobody chose was carried
      into the score. The number the tool reports has to be the visitor's own
      or the tool is worthless, so this is the serious one.

   2. Pressing Enter inside a dropdown submitted the whole contact form, and
      "What do you need help with?" was never enforced, so enquiries arrived
      with no category on them.

   Both tests are written to fail against the old code. run.js proves that by
   running them once against the pre-fix files.
   ========================================================================== */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
                '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/audit') url = '/audit.html';
      if (url === '/') url = '/index.html';
      const file = path.join(root, url);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function run(root) {
  const { server, port } = await serve(root);
  const base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // ---------------------------------------------------------------- audit
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/audit', { waitUntil: 'domcontentloaded' });
    await page.click('#audit-start');
    await page.waitForSelector('.audit-option');

    // where the Next button sits while question 1 is on screen
    const nextBox = await page.evaluate(() => {
      const b = document.getElementById('audit-next');
      const r = b.getBoundingClientRect();
      return { hidden: b.hidden, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    });
    check('the Next button is not shown on a single-choice question',
      nextBox.hidden === true, 'hidden=' + nextBox.hidden);

    const q1 = await page.textContent('#audit-q-text');
    // answer question one with the pointer, the way a visitor does
    await page.locator('.audit-option').first().click();
    await page.waitForFunction(
      (prev) => document.getElementById('audit-q-text').textContent !== prev, q1, { timeout: 4000 });
    check('a single-choice answer still moves the visitor on by itself', true);

    // the second click, aimed at where Next was a moment ago
    if (nextBox.w > 0) {
      await page.mouse.click(nextBox.x, nextBox.y);
    } else {
      // the button was already hidden, so aim at the same spot the old
      // layout put it: just under the options
      const box = await page.locator('#audit-options').boundingBox();
      await page.mouse.click(box.x + 60, box.y + box.height + 28);
    }
    await page.waitForTimeout(600);

    const afterStray = await page.evaluate(() => ({
      question: document.getElementById('audit-count').textContent,
      ticked: Array.from(document.querySelectorAll('#audit-options input'))
        .filter((i) => i.checked).map((i) => i.value)
    }));
    check('a stray second click does not answer the question that just appeared',
      afterStray.ticked.length === 0,
      'ticked ' + JSON.stringify(afterStray.ticked) + ' on ' + afterStray.question);
    check('a stray second click does not skip a question',
      /Question 2 of/.test(afterStray.question), afterStray.question);

    // Question 2 is the multi-choice one, which is exactly where the stray
    // click was landing. A multi-choice question cannot move on by itself,
    // so there the Next button must be present.
    const nextOnMulti = await page.evaluate(() => document.getElementById('audit-next').hidden);
    check('the Next button is shown on a multi-choice question, which needs it',
      nextOnMulti === false, 'hidden=' + nextOnMulti);

    // answer the multi-choice question and move on with Next
    await page.locator('.audit-option').first().click();
    await page.click('#audit-next');
    await page.waitForFunction(
      () => /Question 3 of/.test(document.getElementById('audit-count').textContent), null, { timeout: 4000 });

    // a double click on a single-choice option must not answer the next one
    const q3 = await page.textContent('#audit-q-text');
    await page.locator('.audit-option').first().dblclick();
    await page.waitForFunction(
      (prev) => document.getElementById('audit-q-text').textContent !== prev, q3, { timeout: 4000 });
    await page.waitForTimeout(700);
    const afterDouble = await page.evaluate(() => ({
      question: document.getElementById('audit-count').textContent,
      ticked: Array.from(document.querySelectorAll('#audit-options input')).filter((i) => i.checked).length
    }));
    check('a double click does not answer the following question',
      afterDouble.ticked === 0 && /Question 4 of/.test(afterDouble.question),
      afterDouble.question + ' ticked=' + afterDouble.ticked);

    await page.close();
  }

  // ------------------------------------------------- audit, keyboard user
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base + '/audit', { waitUntil: 'domcontentloaded' });
    await page.click('#audit-start');
    await page.waitForSelector('.audit-option');
    const before = await page.textContent('#audit-count');
    await page.locator('#audit-options input').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      count: document.getElementById('audit-count').textContent,
      nextHidden: document.getElementById('audit-next').hidden
    }));
    check('arrowing through the options does not throw a keyboard user forward',
      after.count === before, before + ' -> ' + after.count);
    check('the Next button appears once someone is using the keyboard',
      after.nextHidden === false, 'hidden=' + after.nextHidden);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const moved = await page.textContent('#audit-count');
    check('a keyboard user can still move on', /Question 2 of/.test(moved), moved);
    await page.close();
  }

  // -------------------------------------------------------- contact form
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let posted = 0;
    await page.route('**/api/contact', (route) => {
      posted += 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

    await page.fill('#cf-name', 'Test Person');
    await page.fill('#cf-email', 'test@example.com');
    await page.fill('#cf-message', 'We have a spreadsheet problem and would like a look at it.');

    // The exact accident. Enter inside a dropdown submits the form on macOS
    // browsers; headless Chromium swallows the key, so the implicit
    // submission it causes is raised directly as well. Either way nothing
    // uncategorised may reach the inbox.
    await page.locator('#cf-need').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('Enter in the dropdown sends nothing', posted === 0, 'posted ' + posted + ' time(s)');

    await page.evaluate(() => document.getElementById('contact-form').requestSubmit());
    await page.waitForTimeout(500);
    check('an implicit submit with no category is refused',
      posted === 0, 'posted ' + posted + ' time(s)');

    const err = await page.evaluate(() => {
      const slot = document.getElementById('cf-need-error');
      return { hidden: slot ? slot.hidden : null, text: slot ? slot.textContent : null,
               invalid: document.getElementById('cf-need').getAttribute('aria-invalid'),
               focused: document.activeElement && document.activeElement.id };
    });
    check('the dropdown is marked as the thing that needs answering',
      err.hidden === false && /Not sure yet/.test(err.text || ''), JSON.stringify(err));
    check('the dropdown is flagged to assistive technology', err.invalid === 'true', String(err.invalid));
    check('the visitor is put back in the field that stopped them',
      err.focused === 'cf-need', String(err.focused));

    // clicking Send with it still unanswered must be stopped the same way
    await page.click('#cf-submit');
    await page.waitForTimeout(400);
    check('pressing Send with no category is stopped too', posted === 0, 'posted ' + posted);

    // and once answered it goes
    await page.selectOption('#cf-need', 'unsure');
    const cleared = await page.evaluate(() => document.getElementById('cf-need-error').hidden);
    check('choosing an option clears the error', cleared === true, 'hidden=' + cleared);
    await page.click('#cf-submit');
    await page.waitForTimeout(800);
    check('a complete enquiry still sends', posted === 1, 'posted ' + posted);

    await page.close();
  }

  await browser.close();
  server.close();
  return results;
}

module.exports = { run };

if (require.main === module) {
  run(ROOT).then((results) => {
    const bad = results.filter((r) => !r.ok);
    results.forEach((r) => console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.ok ? '' : '  >> ' + r.detail)));
    console.log('\npassed ' + (results.length - bad.length) + ' of ' + results.length);
    process.exit(bad.length ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
