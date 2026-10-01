/* ==========================================================================
   The Workflow Audit, driven in a real browser.

   audit.test.mjs covers the arithmetic and the endpoint. This covers the part
   a visitor actually touches: twelve steps, a result, and the capture. It
   also pins the two behaviours that are easy to "improve" away:

     - the lightest possible answers must still reach "we would not build you
       a system yet", with no call to action attached to it;
     - a multi-choice question must be answerable as "none of these". Without
       that, the people whose honest answer is nothing cannot finish, and they
       are exactly the people the honest verdict exists for.

     cd tests && node audit-page.test.js
     SITE=https://systems.getpolisha.com node audit-page.test.js
   ========================================================================== */
const { chromium } = require('playwright');
const http=require('http'), fs=require('fs'), path=require('path');
const ROOT=require('path').resolve(__dirname,'..');
const T={'.html':'text/html','.css':'text/css','.js':'text/javascript','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2'};
const srv=http.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);
  if(u==='/')u='/index.html'; if(u==='/audit')u='/audit.html';
  const f=path.join(ROOT,u); if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){s.writeHead(404);return s.end('nf');}
  s.writeHead(200,{'content-type':T[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(s);});
(async()=>{
  const SITE = process.env.SITE ? process.env.SITE.replace(/\/$/,'') : null;
  if (!SITE) await new Promise(r=>srv.listen(0,r));
  const base = SITE || ('http://127.0.0.1:'+srv.address().port);
  console.log('testing ' + base + '\n');
  const b=await chromium.launch();
  let pass=0, fail=0;
  const check=(n,c,d)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(d?'  -> '+d:''));} };

  const ctx=await b.newContext({viewport:{width:1280,height:900}});
  const pg=await ctx.newPage();
  const errs=[]; pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  pg.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
  await pg.route('**/api/audit', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"hours":16}'}));
  await pg.goto(base+'/audit',{waitUntil:'networkidle'});

  check('the audit page loads', (await pg.title()).includes('Workflow Audit'));
  /* The hook is an h2 now: the h1 is the persistent, visually hidden page
     title, so that hiding the intro cannot leave the page headingless. */
  check('the intro promises the number',
    /hours a week/i.test(await pg.innerText('.audit-hook')));
  check('a level one heading survives the intro being hidden',
    (await pg.$$('h1')).length === 1);
  check('the quiz is hidden until started', await pg.isHidden('#audit-quiz'));

  await pg.click('#audit-start');
  check('starting reveals the first question', await pg.isVisible('#audit-quiz'));
  check('progress says 1 of 12', /1 of 12/i.test(await pg.innerText('#audit-count')));

  // Answer all twelve, choosing the heaviest option each time.
  for (let i=0;i<12;i++){
    const multi = await pg.evaluate(()=>!!document.querySelector('#audit-options input[type=checkbox]'));
    if (multi) {
      const boxes = await pg.$$('#audit-options input');
      for (const bx of boxes.slice(0,3)) await bx.check();
      await pg.click('#audit-next');
    } else {
      const opts = await pg.$$('#audit-options input');
      await opts[opts.length-1].check();
    }
    await pg.waitForTimeout(260);
  }

  await pg.waitForSelector('#audit-result:not([hidden])',{timeout:5000});
  check('the result appears after twelve answers', await pg.isVisible('#audit-result'));
  const hours = await pg.innerText('#audit-hours');
  check('a number is shown', /^\d+(\.\d)?$/.test(hours), hours);
  check('the working is shown', (await pg.$$('#audit-parts tr')).length === 4);
  check('opportunities are ranked', (await pg.$$('#audit-opps li')).length > 0);
  check('nothing on the result suggests a machine doing a person\'s job',
    !/stay human|in the loop|\bassistant\b/i.test(await pg.innerText('body')));
  check('a verdict is given', (await pg.innerText('#audit-verdict-head')).length > 10);

  // the capture
  await pg.fill('#au-name','Test Person');
  await pg.fill('#au-email','p@example.com');
  await pg.click('#au-submit');
  await pg.waitForTimeout(400);
  check('the capture reports success',
    /Sent/.test(await pg.innerText('#au-status')), await pg.innerText('#au-status'));

  check('no console or page errors', errs.length===0, errs.join(' | '));
  {
    const body = await pg.innerText('body');
    check('the result page never names artificial intelligence',
      !/\bAI\b/.test(body), (body.match(/.{30}\bAI\b.{30}/) || [''])[0]);
  }

  // the honest low path
  const pg2=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
  await pg2.goto(base+'/audit',{waitUntil:'networkidle'});
  await pg2.click('#audit-start');
  for (let i=0;i<12;i++){
    const multi = await pg2.evaluate(()=>!!document.querySelector('#audit-options input[type=checkbox]'));
    if (multi) {
      const none = await pg2.$('#audit-options input[value="none"], #audit-options input[value="other"]');
      if (none) await none.check(); else { const o=await pg2.$$('#audit-options input'); await o[0].check(); }
      await pg2.click('#audit-next');
    }
    else { const o=await pg2.$$('#audit-options input'); await o[0].check(); }
    await pg2.waitForTimeout(240);
  }
  await pg2.waitForSelector('#audit-result:not([hidden])',{timeout:5000});
  const verdict = await pg2.innerText('#audit-verdict-head');
  check('the lightest answers are told not to build yet',
    /would not build you a system yet/i.test(verdict), verdict);
  check('no sales button is shown on that verdict',
    (await pg2.$$('#audit-verdict-actions a')).length === 0);

  // multi-question "Next" with nothing chosen must be refused
  const pg3=await (await b.newContext()).newPage();
  await pg3.goto(base+'/audit',{waitUntil:'networkidle'});
  await pg3.click('#audit-start');
  await pg3.click('#audit-next');
  check('an unanswered single question refuses to advance',
    await pg3.isVisible('#audit-error') && /1 of 12/i.test(await pg3.innerText('#audit-count')));

  // the site links to it
  const pg4=await (await b.newContext()).newPage();
  await pg4.goto(base+'/',{waitUntil:'networkidle'});
  const links = await pg4.$$eval('a[href="/audit"]', as=>as.length);
  check('the main site links to the audit', links >= 2, 'found '+links);

  console.log('\n'+pass+' passed, '+fail+' failed');
  // Accessibility, on the page that now carries the first conversion.
  {
    const ax=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
    await ax.goto(base+'/audit',{waitUntil:'networkidle'});
    await ax.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const intro=await ax.evaluate(async()=>await window.axe.run(document,{resultTypes:['violations']}));
    check('no accessibility violations on the intro', intro.violations.length===0,
      intro.violations.map(v=>v.id).join(' '));
    await ax.click('#audit-start'); await ax.waitForTimeout(250);
    const quiz=await ax.evaluate(async()=>await window.axe.run(document,{resultTypes:['violations']}));
    check('no accessibility violations mid-question', quiz.violations.length===0,
      quiz.violations.map(v=>v.id).join(' '));
  }

  console.log('\n'+pass+' passed, '+fail+' failed');
  await b.close(); if(!SITE) srv.close();
  process.exit(fail?1:0);
})();
