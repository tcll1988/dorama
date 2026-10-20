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
      for(let id=1;id<=14;id++) for(const view of ['reading','words','grammar']) {
        await route(page,id,view);
        if(view==='grammar') await page.locator('.grammar-explanation').evaluateAll(items=>items.forEach(item=>item.open=true));
        const state=await page.evaluate(({id,view})=>({
          lines:document.querySelectorAll('.sentence').length,
          expected:DRAMA.itemsFor(DRAMA_COURSE.find(l=>l.id===id),view).length,
          tabs:document.querySelectorAll('.tab').length,
          lessons:document.querySelectorAll('.lesson-link').length,
          missing:document.querySelectorAll('.missing-audio').length,
          overflow:document.documentElement.scrollWidth>innerWidth,
          removed:[...document.querySelectorAll('#main a')].filter(a=>/\/(practice|homework|pronunciation)(?:\/|$)/.test(a.hash)).length
        }),{id,view});
        assert.equal(state.lines,state.expected);
        assert.equal(state.tabs,3); assert.equal(state.lessons,14); assert.equal(state.missing,0); assert.equal(state.removed,0);
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
        const items=Object.values(DRAMA_VOICE_DATA.entries).flatMap(choices=>Object.values(choices));
        for(let index=0;index<items.length;index+=4) await Promise.all(items.slice(index,index+4).map(async item=>{
          const url=item.audio+'?v='+item.audioVersion;
          const response=await fetch(url);
          if(!response.ok) throw new Error('audio HTTP '+response.status+' '+url);
          const bytes=await response.arrayBuffer();
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
          if(hash!==item.sha256 || !hash.startsWith(item.audioVersion)) throw new Error('Stale audio '+item.audio);
          versions++;
          const decoded=await context.decodeAudioData(bytes.slice(0));
          if(!(decoded.duration>0) || Math.abs(decoded.duration-item.duration)>0.15) throw new Error('wrong duration '+item.audio);
          count++;
        }));
        return {count,versions};
      } finally {await context.close();}
    });
    assert.equal(result.count,586);assert.equal(result.versions,586);
    report.checks.decodedAudio=result.count;report.checks.replacedAudioHashes=result.versions;
    let playback=0, alignedWords=0;
    for(let id=1;id<=14;id++) for(const view of ['reading','words','grammar']) for(const voice of view==='reading'?['characters']:['female','male']) {
      await route(page,id,view);
      if(voice!=='characters') await page.locator(`[data-pref="voice"][data-value="${voice}"]`).click();
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
          const item=DRAMA.itemsFor(DRAMA_COURSE.find(l=>l.id===id),view)[index];
          const entry=DRAMA.audioEntry(item);
          return {id:item.id,revision:entry.audioVersion,path:entry.audio,words:entry.words,url:window.__checkedAudio.src};
        },{id,view,index});
        assert(new URL(metadata.url).pathname.endsWith('/'+metadata.path));
        if(metadata.revision) {
          assert.equal(new URL(metadata.url).searchParams.get('v'),metadata.revision);
          await page.locator('[data-action="player-toggle"]').click();
          const checked=await page.evaluate(async({id,index,words})=>{
            const audio=window.__checkedAudio;
            if(!audio.paused) throw new Error('pause did not pause');
            let count=0;
            for(const [wordIndex,word] of words.entries()) {
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
          },{id:metadata.id,index,words:metadata.words});
          alignedWords+=checked;
        }
        await closeAudio(page);
        playback++;
        report.checks.individualAudioPlayback=playback;
        report.checks.newTimedWords=alignedWords;
      }
      console.log(`Audio playback PASS lesson ${id} ${view} ${voice} (${count})`);
    }
    report.checks.individualAudioPlayback=playback;
    report.checks.newTimedWords=alignedWords;
    assert.equal(playback,586);
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
    for(const removed of ['homework','practice','practice/2','pronunciation']) {
      await page.goto(base+'#lesson/5/'+removed);
      await page.waitForURL('**/#lesson/5/reading');
    }
    await page.goto(base+'#lesson/999/reading');
    await page.waitForFunction(()=>document.querySelector('.tab.active')?.getAttribute('href')==='#lesson/1/reading');
    await page.locator('.next-step a').click();
    await page.waitForURL('**/#lesson/1/words');
    await page.locator('.next-step a').click();
    await page.waitForURL('**/#lesson/1/grammar');
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
    report.checks.controls={preferencesPersist:true,allFiveSpeeds:true,inPlaySpeedCycle:true,pauseResume:true,repeat:true,next:true,close:true,routeStopsAudio:true,continuousWholeLesson:true,lastNextDisabled:true,legacyRoutes:4,invalidLessonFallback:true,tabsAndLessonNavigation:true,helpAndEscape:true,skipLink:true,mobileMenuAndVeil:true};
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
async function voiceControls() {
  const page=await makePage();
  try {
    await route(page,1,'words');
    for(const voice of ['male','female']) {
      const button=page.locator(`[data-pref="voice"][data-value="${voice}"]`);
      await button.focus(); await page.keyboard.press('Space');
      assert.equal(await button.getAttribute('aria-pressed'),'true');
      await page.reload(); await page.locator('.sentence').first().waitFor();
      assert.equal(await button.getAttribute('aria-pressed'),'true');
      await page.locator('.tab[href="#lesson/1/grammar"]').click();
      assert.equal(await button.getAttribute('aria-pressed'),'true');
      await page.locator('.tab[href="#lesson/1/words"]').click();
    }
    for(const paused of [false,true]) {
      await page.locator('[data-action="play-line"]').first().click();
      await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
      if(paused) await page.locator('[data-action="player-toggle"]').click();
      const next=await page.locator('[data-pref="voice"][aria-pressed="false"]').getAttribute('data-value');
      await page.locator(`[data-pref="voice"][data-value="${next}"]`).click();
      assert(await page.locator('#player').evaluate(el=>el.hidden));
      assert(await page.evaluate(()=>window.__checkedAudio.paused && !window.__checkedAudio.getAttribute('src')));
      assert.equal(await page.locator('.current-word').count(),0);
      await page.locator('[data-action="play-line"]').first().click();
      await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
      assert((await page.evaluate(()=>window.__checkedAudio.src)).includes(`/audio/${next}/`));
      await closeAudio(page);
    }
    // Listen through complete vocabulary and grammar queues in both voices.
    const sequences=[];
    for(const view of ['words','grammar']) for(const voice of ['female','male']) {
      await route(page,2,view);
      await page.locator(`[data-pref="voice"][data-value="${voice}"]`).click();
      await page.locator('[data-pref="speed"][data-value="1.5"]').click();
      const count=await page.locator('.sentence').count();
      await page.evaluate(()=>{
        window.__voicesPlayed=[];
        window.__checkedAudio.addEventListener('playing',()=>{
          const index=document.querySelector('.sentence.is-playing')?.dataset.segment;
          if(index!==undefined && window.__voicesPlayed.at(-1)?.index!==index)
            window.__voicesPlayed.push({index,src:window.__checkedAudio.src});
        });
      });
      await page.locator('[data-action="play-all"]').click();
      await page.waitForFunction(last=>window.__checkedAudio.ended && document.querySelector('.sentence.is-playing')?.dataset.segment===String(last),count-1,{timeout:90000});
      const played=await page.evaluate(()=>window.__voicesPlayed);
      assert.deepEqual(played.map(p=>p.index),Array.from({length:count},(_,i)=>String(i)));
      assert(played.every(p=>p.src.includes(`/audio/${voice}/`)));
      assert(await page.locator('[data-action="player-next"]').isDisabled());
      await closeAudio(page);
      sequences.push({view,voice,clips:count});
    }
    // Conversation voices stay tied to characters even when the preference is male.
    await route(page,1);
    assert.equal(await page.locator('[data-pref="voice"]').count(),0);
    for(let index=0;index<4;index++) {
      await page.locator(`[data-action="play-line"][data-index="${index}"]`).click();
      await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
      const correct=await page.evaluate(index=>{
        const item=DRAMA_COURSE[0].reading[index];
        return window.__checkedAudio.src.includes('/audio/'+(item.speaker.includes('山本')?'female':'male')+'/');
      },index);
      assert(correct);await closeAudio(page);
    }
    // A failed request produces a useful message and the same clip can be retried.
    await page.route('**/audio/female/**',route=>route.abort());
    await route(page,1,'grammar');
    await page.locator('[data-pref="voice"][data-value="female"]').click();
    await page.locator('[data-action="play-line"]').first().click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent===DRAMA_CONFIG.text.msgLoadFailed);
    await page.unroute('**/audio/female/**');
    await page.locator('[data-action="play-line"]').first().click();
    await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
    await closeAudio(page);
    await page.evaluate(()=>localStorage.setItem('drama-preferences',JSON.stringify({voice:'invalid'})));
    await page.reload(); await page.locator('.sentence').first().waitFor();
    assert.equal(await page.locator('[data-pref="voice"][data-value="female"]').getAttribute('aria-pressed'),'true');
    report.checks.voiceControls={keyboard:true,persistentAcrossPages:true,switchStopsPlayingAndPausedAudio:true,characterVoicesPreserved:true,continuousQueues:sequences,failedAudioRetry:true,invalidSavedVoiceFallback:true};
    console.log('Voice selection, both continuous queues and failed-audio recovery PASS');
  } finally {await page.close();}
}
async function grammarExperience() {
  const page=await makePage();
  try {
    let ranges=0, clips=0;
    async function checkLesson(id) {
      const page=await makePage();
      try {
      await route(page,id,'grammar');
      const sections=await page.evaluate(id=>DRAMA_GRAMMAR_GUIDE[id].map((guide,section)=>({
        title:guide.title,
        indices:DRAMA.itemsFor(DRAMA_COURSE[id-1],'grammar').flatMap((item,i)=>item.section===section+1?[i]:[])
      })),id);
      assert.equal(await page.locator('.grammar-goal:visible').count(),sections.length);
      assert.equal(await page.locator('.grammar-tip:visible').count(),sections.length);
      assert.equal(await page.locator('.grammar-explanation[open]').count(),0);
      for(const voice of ['female','male']) {
        await page.locator(`[data-pref="voice"][data-value="${voice}"]`).click();
        for(const [section,entry] of sections.entries()) {
          await page.locator(`[data-action="play-section"][data-section="${section}"]`).click();
          for(const index of entry.indices) {
            await page.waitForFunction(index=>document.querySelector('.sentence.is-playing')?.dataset.segment===String(index) && window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused,index);
            assert.equal(await page.locator('.sentence.is-playing').getAttribute('data-segment'),String(index));
            assert((await page.evaluate(()=>window.__checkedAudio.src)).includes('/audio/'+voice+'/'));
            await page.evaluate(async()=>{
              const audio=window.__checkedAudio;
              audio.pause();
              await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(new Error('section seek timeout')),3000);
                audio.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});
                audio.currentTime=audio.duration-0.06;
              });
              await audio.play();
            });
            if(index===entry.indices.at(-1)) {
              await page.waitForFunction(()=>window.__checkedAudio.ended && window.__checkedAudio.paused);
              assert.equal(await page.locator('.sentence.is-playing').getAttribute('data-segment'),String(index));
              assert(await page.locator('[data-action="player-next"]').isDisabled());
            }
            clips++;
          }
          await closeAudio(page);
          ranges++;
        }
      }
      console.log(`Grammar section queues PASS lesson ${id}`);
      } finally {await page.close();}
    }
    // Independent lessons use separate pages so this exhaustive check stays fast.
    await Promise.all(Array.from({length:4},(_,worker)=>(async()=>{
      for(let id=worker+1;id<=14;id+=4) await checkLesson(id);
    })()));
    assert.equal(ranges,50);assert.equal(clips,294);
    // A full section starting in the middle of a lesson stays within its boundaries.
    await route(page,4,'grammar');
    await page.locator('[data-pref="speed"][data-value="1.5"]').click();
    await page.locator('[data-action="play-section"][data-section="1"]').click();
    await page.waitForFunction(()=>window.__checkedAudio.ended && document.querySelector('.sentence.is-playing')?.dataset.segment==='9',null,{timeout:20000});
    assert((await page.locator('.player-label small').innerText()).endsWith('2 / 2'));
    await page.locator('[data-action="player-repeat"]').click();
    await page.waitForFunction(()=>window.__checkedAudio.currentTime>0.03 && !window.__checkedAudio.paused);
    assert.equal(await page.locator('.sentence.is-playing').getAttribute('data-segment'),'9');
    assert(await page.locator('[data-action="player-next"]').isDisabled());
    await page.locator('[data-action="grammar-jump"][data-section="0"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'grammar-title-0');
    assert(await page.evaluate(()=>window.__checkedAudio.paused && !window.__checkedAudio.getAttribute('src')));
    // Mobile settings should not hide the learning goal on arrival.
    await page.setViewportSize({width:390,height:844});
    await route(page,12,'grammar');
    assert.equal(await page.locator('.grammar-settings').evaluate(el=>el.open),false);
    await page.locator('.grammar-settings > summary').click();
    await page.locator('.grammar-explanation').first().evaluate(el=>el.open=true);
    await page.locator('[data-pref="voice"][data-value="female"]').click();
    const position=await page.evaluate(()=>scrollY);
    await page.locator('[data-pref="voice"][data-value="male"]').click();
    assert(await page.locator('.grammar-settings').evaluate(el=>el.open));
    assert(await page.locator('.grammar-explanation').first().evaluate(el=>el.open));
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.value),'male');
    assert(Math.abs(await page.evaluate(()=>scrollY)-position)<2);
    assert((await page.locator('#grammar-settings-state').innerText()).includes('男性'));
    for(const key of ['py','jp']) await page.locator(`[data-pref="${key}"][data-value="false"]`).click();
    assert.equal(await page.locator('.sentence rt:visible').count(),0);
    assert.equal(await page.locator('.sentence .jp:visible').count(),0);
    assert.equal(await page.locator('.grammar-goal:visible').count(),2);
    await page.locator('.grammar-settings > summary').click();
    await page.locator('[data-action="grammar-jump"][data-section="1"]').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'grammar-title-1');
    assert((await page.locator('#grammar-title-1').boundingBox()).y>=60);
    assert.equal(await page.locator('.tab.active').getAttribute('href'),'#lesson/12/grammar');
    report.checks.grammarExperience={visibleGuides:25,sectionQueues:ranges,sectionClips:clips,wholeSectionPlayback:true,repeatAtBoundary:true,keyboardTopicNavigation:true,topicChangeStopsAudio:true,mobileSettings:true,voiceChangePreservesReadingPosition:true,displaySettings:true};
    console.log('Student grammar flow, all 50 section queues and mobile settings PASS');
  } finally {await page.close();}
}
(async()=>{
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),headless:true});
  try {
    const available={layout:routesAndLayout,audio:allAudio,controls,voices:voiceControls,grammar:grammarExperience};
    const selected=process.env.BROWSER_SUITES ? process.env.BROWSER_SUITES.split(',') : Object.keys(available);
    assert(selected.length && selected.every(name=>available[name]),'unknown BROWSER_SUITES');
    report.suites=selected;
    const suites=await Promise.allSettled(selected.map(name=>available[name]()));
    const failures=suites.filter(s=>s.status==='rejected').map(s=>s.reason.stack||String(s.reason));
    assert.deepEqual(failures,[]);
    assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
    report.status='PASS';
  } finally {
    await browser.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{report.status='FAIL';report.error=error.stack;fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.error(error);process.exit(1);});
