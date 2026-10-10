const { test, expect } = require('@playwright/test');

test('SynthOslek starts its audio engine and preserves key UI/diagnostics', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle(/SynthOslek v16\.67/);
  await expect(page.locator('#keyboard')).toBeAttached();
  await expect(page.locator('.welcome-desc')).toContainText('Describe the sound in your head');
  await expect(page.locator('.welcome-desc')).not.toContainText('4 layers');
  await expect(page.locator('.welcome-features')).toContainText('DESIGN');
  await expect(page.locator('.welcome-features')).toContainText('MORPH');
  await expect(page.locator('.welcome-features')).toContainText('PERFORM');
  await expect(page.locator('#soDiagToggle')).toBeAttached();
  await expect(page.locator('#soDiagPanel')).toBeHidden();
  await page.locator('#welcomeStart').click();
  await expect.poll(async () => page.evaluate(() => {
    try { return window.SynthOslekPerformance && window.SynthOslekPerformance.snapshot().audioState; }
    catch (e) { return 'error'; }
  }), { timeout: 10000 }).toBe('running');
  await page.locator('#soDiagToggle').click();
  await expect(page.locator('#soDiagPanel')).toBeVisible();
  await expect(page.locator('#soDiagState')).toHaveText('running');
  expect(pageErrors).toEqual([]);
});
test('diagnostics records ARP timer drift and summarizes it', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const d = window.SynthOslekDiagnostics;
    if (!d) return { missing: true };
    d.reset();
    [1, 2, 4, 8, 16].forEach(x => d.recordArpWake(100, 100 + x));
    return d.snapshot();
  });
  expect(result.missing).toBeFalsy();
  expect(result.count).toBe(5);
  expect(result.meanMs).toBe(6.2);
  expect(result.maxAbsMs).toBe(16);
});

test('browser OfflineAudioContext renders finite non-silent test audio', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return { unsupported: true };
    const ctx = new Offline(1, 48000, 48000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(0.2, 0.01);
    gain.gain.setValueAtTime(0.2, 0.8);
    gain.gain.linearRampToValueAtTime(0, 0.95);
    osc.connect(gain).connect(ctx.destination);
    osc.start(0);
    osc.stop(1);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    let peak = 0, sum = 0, invalid = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) invalid++;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    return { frames: data.length, peak, rms: Math.sqrt(sum / data.length), invalid };
  });
  test.skip(result.unsupported, 'OfflineAudioContext is not supported in this browser');
  expect(result.frames).toBe(48000);
  expect(result.invalid).toBe(0);
  expect(result.peak).toBeGreaterThan(0.05);
  expect(result.peak).toBeLessThan(1);
  expect(result.rms).toBeGreaterThan(0);
});


test('actual SynthOslek note path produces analyser energy and releases cleanly', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    if (!synth || !synth.analyser || !synth.ctx) return { unsupported: true, reason: 'Synth analyser is unavailable in this browser configuration' };
    const data = new Float32Array(synth.analyser.fftSize);
    const rmsSamples = [];
    synth.noteOn(60, 0.85, 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    for (let n = 0; n < 5; n++) {
      synth.analyser.getFloatTimeDomainData(data);
      let sum = 0, peak = 0, invalid = 0;
      for (const v of data) {
        if (!Number.isFinite(v)) invalid++;
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      rmsSamples.push({ rms: Math.sqrt(sum / data.length), peak, invalid });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const activeBeforeRelease = synth.voicePool.stats().active;
    synth.noteOff(60, 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    const activeAfterRelease = synth.voicePool.stats().active;
    synth.panic();
    return { unsupported: false, audioState: synth.ctx.state, activeBeforeRelease, activeAfterRelease, rmsSamples };
  });
  test.skip(result.unsupported, result.reason || 'Synth analyser unavailable');
  expect(result.audioState).toBe('running');
  expect(result.activeBeforeRelease).toBeGreaterThan(0);
  expect(result.rmsSamples.every(x => x.invalid === 0)).toBeTruthy();
  expect(Math.max(...result.rmsSamples.map(x => x.peak))).toBeGreaterThan(0.00001);
  expect(result.activeAfterRelease).toBeLessThanOrEqual(result.activeBeforeRelease);
  expect(pageErrors).toEqual([]);
});


test('actual ARP stress keeps voices bounded and measures waveform continuity', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const arp = document.getElementById('so67Arp');
    const rate = document.getElementById('so67Rate');
    if (!synth || !arp || !rate || !synth.analyser) return { unsupported: true, reason: 'ARP controls or analyser unavailable' };
    synth.panic();
    window.SynthOslekDiagnostics.reset();
    rate.value = '1/16';
    rate.dispatchEvent(new Event('change', { bubbles: true }));
    arp.click();
    [60, 64, 67, 72].forEach((n, i) => synth.noteOn(n, 0.72 - i * 0.05, 0));
    const data = new Float32Array(synth.analyser.fftSize);
    const peaks = [], rmsValues = [], dcValues = [], maxJumps = [];
    const until = performance.now() + 900;
    while (performance.now() < until) {
      /* Exercise the same public note/morph state while the real ARP is active. */
      synth.setModWheel((Math.sin(performance.now() / 75) + 1) / 2);
      synth.analyser.getFloatTimeDomainData(data);
      let peak = 0, sum = 0, mean = 0, maxJump = 0, invalid = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!Number.isFinite(v)) invalid++;
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
        mean += v;
        if (i > 0) maxJump = Math.max(maxJump, Math.abs(v - data[i - 1]));
      }
      peaks.push(peak);
      rmsValues.push(Math.sqrt(sum / data.length));
      dcValues.push(mean / data.length);
      maxJumps.push(maxJump);
      if (invalid) return { unsupported: false, invalid };
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const jitter = window.SynthOslekDiagnostics.snapshot();
    const poolDuring = synth.voicePool.stats();
    const waveform = {
      peakMax: Math.max(...peaks),
      rmsMax: Math.max(...rmsValues),
      dcAbsMax: Math.max(...dcValues.map(Math.abs)),
      maxAdjacentSampleJump: Math.max(...maxJumps),
      framesSampled: data.length * peaks.length,
      sampleWindows: peaks.length,
      allFinite: peaks.every(Number.isFinite) && rmsValues.every(Number.isFinite) &&
        dcValues.every(Number.isFinite) && maxJumps.every(Number.isFinite)
    };
    [60, 64, 67, 72].forEach(n => synth.noteOff(n, 0));
    arp.click();
    synth.panic();
    const poolAfter = synth.voicePool.stats();
    return { unsupported: false, jitter, poolDuring, poolAfter, waveform, audioState: synth.ctx.state };
  });
  test.skip(result.unsupported, result.reason || 'ARP runtime diagnostics unavailable');
  expect(result.invalid || 0).toBe(0);
  expect(result.audioState).toBe('running');
  expect(result.jitter.count).toBeGreaterThan(0);
  expect(result.poolDuring.occupied).toBeLessThanOrEqual(result.poolDuring.max);
  expect(result.poolAfter.active).toBe(0);
  expect(result.waveform.allFinite).toBeTruthy();
  expect(result.waveform.peakMax).toBeGreaterThan(0.00001);
  expect(result.waveform.peakMax).toBeLessThan(1);
  expect(result.waveform.rmsMax).toBeGreaterThan(0);
  /* Diagnostic metric, not a universal click threshold: abrupt changes need listening/context. */
  console.log('ARP stress audio metrics:', JSON.stringify({ jitter: result.jitter, poolDuring: result.poolDuring, poolAfter: result.poolAfter, waveform: result.waveform }));
  expect(pageErrors).toEqual([]);
});


test('voice-pool reclaim clears orphaned reservations and panic leaves no voices', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(() => {
    const synth = window.synth;
    const pool = synth.voicePool;
    pool.clear();
    const allocation = pool.acquire('__test_orphan__', 0.7);
    const before = pool.stats();
    const reclaimed = pool.reclaim(new Set(synth.voices.keys()));
    const after = pool.stats();
    pool.acquire('__test_force_stop__', 0.7);
    synth._forceStop('__test_force_stop__');
    const afterForceStop = pool.stats();
    synth.noteOn(60, 0.8, 0);
    synth.noteOff(60, 0);
    const afterNoteOff = pool.stats();
    synth.panic();
    return { allocation: !!allocation.slot, before, reclaimed, after, afterForceStop, afterNoteOff, afterPanic: pool.stats() };
  });
  expect(result.allocation).toBeTruthy();
  expect(result.before.active).toBe(1);
  expect(result.reclaimed).toBeGreaterThanOrEqual(1);
  expect(result.after.active).toBe(0);
  expect(result.afterForceStop.active).toBe(0);
  expect(result.afterNoteOff.active).toBe(0);
  expect(result.afterNoteOff.tails).toBeGreaterThan(0);
  expect(result.afterPanic.active).toBe(0);
  expect(result.afterPanic.occupied).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('minimal mode keeps essentials visible and ADV toggle restores full controls', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/SynthOslek v16\.67/);
  await expect(page.locator('.welcome-desc')).toContainText('MIDI controller');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const essentialSelectors = ['.brand h1', '#stxt', '#rndBtn', '#soundPrompt', '#soundGenerate', '#volKnob', '.pair-strip', '#bleMidiBtn', '#advToggle'];
  for (const selector of essentialSelectors) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#keyboard')).toBeHidden();
  await expect(page.locator('#so67')).toBeHidden();
  await expect(page.locator('#perfBar')).toBeHidden();

  await page.locator('#advToggle').click();
  await expect(page.locator('#advToggle')).toHaveText('◀ MIN');
  await expect(page.locator('#keyboard')).toBeVisible();
  await expect(page.locator('#so67')).toBeVisible();
  await expect(page.locator('#tabs')).toBeVisible();

  await page.locator('#advToggle').click();
  await expect(page.locator('#advToggle')).toHaveText('⚙ ADV');
  await expect(page.locator('#keyboard')).toBeHidden();
});


test('synonym chains map descriptive prompts to known sound-design rules', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const cathedral = SD.analyze('cathedral pad');
    const crystalline = SD.analyze('crystalline lead');
    const noir = SD.analyze('noir');
    return {
      cathedralTags: cathedral.tags,
      cathedralEngine: cathedral.engine,
      crystallineTags: crystalline.tags,
      noirTags: noir.tags
    };
  });
  expect(result.cathedralTags).toContain('ORGAN');
  expect(result.crystallineTags).toContain('GLASSY');
  expect(result.noirTags).toContain('CINEMATIC-CONTEXT');
});

test('PairMemory stores and restores the morph wheel position', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const memory = window.SynthOslekPairMemory;
    memory.clear();
    const A = { ...synth.params };
    const B = { ...synth.params, cutoff: Math.min(14000, (Number(synth.params.cutoff) || 2000) + 600) };
    synth.setModWheel(0.63);
    memory.push({ A, B, family: 'SYNTH' }, 'morph restore test');
    const savedWheel = memory.all[0]?.wheel;
    synth.setModWheel(0.12);
    const recalled = memory.recall(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const restoredWheel = synth.modWheel;
    const status = document.getElementById('stxt')?.textContent || '';
    memory.clear();
    synth.panic();
    return { savedWheel, restoredWheel, recalled, status };
  });
  expect(result.recalled).toBeTruthy();
  expect(result.savedWheel).toBeCloseTo(0.63, 3);
  expect(result.restoredWheel).toBeCloseTo(0.63, 3);
  expect(result.status).toContain('@ 0.63');
  expect(pageErrors).toEqual([]);
});


test('rapid lead-note and morph sweep stress leaves the synth healthy', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const arpButton = document.getElementById('so67Arp');
    if (typeof SO !== 'undefined' && SO.arp.on && arpButton) arpButton.click();
    synth.panic();

    const data = new Float32Array(synth.analyser.fftSize);
    const samples = [];
    const start = performance.now();
    let accepted = 0, rejected = 0, noteCount = 360;
    for (let i = 0; i < noteCount; i++) {
      const midi = 48 + (i % 36);
      const velocity = 0.48 + ((i % 9) / 20);
      const wheel = ((i * 37) % 101) / 100;
      synth.setModWheel(wheel);
      const ok = synth.noteOn(midi, velocity, 0);
      if (ok === false) rejected++;
      else accepted++;
      setTimeout(() => { try { synth.noteOff(midi, 0); } catch (e) {} }, 12);
      if (i % 30 === 0) {
        synth.analyser.getFloatTimeDomainData(data);
        let sum = 0, peak = 0, invalid = 0;
        for (const v of data) {
          if (!Number.isFinite(v)) invalid++;
          sum += v * v;
          peak = Math.max(peak, Math.abs(v));
        }
        samples.push({ rms: Math.sqrt(sum / data.length), peak, invalid });
      }
      await sleep(4);
    }
    await sleep(80);
    synth.analyser.getFloatTimeDomainData(data);
    let finalRms = 0, finalPeak = 0, invalidFinal = 0;
    for (const v of data) {
      if (!Number.isFinite(v)) invalidFinal++;
      finalRms += v * v;
      finalPeak = Math.max(finalPeak, Math.abs(v));
    }
    const beforePanic = {
      elapsedMs: +(performance.now() - start).toFixed(1),
      accepted, rejected, active: synth.voices.size, tails: synth.tailVoices.size,
      pool: synth.voicePool.stats(),
      sampleCount: samples.length,
      samplesFinite: samples.every(x => x.invalid === 0 && Number.isFinite(x.rms) && Number.isFinite(x.peak)),
      peakMax: Math.max(0, ...samples.map(x => x.peak)),
      rmsMax: Math.max(0, ...samples.map(x => x.rms)),
      finalPeak, finalRms: Math.sqrt(finalRms / data.length), invalidFinal
    };
    synth.panic();
    await sleep(35);
    return {
      beforePanic,
      afterPanic: {
        active: synth.voices.size,
        tails: synth.tailVoices.size,
        sustained: synth.sustained.size,
        pool: synth.voicePool.stats(),
        audioState: synth.ctx.state
      }
    };
  });

  expect(result.beforePanic.accepted).toBeGreaterThan(300);
  expect(result.beforePanic.rejected).toBe(0);
  expect(result.beforePanic.samplesFinite).toBeTruthy();
  expect(result.beforePanic.invalidFinal).toBe(0);
  expect(result.beforePanic.peakMax).toBeGreaterThan(0.00001);
  expect(result.beforePanic.peakMax).toBeLessThan(1.25);
  expect(result.beforePanic.pool.occupied).toBeLessThanOrEqual(result.beforePanic.pool.max);
  expect(result.afterPanic.active).toBe(0);
  expect(result.afterPanic.tails).toBe(0);
  expect(result.afterPanic.sustained).toBe(0);
  expect(result.afterPanic.pool.occupied).toBe(0);
  expect(result.afterPanic.audioState).toBe('running');
  expect(pageErrors).toEqual([]);
  console.log('Rapid lead/morph stress metrics:', JSON.stringify(result));
});

test('VoicePool 10,000-operation randomized invariant stress', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const pool = new VoicePool(32);
    const live = new Set();
    let seed = 0x51A7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let acquisitions = 0, releases = 0, steals = 0, duplicates = 0, reclaimed = 0;
    let invariantFailures = 0;
    const verify = () => {
      const activeSlots = pool.slots.filter(x => x.active);
      if (pool.active.size !== activeSlots.length) invariantFailures++;
      for (const [key, slot] of pool.active) {
        if (!slot || !slot.active || slot.key !== key) invariantFailures++;
      }
      for (const slot of activeSlots) {
        if (!pool.active.has(slot.key) || pool.active.get(slot.key) !== slot) invariantFailures++;
      }
      if (pool.slots.length !== pool.max || pool.slots.some(x => x.active && (!x.key || !Number.isFinite(x.velocity)))) invariantFailures++;
      if (pool.stats().occupied > pool.max) invariantFailures++;
    };
    for (let i = 0; i < 10000; i++) {
      const midi = 36 + Math.floor(rand() * 72);
      const key = (Math.floor(rand() * 2)) + ':' + midi;
      const action = rand();
      if (action < .62) {
        const a = pool.acquire(key, rand());
        acquisitions++;
        if (a.stolenKey) { steals++; live.delete(a.stolenKey); }
        if (a.duplicate) duplicates++;
        if (a.slot) live.add(key);
        else live.delete(key);
      } else if (action < .91) {
        if (live.has(key)) releases++;
        live.delete(key);
        pool.release(key, rand() < .12 ? 4 : 0);
      } else {
        reclaimed += pool.reclaim(live);
      }
      if (i % 13 === 0) verify();
    }
    reclaimed += pool.reclaim(live);
    verify();
    pool.clear();
    const final = pool.stats();
    return { acquisitions, releases, steals, duplicates, reclaimed, invariantFailures, final };
  });
  expect(result.acquisitions).toBeGreaterThan(5000);
  expect(result.steals).toBeGreaterThan(0);
  expect(result.invariantFailures).toBe(0);
  expect(result.final.active).toBe(0);
  expect(result.final.tails).toBe(0);
  expect(result.final.occupied).toBe(0);
  console.log('VoicePool randomized stress metrics:', JSON.stringify(result));
});
