const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8000/';
const output = process.argv[3] || 'browser-results.json';
const report = {base, startedAt:new Date().toISOString(), checks:{}, pageErrors:[], httpErrors:[]};
const errors = report.pageErrors, httpErrors = report.httpErrors;
let browser;
async function makePage(options={}) {
  const page = await browser.newPage({viewport:{width:1440,height:900}, ...options});
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if(response.status()>=400) httpErrors.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => {
    const AudioConstructor=window.Audio;
    window.Audio=new Proxy(AudioConstructor,{construct(target,args){ const audio=new target(...args); window.__checkedAudio=audio; return audio; }});
  });
  return page;
}
async function route(page,id,view='reading') {
  await page.goto(base+`#lesson/${id}/${view}`);
  await page.waitForFunction(({id,view})=>document.querySelector('.tab.active')?.getAttribute('href')===`#lesson/${id}/${view}`,{id,view});
}
async function closeAudio(page) {
  await page.locator('[data-action="player-close"]').click();
  assert(await page.locator('#player').evaluate(el=>el.hidden));
  assert(await page.evaluate(()=>window.__checkedAudio.paused && !window.__checkedAudio.getAttribute('src')));
}
async function routesAndLayout() {
  const page=await makePage();
  try {
    let count=0;
    for(const [width,height] of [[1440,900],[1024,768],[768,1024],[390,844],[360,740],[844,390]]) {
      await page.setViewportSize({width,height});
      for(let id=1;id<=14;id++) for(const view of ['reading','words']) {
        await route(page,id,view);
        const state=await page.evaluate(({id,view})=>({
          lines:document.querySelectorAll('.sentence').length,
          expected:DRAMA_COURSE.find(l=>l.id===id)[view].length,
          tabs:document.querySelectorAll('.tab').length,
          lessons:document.querySelectorAll('.lesson-link').length,
          missing:document.querySelectorAll('.missing-audio').length,
          overflow:document.documentElement.scrollWidth>innerWidth,
          removed:[...document.querySelectorAll('#main a')].filter(a=>/\/(grammar|practice|homework|pronunciation)(?:\/|$)/.test(a.hash)).length
        }),{id,view});
        assert.equal(state.lines,state.expected);
        assert.equal(state.tabs,2); assert.equal(state.lessons,14); assert.equal(state.missing,0); assert.equal(state.removed,0);
        assert.equal(state.overflow,false,`overflow at ${width}x${height} ${id}/${view}`);
        count++;
      }
      console.log(`Layout/routes PASS ${width}x${height}`);
    }
    report.checks.routeViewportCombinations=count;
  } finally {await page.close();}
}
async function allAudio() {
  const page=await makePage();
  try {
    await route(page,1);
    const result=await page.evaluate(async()=>{
      const context=new AudioContext();let count=0;let versions=0;
      try {
        const items=DRAMA_COURSE.flatMap(l=>[...l.reading,...l.words]);
        for(let index=0;index<items.length;index+=4) await Promise.all(items.slice(index,index+4).map(async item=>{
          const entry=DRAMA_ALIGNMENT[item.id];
          const url=item.audio+(entry.audioVersion?'?v='+entry.audioVersion:'');
          const response=await fetch(url);
          if(!response.ok) throw new Error('audio HTTP '+response.status+' '+url);
          const bytes=await response.arrayBuffer();
          if(entry.audioVersion) {
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
            if(!hash.startsWith(entry.audioVersion)) throw new Error('Stale audio '+item.id);
            versions++;
          }
          const decoded=await context.decodeAudioData(bytes.slice(0));
          if(!(decoded.duration>0)) throw new Error('empty '+item.id);
          count++;
        }));
        return {count,versions};
      } finally {await context.close();}
    });
    assert.equal(result.count,178);assert.equal(result.versions,64);
    report.checks.decodedAudio=result.count;report.checks.replacedAudioHashes=result.versions;
    let playback=0, alignedWords=0;
    for(let id=1;id<=14;id++) for(const view of ['reading','words']) {
      await route(page,id,view);
      const count=await page.locator('.sentence').count();
      for(let index=0;index<count;index++) {
        await page.evaluate(() => {
          window.__sawHighlight = false;
          if (!window.__highlightObserver) {
            window.__highlightObserver = new MutationObserver(() => {
              if (document.querySelector('.current-word')) window.__sawHighlight = true;
            });
            window.__highlightObserver.observe(document.querySelector('#main'), {attributes:true,subtree:true,attributeFilter:['class']});
          }
        });
        await page.locator(`[data-action="play-line"][data-index="${index}"]`).click();
        await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused && !window.__checkedAudio.error);
        await page.waitForFunction(() => window.__sawHighlight);
        const metadata=await page.evaluate(({id,view,index})=>{
          const item=DRAMA_COURSE.find(l=>l.id===id)[view][index];
          const entry=DRAMA_ALIGNMENT[item.id];
          return {id:item.id,revision:entry.audioVersion||null,url:window.__checkedAudio.src};
        },{id,view,index});
        if(metadata.revision) {
          assert.equal(new URL(metadata.url).searchParams.get('v'),metadata.revision);
          await page.locator('[data-action="player-toggle"]').click();
          const checked=await page.evaluate(async({id,index})=>{
            const audio=window.__checkedAudio;
            if(!audio.paused) throw new Error('pause did not pause');
            let count=0;
            for(const [wordIndex,word] of DRAMA_ALIGNMENT[id].words.entries()) {
              if(word.punctuation) continue;
              await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(new Error('seek timeout')),3000);
                audio.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});
                audio.currentTime=(word.start+word.end)/2;
              });
              const selected=document.querySelector('.current-word');
              if(selected?.dataset.word!==String(wordIndex) || selected.closest('.sentence').dataset.segment!==String(index)) throw new Error('wrong timed word '+id+' '+wordIndex);
              count++;
            }
            return count;
          },{id:metadata.id,index});
          alignedWords+=checked;
        }
        await closeAudio(page);
        playback++;
        report.checks.individualAudioPlayback=playback;
        report.checks.newTimedWords=alignedWords;
      }
      console.log(`Audio playback PASS lesson ${id} ${view} (${count})`);
    }
    report.checks.individualAudioPlayback=playback;
    report.checks.newTimedWords=alignedWords;
    assert.equal(playback,178);
  } finally {await page.close();}
}
async function controls() {
  const page=await makePage();
  try {
    await route(page,2);
    for(const key of ['py','jp']) for(const value of ['false','true']) {
      await page.locator(`[data-pref="${key}"][data-value="${value}"]`).click();
      assert.equal(await page.locator('body').evaluate((el,key)=>el.classList.contains('hide-'+key),key),value==='false');
      await page.reload();await page.locator('.sentence').first().waitFor();
      assert.equal(await page.locator(`[data-pref="${key}"][data-value="${value}"]`).getAttribute('aria-pressed'),'true');
    }
    for(const speed of [0.65,0.8,1,1.2,1.5]) {
      await page.locator(`[data-pref="speed"][data-value="${speed}"]`).click();
      await page.locator('[data-action="play-line"]').first().click();
      await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
      assert.equal(await page.evaluate(()=>window.__checkedAudio.playbackRate),speed);
      await closeAudio(page);
      await page.reload(); await page.locator('.sentence').first().waitFor();
      assert.equal(await page.locator(`[data-pref="speed"][data-value="${speed}"]`).getAttribute('aria-pressed'),'true');
    }
    await page.locator('[data-pref="speed"][data-value="0.65"]').click();
    await page.locator('[data-action="play-line"]').first().click();
    await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.05);
    await page.locator('[data-action="player-toggle"]').click();
    const frozen=await page.evaluate(()=>window.__checkedAudio.currentTime);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>window.__checkedAudio.currentTime),frozen);
    await page.locator('[data-action="player-toggle"]').click();
    await page.waitForFunction(t=>window.__checkedAudio.currentTime>t+0.03,frozen);
    for(const speed of [0.8,1,1.2,1.5,0.65]) {
      await page.locator('[data-action="speed-cycle"]').click();
      assert.equal(await page.evaluate(()=>window.__checkedAudio.playbackRate),speed);
      assert.equal(await page.locator(`[data-pref="speed"][data-value="${speed}"]`).getAttribute('aria-pressed'),'true');
    }
    await page.locator('[data-action="player-repeat"]').click();
    assert.equal(await page.locator('.sentence.is-playing').getAttribute('data-segment'),'0');
    assert((await page.evaluate(()=>window.__checkedAudio.currentTime))<0.4);
    await page.locator('[data-action="player-next"]').click();
    assert.equal(await page.locator('.sentence.is-playing').getAttribute('data-segment'),'1');
    await closeAudio(page);
    await page.locator('[data-action="play-line"]').first().click();
    await page.locator('.tab[href="#lesson/2/words"]').click();
    await page.waitForFunction(()=>document.querySelector('.tab.active')?.getAttribute('href')==='#lesson/2/words');
    assert(await page.locator('#player').evaluate(el=>el.hidden));
    assert(await page.evaluate(()=>window.__checkedAudio.paused));
    await route(page,1);
    await page.locator('[data-pref="speed"][data-value="1.5"]').click();
    await page.evaluate(()=>{
      window.__continuous=[];
      window.__observedPlayer=new MutationObserver(()=>{
        const index=document.querySelector('.sentence.is-playing')?.dataset.segment;
        if(index!==undefined && window.__continuous.at(-1)!==index)window.__continuous.push(index);
      });
      window.__observedPlayer.observe(document.querySelector('#player'),{childList:true,subtree:true});
    });
    await page.locator('[data-action="play-all"]').click();
    await page.waitForFunction(()=>window.__checkedAudio.ended && document.querySelector('.sentence.is-playing')?.dataset.segment==='3',null,{timeout:20000});
    assert.deepEqual(await page.evaluate(()=>window.__continuous),['0','1','2','3']);
    assert(await page.locator('[data-action="player-next"]').isDisabled());
    await closeAudio(page);
    for(const removed of ['homework','grammar','practice','practice/2','pronunciation']) {
      await page.goto(base+'#lesson/5/'+removed);
      await page.waitForURL('**/#lesson/5/reading');
    }
    await page.goto(base+'#lesson/999/reading');
    await page.waitForFunction(()=>document.querySelector('.tab.active')?.getAttribute('href')==='#lesson/1/reading');
    await page.locator('.next-step a').click();
    await page.waitForURL('**/#lesson/1/words');
    await page.locator('.next-step a').click();
    await page.waitForURL('**/#lesson/1/reading');
    await page.locator('.bottom-nav a').click();await page.waitForURL('**/#lesson/2/reading');
    await page.locator('.bottom-nav a').first().click();await page.waitForURL('**/#lesson/1/reading');
    await page.locator('[data-action="help"]').click();
    assert(await page.locator('#help-dialog').evaluate(el=>el.open));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#help-dialog').evaluate(el=>el.open),false);
    await page.locator('[data-action="help"]').click();
    await page.locator('[data-action="help-close"]').last().click();
    assert.equal(await page.locator('#help-dialog').evaluate(el=>el.open),false);
    await page.locator('.skip').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'main');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#menu').click();assert.equal(await page.locator('#menu').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#menu').getAttribute('aria-expanded'),'false');
    await page.locator('#menu').click();await page.locator('.lesson-link[href="#lesson/14/reading"]').click();
    await page.waitForURL('**/#lesson/14/reading');assert.equal(await page.locator('#menu').getAttribute('aria-expanded'),'false');
    await page.locator('#menu').click();await page.locator('#veil').click({position:{x:385,y:400}});
    assert.equal(await page.locator('#menu').getAttribute('aria-expanded'),'false');
    report.checks.controls={preferencesPersist:true,allFiveSpeeds:true,inPlaySpeedCycle:true,pauseResume:true,repeat:true,next:true,close:true,routeStopsAudio:true,continuousWholeLesson:true,lastNextDisabled:true,legacyRoutes:5,invalidLessonFallback:true,tabsAndLessonNavigation:true,helpAndEscape:true,skipLink:true,mobileMenuAndVeil:true};
    console.log('Player, navigation, preferences, help and mobile controls PASS');
  } finally {await page.close();}
  const fallback=await makePage();
  try {
    await fallback.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}});});
    await route(fallback,1);
    await fallback.locator('[data-pref="py"][data-value="false"]').click();
    assert(await fallback.locator('body').evaluate(el=>el.classList.contains('hide-py')));
    await fallback.locator('[data-action="play-line"]').first().click();
    await fallback.locator('.current-word').first().waitFor();
    report.checks.blockedStorageFallback=true;
  } finally {await fallback.close();}
}
(async()=>{
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),headless:true});
  try {
    const suites=await Promise.allSettled([routesAndLayout(),allAudio(),controls()]);
    const failures=suites.filter(s=>s.status==='rejected').map(s=>s.reason.stack||String(s.reason));
    assert.deepEqual(failures,[]);
    assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
    report.status='PASS';
  } finally {
    await browser.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{report.status='FAIL';report.error=error.stack;fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.error(error);process.exit(1);});
