import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// Real source components with isolated settings/session transport; no AI or X writes.
const folder=path.resolve('artifacts/review-pacing-acceptance');
await fs.mkdir(folder,{recursive:true});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});
const checks=[],errors=[];
try{
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:1280,height:900});
  await page.goto('http://127.0.0.1:5186/tests/fixtures/fan-review-settings-preview.html');
  await page.waitForFunction(()=>globalThis.__reviewFixture?.ready);
  await page.evaluate(()=>{__reviewFixture.settings.fanTagging={provider:'codex',botId:'fixture-initial',prompt:'保留审核规则',batchSize:30,intervalSeconds:3};});
  const open=async()=>{await page.click('#open-fans');await page.waitForSelector('#review-fanTagging-interval-max');};
  await open();
  assert.equal(await page.$eval('#review-fanTagging-batch',e=>e.value),'30');
  assert.equal(await page.$eval('#review-fanTagging-interval-max',e=>e.value),'8');checks.push('legacy size retained and range visible');
  for(const [selector,value]of [['#review-fanTagging-interval','5'],['#review-fanTagging-interval-max','12']])await page.$eval(selector,(e,value)=>{e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>document.querySelector('.follow-review-notice')?.textContent.includes('设置已保存'));
  await page.keyboard.press('Escape');await open();
  assert.equal(await page.$eval('#review-fanTagging-interval',e=>e.value),'5');
  assert.equal(await page.$eval('#review-fanTagging-interval-max',e=>e.value),'12');
  assert.equal(await page.$eval('#review-fanTagging-prompt',e=>e.value),'保留审核规则');checks.push('save close reopen preserves range and prompt');
  await page.focus('.follow-review-interval .info-tip');await page.waitForSelector('[role=tooltip]');
  await page.waitForFunction(()=>document.querySelector('[role=tooltip]')?.getBoundingClientRect().width>200);
  assert.match(await page.$eval('[role=tooltip]',e=>e.textContent),/随机等待/);
  await page.screenshot({path:path.join(folder,'range-desktop-tip.png')});checks.push('keyboard interval tip is readable');
  await page.focus('#saveFollowReviewSettings');await page.waitForFunction(()=>document.querySelector('[role=tooltip]')?.textContent==='保存设置');
  assert.equal(await page.$eval('#saveFollowReviewSettings svg',e=>e.getAttribute('aria-hidden')),'true');checks.push('shared icon and keyboard tooltip');
  await page.focus('#review-fanTagging-interval-max');
  await page.$eval('#review-fanTagging-interval-max',e=>{e.value='2';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>document.querySelector('.follow-review-error')?.textContent.includes('间隔'));
  assert.equal(await page.evaluate(()=>__reviewFixture.settings.fanTagging.intervalMaxSeconds),12);checks.push('invalid range preserves persisted settings and draft');
  await page.$eval('#review-fanTagging-interval-max',e=>{e.value='12';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#saveFollowReviewSettings');await page.waitForFunction(()=>document.querySelector('.follow-review-notice')?.textContent.includes('设置已保存'));
  for(const [width,height,language,name]of [[390,844,'zh-CN','range-narrow'],[640,450,'zh-CN','range-equivalent-200-percent'],[390,844,'en','range-english-narrow']]){
    await page.setViewport({width,height});await page.evaluate(language=>__reviewFixture.locale(language),language);
    await page.focus('#review-fanTagging-interval-max');await page.$eval('#review-fanTagging-interval-max',e=>e.scrollIntoView({block:'center'}));
    assert.equal(await page.evaluate(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;}),true);
    await page.screenshot({path:path.join(folder,name+'.png')});checks.push(name+' contained with accessible inputs');
  }
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{__reviewFixture.failLoad=true;});await page.click('#open-fans');
  await page.waitForSelector('.follow-review-load-error');assert.equal(await page.$eval('#saveFollowReviewSettings',e=>e.disabled),true);checks.push('read failure cannot overwrite saved settings');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({checks,errors,note:'Source Vue settings rendered in isolated Chrome; no live account changes.'},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,folder}));
}finally{await browser.close();}
