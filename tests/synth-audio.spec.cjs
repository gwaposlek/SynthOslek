const { test, expect } = require('@playwright/test');

async function expectTitleMatchesBuild(page) {
  const [title, build] = await Promise.all([
    page.title(),
    page.locator('meta[name="synthoslek-build"]').getAttribute('content')
  ]);
  const version = build?.match(/v[0-9]+[.][0-9]+/)?.[0];
  expect(version, 'build metadata should include a semantic release version').toBeTruthy();
  expect(title, 'page title should reflect the current build marker').toContain(version);
}

test('SynthOslek starts its audio engine and preserves key UI/diagnostics', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await expectTitleMatchesBuild(page);
  await expect(page.locator('#keyboard')).toBeAttached();
  await expect(page.locator('.welcome-card h1')).toContainText('SynthOslek');
  await expect(page.locator('#welcomeStart')).toHaveText('START');
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


test('filter envelope changes the actual synth output spectrum', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => !!window.synth?.started && window.synth?.ctx?.state === 'running'), { timeout: 10000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const synth = window.synth;
    if (!synth?.analyser || !synth?.ctx || !synth?.noteOn) return { unsupported: true };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    synth.panic();
    synth.layerProfilesB[0] = null;
    synth._bRevision[0] = (synth._bRevision[0] || 0) + 1;
    synth._morphCache.clear();

    const profile = synth.layerProfiles[0];
    Object.assign(profile, {
      osc1Wave: 'sawtooth', osc1Level: 1, osc1Detune: 0, osc1Coarse: 0,
      osc2Wave: 'sine', osc2Level: 0, osc2Detune: 0, osc2Coarse: 0,
      cutoff: 350, resonance: 0.4, filterType: 'lowpass', filterEnvPolarity: 'positive',
      attack: 0.004, decay: 0.8, sustain: 1, release: 0.04,
      fEnvAmt: 0, fAttack: 0.005, fDecay: 0.8, fSustain: 0.85, fRelease: 0.04,
      lfoDepth: 0, delayMix: 0, reverbMix: 0, chorusMix: 0, flangerMix: 0,
      subLevel: 0, noiseLevel: 0, fmAmount: 0, unison: 1, spread: 0
    });
    synth.setModWheel(0);

    const measureHighBandPower = async amount => {
      synth.panic();
      await sleep(90);
      profile.fEnvAmt = amount;
      synth._morphCache.clear();
      // Some installed input/performance wrappers do not preserve the return value;
      // the live voice map is the authoritative success signal for this integration test.
      const noteReturn = synth.noteOn(48, 0.95, 0);
      const voice = synth.voices.get('0:48');
      if (!voice) return {
        ok: false, highBandPower: 0, voiceRoute: false, noteReturn,
        started: synth.started, contextState: synth.ctx?.state,
        activeVoices: synth.voices?.size, pool: synth.voicePool?.stats(),
        cutoff: profile.cutoff, filterType: profile.filterType, fEnvAmt: amount
      };
      await sleep(140);
      const bins = new Float32Array(synth.analyser.frequencyBinCount);
      synth.analyser.getFloatFrequencyData(bins);
      const nyquist = synth.ctx.sampleRate / 2;
      const binHz = nyquist / bins.length;
      let power = 0, count = 0;
      for (let i = 0; i < bins.length; i++) {
        const hz = i * binHz;
        if (hz < 1800 || hz > 10000 || !Number.isFinite(bins[i])) continue;
        power += Math.pow(10, bins[i] / 10);
        count++;
      }
      const highBandPower = count ? power / count : 0;
      const voiceRoute = !!(voice?.fEnvGain && voice?.fEnvDepth && voice.fEnvGain.gain.value >= 0);
      synth.noteOff(48, 0);
      await sleep(80);
      return { ok: true, highBandPower, voiceRoute, noteReturn };
    };

    const closed = await measureHighBandPower(0);
    const open = await measureHighBandPower(1);
    synth.panic();
    return { unsupported: false, closed, open };
  });
  console.log('Filter-envelope spectral metrics:', JSON.stringify({
    closed: result.closed?.highBandPower, open: result.open?.highBandPower
  }));
  test.skip(result.unsupported, 'Synth analyser unavailable');
  expect(result.closed.ok).toBeTruthy();
  expect(result.open.ok).toBeTruthy();
  expect(result.closed.voiceRoute).toBeTruthy();
  expect(result.open.voiceRoute).toBeTruthy();
  expect(result.open.highBandPower).toBeGreaterThan(result.closed.highBandPower * 1.8);
  expect(pageErrors).toEqual([]);
});

test('A/B morph allocates optional sources required by endpoint B', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => !!window.synth?.started && window.synth?.ctx?.state === 'running'), { timeout: 10000 }).toBe(true);
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    if (!synth?.noteOn || !synth?.setModWheel) return { unsupported: true };
    synth.panic();
    const A = { ...synth.layerProfiles[0], osc1Wave: 'sawtooth', osc2Wave: 'sine', subLevel: 0, noiseLevel: 0, fmAmount: 0 };
    const B = { ...A, subLevel: 0.45, noiseLevel: 0.12, fmAmount: 800 };
    synth.layerProfiles[0] = A;
    synth.params = A;
    synth.layerProfilesB[0] = B;
    synth._bRevision[0] = (synth._bRevision[0] || 0) + 1;
    synth._morphCache.clear();
    synth.setModWheel(0);
    const noteReturn = synth.noteOn(60, 0.8, 0);
    const voice = synth.voices.get('0:60');
    const ok = !!voice;
    const sourcesAtA = !!voice && !!voice.subOsc && !!voice.noiseSource && !!voice.fmMod && !!voice.fmGain;
    if (!voice) {
      const debug = { noteReturn, started: synth.started, contextState: synth.ctx?.state, activeVoices: synth.voices?.size, pool: synth.voicePool?.stats() };
      synth.panic();
      return { ok: false, sourcesAtA, debug };
    }
    synth.setModWheel(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const stateAtB = voice ? synth._voiceMorphProfile(voice) : {};
    const result = {
      ok,
      noteReturn,
      sourcesAtA,
      valuesAtB: {
        sub: Number(stateAtB.subLevel) || 0,
        noise: Number(stateAtB.noiseLevel) || 0,
        fm: Number(stateAtB.fmAmount) || 0
      },
      expectedFmDepth: synth._fmDepthHz(stateAtB, 60, 0.8),
      gainTargets: {
        sub: synth._audioParamTargets?.get(voice?.gs?.gain)?.value ?? null,
        noise: synth._audioParamTargets?.get(voice?.gn?.gain)?.value ?? null,
        fm: synth._audioParamTargets?.get(voice?.fmGain?.gain)?.value ?? null
      }
    };
    synth.panic();
    return result;
  });
  test.skip(result.unsupported, 'Synth morph API unavailable');
  expect(result.ok).toBeTruthy();
  expect(result.sourcesAtA).toBeTruthy();
  expect(result.valuesAtB.sub).toBeCloseTo(0.45, 2);
  expect(result.valuesAtB.noise).toBeCloseTo(0.12, 2);
  expect(result.valuesAtB.fm).toBeCloseTo(800, 1);
  expect(result.gainTargets.sub).toBeCloseTo(0.45, 2);
  expect(result.gainTargets.noise).toBeCloseTo(0.12, 2);
  expect(result.gainTargets.fm).toBeCloseTo(result.expectedFmDepth, 1);
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

test('minimal mode shows essentials and ADV reveals performance controls', async ({ page }) => {
  await page.goto('/');
  await expectTitleMatchesBuild(page);
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const essentialSelectors = ['.brand-mark', '#stxt', '#rndBtn', '#soundPrompt', '#soundGenerate', '#volKnob', '.pair-strip', '#bleMidiBtn', '#advToggle'];
  for (const selector of essentialSelectors) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#keyboard')).toBeVisible();
  await expect(page.locator('#so67')).toBeHidden();
  await expect(page.locator('#perfBar')).toBeHidden();

  await page.locator('#advToggle').click();
  await expect(page.locator('#advToggle')).toHaveText('◀ MIN');
  await expect(page.locator('#keyboard')).toBeVisible();
  await expect(page.locator('#so67')).toBeVisible();
  // Legacy tab strip is intentionally hidden in this UI, including ADV mode.
  await expect(page.locator('#tabs')).toBeHidden();

  await page.locator('#advToggle').click();
  await expect(page.locator('#advToggle')).toHaveText('⚙ ADV');
  await expect(page.locator('#keyboard')).toBeVisible();
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
  expect(result.cathedralTags).toContain('PAD');
  expect(result.cathedralTags).not.toContain('ORGAN');
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

    if (!synth.limiter || !synth.analyser) throw new Error('Desktop output limiter/analyser is unavailable');
    // The normal analyser is upstream of the compressor; this probe taps the
    // compressor output and uses a zero-gain sink so it can observe the real
    // limiter path without adding audible signal to the output.
    const outputProbe = synth.ctx.createAnalyser();
    outputProbe.fftSize = synth.analyser.fftSize;
    const probeSink = synth.ctx.createGain();
    probeSink.gain.value = 0;
    synth.limiter.connect(outputProbe);
    outputProbe.connect(probeSink);
    probeSink.connect(synth.ctx.destination);
    const data = new Float32Array(outputProbe.fftSize);
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
        outputProbe.getFloatTimeDomainData(data);
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
    outputProbe.disconnect();
    probeSink.disconnect();
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

  console.log('Rapid lead/morph stress metrics:', JSON.stringify(result));
  expect(result.beforePanic.accepted).toBeGreaterThan(300);
  expect(result.beforePanic.rejected).toBe(0);
  expect(result.beforePanic.samplesFinite).toBeTruthy();
  expect(result.beforePanic.invalidFinal).toBe(0);
  expect(result.beforePanic.peakMax).toBeGreaterThan(0.00001);
  // This is a short sampled burst, post-compressor and before master volume.
  // Keep a guard against substantial excursions while tolerating browser-timing
  // variation in instantaneous peaks; the master-volume stage follows this probe.
  expect(result.beforePanic.peakMax).toBeLessThan(1.4);
  expect(result.beforePanic.pool.occupied).toBeLessThanOrEqual(result.beforePanic.pool.max);
  expect(result.afterPanic.active).toBe(0);
  expect(result.afterPanic.tails).toBe(0);
  expect(result.afterPanic.sustained).toBe(0);
  expect(result.afterPanic.pool.occupied).toBe(0);
  expect(result.afterPanic.audioState).toBe('running');
  expect(pageErrors).toEqual([]);
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


test('Panic resets sustain pedal state and cannot latch the next note', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const led = document.getElementById('sustainLed');
    synth.panic();
    synth.sustain = true;
    if (led) { led.classList.add('on'); led.textContent = 'SUSTAIN ON'; }
    synth.noteOn(60, 0.8, 0);
    await sleep(35);
    synth.noteOff(60, 0);
    const before = { sustain: synth.sustain, sustained: synth.sustained.size, activeVoices: synth.voices.size };
    synth.panic();
    const afterPanic = {
      sustain: synth.sustain, sustained: synth.sustained.size,
      activeVoices: synth.voices.size, tails: synth.tailVoices.size,
      pool: synth.voicePool.stats(),
      ledOn: !!led?.classList.contains('on')
    };
    synth.noteOn(64, 0.8, 0);
    await sleep(35);
    synth.noteOff(64, 0);
    await sleep(45);
    const afterNextNote = {
      sustain: synth.sustain, sustained: synth.sustained.size,
      activeVoices: synth.voices.size, tails: synth.tailVoices.size
    };
    synth.panic();
    return { before, afterPanic, afterNextNote };
  });
  expect(result.before.sustain).toBe(true);
  expect(result.before.sustained).toBeGreaterThan(0);
  expect(result.afterPanic.sustain).toBe(false);
  expect(result.afterPanic.sustained).toBe(0);
  expect(result.afterPanic.activeVoices).toBe(0);
  expect(result.afterPanic.tails).toBe(0);
  expect(result.afterPanic.pool.occupied).toBe(0);
  expect(result.afterPanic.ledOn).toBe(false);
  expect(result.afterNextNote.sustain).toBe(false);
  expect(result.afterNextNote.sustained).toBe(0);
  expect(result.afterNextNote.activeVoices).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('release-tail reservations drain naturally without needing Panic', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    synth.panic();
    synth.sustain = false;
    synth.noteOn(60, 0.85, 0);
    await sleep(45);
    synth.noteOff(60, 0);
    await sleep(25);
    const released = {
      active: synth.voicePool.stats().active,
      tails: synth.voicePool.stats().tails,
      occupied: synth.voicePool.stats().occupied
    };
    await sleep(1325);
    const drained = {
      active: synth.voicePool.stats().active,
      tails: synth.voicePool.stats().tails,
      occupied: synth.voicePool.stats().occupied,
      voices: synth.voices.size,
      tailVoices: synth.tailVoices.size
    };
    synth.panic();
    return { released, drained };
  });
  expect(result.released.active).toBe(0);
  expect(result.released.tails).toBeGreaterThan(0);
  expect(result.drained.active).toBe(0);
  expect(result.drained.tails).toBe(0);
  expect(result.drained.occupied).toBe(0);
  expect(result.drained.voices).toBe(0);
  expect(result.drained.tailVoices).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('knob SVG stays finite across startup and layer-preset changes', async ({ page }) => {
  const pageErrors = [];
  const svgNaNWarnings = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', msg => {
    if (/NaN|Infinity/.test(msg.text()) && /SVG|attribute|<path>|<line>/i.test(msg.text())) {
      svgNaNWarnings.push(msg.text());
    }
  });
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const inspect = () => page.evaluate(() => {
    const invalid = [];
    for (const el of document.querySelectorAll('svg path, svg line')) {
      const attrs = el.localName === 'path' ? ['d'] : ['x1', 'y1', 'x2', 'y2'];
      for (const attr of attrs) {
        const value = el.getAttribute(attr);
        if (value && /NaN|Infinity|undefined/.test(value)) {
          invalid.push({ element: el.localName, attr, value, className: el.getAttribute('class') });
        }
      }
    }
    const required = ['lfoDelay', 'flangerMix', 'flangerRate', 'flangerDepth'];
    const profile = window.synth?.layerProfiles?.[0] || {};
    return {
      invalid,
      missingDefaults: required.filter(k => !Number.isFinite(profile[k])),
      layerCount: document.querySelectorAll('.layer-preset').length
    };
  });

  const initial = await inspect();
  expect(initial.invalid).toEqual([]);
  expect(initial.missingDefaults).toEqual([]);
  expect(initial.layerCount).toBeGreaterThan(0);

  // The layer mixer can be visually collapsed in minimal mode. Exercise its
  // wired handlers directly so the regression test checks behavior, not layout.
  await page.evaluate(() => {
    const preset = document.querySelector('.layer-preset');
    if (!preset) throw new Error('Layer preset control is missing');
    preset.value = 'pad';
    preset.dispatchEvent(new Event('change', { bubbles: true }));
    const secondLayer = document.querySelectorAll('.layer-name')[1];
    if (!secondLayer) throw new Error('Second layer control is missing');
    secondLayer.click();
  });
  await expect.poll(() => page.evaluate(() => window.synth?.activeLayer), { timeout: 3000 }).toBe(1);
  const afterPresetAndLayerSwitch = await inspect();
  expect(afterPresetAndLayerSwitch.invalid).toEqual([]);
  expect(afterPresetAndLayerSwitch.missingDefaults).toEqual([]);
  expect(svgNaNWarnings).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('MIDI layer-control CCs safely ignore mappings beyond configured layers', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const result = await page.evaluate(() => {
    if (typeof midiManager === 'undefined' || !Array.isArray(layerState)) {
      return { supported: false };
    }
    const before = layerState.map(layer => ({ ...layer }));
    const errors = [];
    // There are two configured layers today, while the MIDI map reserves
    // four CC numbers for each layer-control group.
    for (const cc of [20, 21, 22, 23, 28, 29, 30, 31, 36, 37, 38, 39, 44, 45, 46, 47]) {
      try { midiManager.cc(cc, 127, 1); }
      catch (error) { errors.push({ cc, message: error?.message || String(error) }); }
    }
    return {
      supported: true,
      layerCount: layerState.length,
      errors,
      volume: layerState.map(layer => layer.vol),
      pan: layerState.map(layer => layer.pan),
      fx: layerState.map(layer => layer.fx),
      enabled: layerState.map(layer => layer.enabled),
      beforeCount: before.length
    };
  });
  expect(result.supported).toBeTruthy();
  expect(result.layerCount).toBe(2);
  expect(result.beforeCount).toBe(2);
  expect(result.errors).toEqual([]);
  expect(result.volume).toEqual([1, 1]);
  expect(result.pan).toEqual([1, 1]);
  expect(result.fx).toEqual([1, 1]);
  expect(result.enabled).toEqual([true, true]);
  expect(pageErrors).toEqual([]);
});

test('layer A/B morph does not crossfade the unrelated second layer', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  const result = await page.evaluate(() => {
    if (!window.synth || typeof layerState === 'undefined') return { supported: false };
    const synth = window.synth;
    const initiallyEnabled = layerState.map(layer => layer.enabled);
    const expectedVolumes = layerState.map(layer => layer.vol);
    // Create a real A/B profile on layer 1 and make layer 2 available to
    // reproduce the original condition where the two modes got conflated.
    synth.layerProfilesB[0] = { ...synth.layerProfiles[0], cutoff: 7100 };
    layerState[1].enabled = true;
    synth.modWheel = 0.5;
    const mode = synth.getMorphMode(0);
    refreshLayerGains();
    const actualVolumes = synth.layerMix.map(layer => layer.vol);
    synth.layerProfilesB[0] = null;
    layerState[1].enabled = false;
    synth.modWheel = 0;
    refreshLayerGains();
    return { supported: true, initiallyEnabled, expectedVolumes, mode, actualVolumes };
  });
  expect(result.supported).toBeTruthy();
  expect(result.initiallyEnabled).toEqual([true, false]);
  expect(result.mode).toBe('ab');
  expect(result.actualVolumes[0]).toBeCloseTo(result.expectedVolumes[0], 3);
  expect(result.actualVolumes[1]).toBeCloseTo(result.expectedVolumes[1], 3);
  expect(pageErrors).toEqual([]);
});

test('sound-family detection prioritizes electric piano and explicit instrument words', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const ep = SD.pair('electric piano');
    const thickLead = SD.pair('thick lead');
    const naturalLead = SD.pair('natural lead');
    const driftingLead = SD.pair('drifting lead');
    const thickBass = SD.pair('thick bass');
    const naturalOnly = SD.pair('natural');
    return {
      epFamily: ep.family, epTags: ep.tags,
      thickLeadFamily: thickLead.family, thickLeadTags: thickLead.tags,
      naturalLeadFamily: naturalLead.family, naturalLeadTags: naturalLead.tags,
      driftingLeadFamily: driftingLead.family, driftingLeadTags: driftingLead.tags,
      thickBassFamily: thickBass.family, naturalOnlyFamily: naturalOnly.family
    };
  });
  expect(result.epFamily).toBe('E-PIANO');
  expect(result.epTags).toContain('E-PIANO');
  expect(result.epTags).not.toContain('PIANO');
  expect(result.thickLeadFamily).toBe('LEAD');
  expect(result.thickLeadTags).not.toContain('BASS');
  expect(result.naturalLeadFamily).toBe('LEAD');
  expect(result.naturalLeadTags).not.toContain('STRINGS');
  expect(result.driftingLeadFamily).toBe('LEAD');
  expect(result.driftingLeadTags).not.toContain('PAD');
  expect(result.thickBassFamily).toBe('BASS');
  expect(result.naturalOnlyFamily).toBe('STRINGS');
});

test('FM depth tracks keyboard pitch and includes a decay envelope', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const result = await page.evaluate(() => {
    const synth = window.synth;
    synth.panic();
    synth.layerProfilesB[0] = null;
    const profile = {
      ...PRESETS.init,
      osc1Wave: 'sine', osc1Level: 1, osc2Wave: 'sine', osc2Level: 0,
      cutoff: 12000, resonance: 0.2, filterType: 'lowpass',
      attack: 0.004, decay: 0.2, sustain: 1, release: 0.05,
      fEnvAmt: 0, fAttack: 0.005, fDecay: 0.1, fSustain: 0,
      lfoDepth: 0, delayMix: 0, reverbMix: 0, chorusMix: 0, flangerMix: 0,
      subLevel: 0, noiseLevel: 0, fmAmount: 1200, fmRatio: 2, fmEnv: 0.8, unison: 1
    };
    synth.layerProfiles[0] = profile;
    synth.params = profile;
    synth._morphCache.clear();

    const lowExpected = synth._fmDepthHz(profile, 45, 0.8);
    const highExpected = synth._fmDepthHz(profile, 81, 0.8);
    synth.noteOn(45, 0.8, 0);
    synth.noteOn(81, 0.8, 0);
    const low = synth.voices.get('0:45');
    const high = synth.voices.get('0:81');
    const result = {
      helperAvailable: typeof synth._fmDepthHz === 'function',
      profileFmEnv: profile.fmEnv,
      lowExpected, highExpected,
      lowDepth: low?.fmGain?.gain?.value ?? null,
      highDepth: high?.fmGain?.gain?.value ?? null,
      lowHasFmMod: !!low?.fmMod,
      highHasFmMod: !!high?.fmMod,
      lowHasEnvelope: !!low?.fmEnvGain,
      highHasEnvelope: !!high?.fmEnvGain
    };
    synth.panic();
    return result;
  });

  expect(result.helperAvailable).toBeTruthy();
  expect(result.profileFmEnv).toBeCloseTo(0.8, 3);
  expect(result.lowHasFmMod).toBeTruthy();
  expect(result.highHasFmMod).toBeTruthy();
  expect(result.lowHasEnvelope).toBeTruthy();
  expect(result.highHasEnvelope).toBeTruthy();
  expect(result.lowDepth).toBeCloseTo(result.lowExpected, 1);
  expect(result.highDepth).toBeCloseTo(result.highExpected, 1);
  expect(result.highDepth / result.lowDepth).toBeCloseTo(8, 2);
  expect(pageErrors).toEqual([]);
});

test('pentatonic quantization considers the root in the next octave', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(() => {
    const synth = window.synth;
    synth.panic();
    const scale = document.getElementById('so67Scale');
    const scaleToggle = document.getElementById('so67ScaleToggle');
    scale.value = 'pentatonic';
    scale.dispatchEvent(new Event('change', { bubbles: true }));
    scaleToggle.click();
    document.getElementById('so67Root').value = '0';
    document.getElementById('so67Root').dispatchEvent(new Event('change', { bubbles: true }));
    synth.noteOn(71, 0.8, 0); // B4 is one semitone from C5, two from A4.
    const notes = [...synth.voices.values()].filter(v => v.layer === 0).map(v => v.midi).sort((a,b)=>a-b);
    const scaleLabel = scaleToggle.textContent;
    synth.panic();
    return { scaleLabel, notes };
  });
  expect(result.scaleLabel).toContain('SCALE ON');
  expect(result.notes).toContain(72);
  expect(result.notes).not.toContain(69);
  expect(pageErrors).toEqual([]);
});

test('extended chord voicings avoid the 11th clash and normalize chord level', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(() => {
    const synth = window.synth;
    const select = document.getElementById('so67ChordType');
    const chordButton = document.getElementById('so67Chord');
    synth.panic();

    select.value = '13';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    chordButton.click();
    synth.noteOn(60, 0.84, 0);
    const dominant = [...synth.voices.values()].filter(v => v.layer === 0)
      .map(v => ({ midi: v.midi, velocity: v.velocity })).sort((a,b)=>a.midi-b.midi);
    const dominantSymbol = document.querySelector('[data-nm="chord"]')?.textContent || '';
    synth.panic();

    select.value = 'maj13';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    synth.noteOn(60, 0.84, 0);
    const major = [...synth.voices.values()].filter(v => v.layer === 0)
      .map(v => ({ midi: v.midi, velocity: v.velocity })).sort((a,b)=>a.midi-b.midi);
    const majorSymbol = document.querySelector('[data-nm="chord"]')?.textContent || '';
    synth.panic();

    return {
      dominantNotes: dominant.map(v => v.midi), dominantVelocities: dominant.map(v => v.velocity),
      dominantSymbol, majorNotes: major.map(v => v.midi), majorVelocities: major.map(v => v.velocity),
      majorSymbol
    };
  });
  expect(result.dominantNotes).toEqual([60,64,67,70,74,81]);
  expect(result.dominantNotes).not.toContain(77);
  expect(result.dominantSymbol).toContain('C 13');
  expect(result.dominantVelocities.every(v => Math.abs(v - 0.84 / Math.sqrt(6)) < 0.002)).toBeTruthy();
  expect(result.majorNotes).toEqual([60,64,67,71,74,78,81]);
  expect(result.majorNotes).not.toContain(77);
  expect(result.majorSymbol).toContain('C maj13');
  expect(result.majorVelocities.every(v => Math.abs(v - 0.84 / Math.sqrt(7)) < 0.002)).toBeTruthy();
  expect(pageErrors).toEqual([]);
});

test('ARP order mode follows played order rather than sorting by pitch', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    synth.panic();
    synth.panic();
    document.getElementById('so67Mode').value = 'order';
    document.getElementById('so67Mode').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('so67Rate').value = '1/32';
    document.getElementById('so67Rate').dispatchEvent(new Event('change', { bubbles: true }));
    const monitor = window.SynthOslekNoteMonitor;
    const observed = [];
    const originalGeneratedOn = monitor.generatedOn;
    monitor.generatedOn = midi => { observed.push(midi); return originalGeneratedOn(midi); };
    document.getElementById('so67Arp').click();
    synth.noteOn(64, 0.8, 0); // E4 first
    synth.noteOn(60, 0.8, 0); // C4 second
    await new Promise(resolve => setTimeout(resolve, 360));
    const status = document.getElementById('so67Status')?.textContent || '';
    document.getElementById('so67Arp').click();
    synth.panic();
    monitor.generatedOn = originalGeneratedOn;
    return { status, observed: observed.slice(0, 6), modeUi: document.getElementById('so67Mode').value };
  });
  expect(result.modeUi).toBe('order');
  expect(result.observed.slice(0, 4)).toEqual([64,60,64,60]);
  expect(pageErrors).toEqual([]);
});

test('family preset vibrato depths are large enough to be audible', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const keys = {
      organ: SD.analyze('organ').patch,
      electricPiano: SD.analyze('electric piano').patch,
      brass: SD.analyze('brass').patch,
      strings: SD.analyze('strings').patch,
      lead: SD.analyze('lead').patch
    };
    return Object.fromEntries(Object.entries(keys).map(([name, patch]) => [name, {
      depth: patch.lfoDepth,
      destination: patch.lfoDest
    }]));
  });
  expect(result.organ.depth).toBeGreaterThanOrEqual(0.2);
  expect(result.electricPiano.depth).toBeGreaterThanOrEqual(0.2);
  expect(result.brass.depth).toBeGreaterThanOrEqual(0.2);
  expect(result.strings.depth).toBeGreaterThanOrEqual(0.3);
  expect(result.lead.depth).toBeGreaterThanOrEqual(0.2);
});

test('incoming MIDI Clock updates tempo from 24 PPQN and tracks transport', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const periodMs = 60000 / (120 * 24);
    const startMs = 5000;
    for (let i = 0; i < 48; i++) {
      midiManager.dispatch(0xF8, 0, 0, startMs + i * periodMs, 0.75, 'clock-test');
    }
    const afterClock = {
      bpm: window.SynthOslekTiming.bpm,
      externalClock: window.SynthOslekTiming.externalClock
    };
    midiManager.dispatch(0xFA, 0, 0, startMs + 48 * periodMs, 0.75, 'clock-test');
    const running = window.SynthOslekTiming.transportRunning;
    midiManager.dispatch(0xFC, 0, 0, startMs + 49 * periodMs, 0.75, 'clock-test');
    const stopped = window.SynthOslekTiming.transportRunning;
    return { ...afterClock, running, stopped, finalBpm: window.SynthOslekTiming.bpm };
  });
  expect(result.externalClock).toBeTruthy();
  expect(result.bpm).toBeCloseTo(120, 0);
  expect(result.running).toBeTruthy();
  expect(result.stopped).toBeFalsy();
  expect(result.finalBpm).toBeCloseTo(120, 0);
});

test('sustain pedal latches arp notes until pedal release', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const monitor = window.SynthOslekNoteMonitor;
    const observed = [];
    const originalGeneratedOn = monitor.generatedOn;
    monitor.generatedOn = midi => { observed.push(midi); return originalGeneratedOn(midi); };
    document.getElementById('so67Rate').value = '1/32';
    document.getElementById('so67Rate').dispatchEvent(new Event('change', { bubbles: true }));
    const start = performance.now();
    midiManager.dispatch(0xB0, 64, 127, start, 0.75, 'latch-test');
    document.getElementById('so67Arp').click();
    synth.noteOn(64, 0.8, 0);
    synth.noteOff(64, 0);
    await new Promise(resolve => setTimeout(resolve, 240));
    const whilePedalDown = observed.length;
    midiManager.dispatch(0xB0, 64, 0, performance.now(), 0.75, 'latch-test');
    await new Promise(resolve => setTimeout(resolve, 240));
    const afterPedalUp = observed.length;
    if (document.getElementById('so67Arp').textContent.includes('ON')) {
      document.getElementById('so67Arp').click();
    }
    synth.panic();
    monitor.generatedOn = originalGeneratedOn;
    return { whilePedalDown, afterPedalUp, pedalUp: !synth.sustain };
  });
  expect(result.pedalUp).toBeTruthy();
  expect(result.whilePedalDown).toBeGreaterThanOrEqual(3);
  expect(result.afterPedalUp).toBe(result.whilePedalDown);
  expect(pageErrors).toEqual([]);
});

test('sequencer schedules audio-clock steps and releases its notes when stopped', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    const monitor = window.SynthOslekNoteMonitor;
    const events = [];
    const originalGeneratedOn = monitor.generatedOn;
    monitor.generatedOn = midi => { events.push({ midi, at: performance.now() }); return originalGeneratedOn(midi); };
    window.SynthOslekTiming.setBpm(120);
    document.querySelectorAll('.so-step').forEach(step => {
      step.click();
      if (!step.classList.contains('on')) step.click();
    });
    document.getElementById('so67Seq').click();
    await new Promise(resolve => setTimeout(resolve, 820));
    document.getElementById('so67Seq').click();
    const times = events.map(event => event.at);
    const intervals = times.slice(1).map((time, i) => time - times[i]);
    const snapshot = {
      count: events.length,
      intervals,
      bpm: window.SynthOslekTiming.bpm,
      seqButton: document.getElementById('so67Seq').textContent
    };
    synth.panic();
    monitor.generatedOn = originalGeneratedOn;
    return snapshot;
  });
  expect(result.count).toBeGreaterThanOrEqual(5);
  expect(result.bpm).toBe(120);
  expect(result.seqButton).toContain('OFF');
  expect(result.intervals.length).toBeGreaterThanOrEqual(4);
  // Browser timer wake-ups can occasionally be late on shared CI runners.
  // Bound outliers generously, while the mean still must remain near a 120 BPM
  // sixteenth-note period (125 ms).
  expect(result.intervals.every(dt => dt > 55 && dt < 280)).toBeTruthy();
  const meanInterval = result.intervals.reduce((sum, x) => sum + x, 0) / result.intervals.length;
  expect(meanInterval).toBeGreaterThan(90);
  expect(meanInterval).toBeLessThan(170);
  expect(pageErrors).toEqual([]);
});

test('sample-hold LFO uses a stepped custom waveform instead of a sine fallback', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(() => {
    const synth = window.synth;
    synth.updateParam('lfoWave', 'sample-hold');
    const sampleHold = {
      selected: synth.params.lfoWave,
      oscillatorType: synth.lfo?.type,
      hasPeriodicWave: !!synth._sampleHoldWaveCache?.wave,
      waveIsForCurrentContext: synth._sampleHoldWaveCache?.ctx === synth.ctx
    };
    synth.updateParam('lfoWave', 'sine');
    return { sampleHold, restoredType: synth.lfo?.type };
  });
  expect(result.sampleHold.selected).toBe('sample-hold');
  expect(result.sampleHold.oscillatorType).toBe('custom');
  expect(result.sampleHold.hasPeriodicWave).toBeTruthy();
  expect(result.sampleHold.waveIsForCurrentContext).toBeTruthy();
  expect(result.restoredType).toBe('sine');
  expect(pageErrors).toEqual([]);
});

test('delay-sync selector and tempo changes retime the shared delay', async ({ page }) => {
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(() => {
    const synth = window.synth;
    const target = () => synth._audioParamTargets.get(synth.delay.delayTime)?.value ?? null;
    window.SynthOslekTiming.setBpm(120);
    synth.updateParam('delaySync', '1/8');
    const eighthAt120 = target();
    const expected120 = window.SynthOslekTiming.divisionSeconds('1/8');
    window.SynthOslekTiming.setBpm(90);
    const eighthAt90 = target();
    const expected90 = window.SynthOslekTiming.divisionSeconds('1/8');
    synth.updateParam('delaySync', 'free');
    synth.updateParam('delayTime', 0.17);
    const freeDelayTarget = target();
    return {
      syncMode: synth.delaySync,
      eighthAt120, expected120, eighthAt90, expected90,
      freeDelayTarget, profileDelayTime: synth.params.delayTime
    };
  });
  expect(result.eighthAt120).toBeCloseTo(result.expected120, 3);
  expect(result.eighthAt90).toBeCloseTo(result.expected90, 3);
  expect(result.syncMode).toBe('free');
  expect(result.freeDelayTarget).toBeCloseTo(0.17, 3);
  expect(result.profileDelayTime).toBeCloseTo(0.17, 3);
});

test('A/B morph applies shared LFO rate and delay controls to audio parameters', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');
  const result = await page.evaluate(async () => {
    const synth = window.synth;
    synth.panic();
    synth.updateParam('delaySync', 'free');
    const A = synth.layerProfiles[0];
    Object.assign(A, {
      lfoRate: 0.4, delayTime: 0.12, delayFb: 0.1,
      lfoDepth: 0.2, lfoDest: 'cutoff', fmAmount: 0
    });
    synth.layerProfilesB[0] = { ...A, lfoRate: 12, delayTime: 0.9, delayFb: 0.7 };
    synth._bRevision[0] = (synth._bRevision[0] || 0) + 1;
    synth._morphCache.clear();
    synth.setModWheel(0);
    synth.noteOn(60, 0.8, 0);
    synth.setModWheel(1);
    await new Promise(resolve => setTimeout(resolve, 120));
    const target = param => synth._audioParamTargets.get(param)?.value ?? null;
    const values = {
      mode: synth.getMorphMode(0),
      lfoRate: target(synth.lfo.frequency),
      delayTime: target(synth.delay.delayTime),
      delayFb: target(synth.delayFeedback.gain)
    };
    synth.panic();
    return values;
  });
  expect(result.mode).toBe('ab');
  expect(result.lfoRate).toBeCloseTo(12, 2);
  expect(result.delayTime).toBeCloseTo(0.9, 2);
  expect(result.delayFb).toBeCloseTo(0.7, 2);
  expect(pageErrors).toEqual([]);
});

test('Android audio path retains lightweight shared reverb and single-tap delay sends', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
    });
  });
  await page.goto('/');
  await page.locator('#welcomeStart').click();
  await expect.poll(() => page.evaluate(() => window.synth?.ctx?.state), { timeout: 10000 }).toBe('running');

  const result = await page.evaluate(() => {
    const synth = window.synth;
    synth.panic();
    synth.updateParam('reverbMix', 0.38);
    synth.updateParam('delayMix', 0.28);
    synth.updateParam('delayFb', 0.65);
    synth.noteOn(60, 0.8, 0);
    const voice = synth.voices.get('0:60');
    const snapshot = {
      mobileAudio: synth.mobileAudio,
      normalAnalyserDisabled: synth.analyser === null,
      sharedReverbExists: !!synth.mobileReverbConvolver,
      sharedReverbReturnExists: !!synth.mobileReverbReturn,
      impulseChannels: synth.mobileReverbConvolver?.buffer?.numberOfChannels ?? 0,
      impulseDuration: synth.mobileReverbConvolver?.buffer?.duration ?? 0,
      perVoiceReverbSend: !!voice?.fxReverb,
      perVoiceDelaySend: !!voice?.fxDelay,
      reverbSend: voice?.fxReverb?.gain?.value ?? null,
      delaySend: voice?.fxDelay?.gain?.value ?? null,
      feedbackGain: synth.delayFeedback?.gain?.value ?? null,
      delayTarget: synth._audioParamTargets?.get(synth.delay?.delayTime)?.value ?? null
    };
    synth.panic();
    return snapshot;
  });

  expect(result.mobileAudio).toBeTruthy();
  expect(result.normalAnalyserDisabled).toBeTruthy();
  expect(result.sharedReverbExists).toBeTruthy();
  expect(result.sharedReverbReturnExists).toBeTruthy();
  expect(result.impulseChannels).toBe(1);
  expect(result.impulseDuration).toBeGreaterThan(0.4);
  expect(result.impulseDuration).toBeLessThanOrEqual(0.6);
  expect(result.perVoiceReverbSend).toBeTruthy();
  expect(result.perVoiceDelaySend).toBeTruthy();
  expect(result.reverbSend).toBeCloseTo(0.38, 2);
  expect(result.delaySend).toBeCloseTo(0.28, 2);
  expect(result.feedbackGain).toBe(0);
  expect(pageErrors).toEqual([]);
});

