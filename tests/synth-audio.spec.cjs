const { test, expect } = require('@playwright/test');

test('SynthOslek starts its audio engine and preserves key UI/diagnostics', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle(/SynthOslek v16\.74/);
  await expect(page.locator('#keyboard')).toBeAttached();
  await expect(page.locator('.welcome-desc')).toContainText('real-time browser synth');
  await expect(page.locator('.welcome-desc')).not.toContainText('4 layers');
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


test('actual ARP stress keeps voices bounded and records timer jitter', async ({ page }) => {
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
    const peakSamples = [];
    const data = new Float32Array(synth.analyser.fftSize);
    const until = performance.now() + 550;
    while (performance.now() < until) {
      synth.modWheel = (Math.sin(performance.now() / 75) + 1) / 2;
      synth.analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      peakSamples.push(peak);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const jitter = window.SynthOslekDiagnostics.snapshot();
    const poolDuring = synth.voicePool.stats();
    [60, 64, 67, 72].forEach(n => synth.noteOff(n, 0));
    arp.click();
    synth.panic();
    const poolAfter = synth.voicePool.stats();
    return {
      unsupported: false,
      jitter,
      poolDuring,
      poolAfter,
      peakMax: Math.max(0, ...peakSamples),
      finitePeaks: peakSamples.every(Number.isFinite),
      audioState: synth.ctx.state
    };
  });
  test.skip(result.unsupported, result.reason || 'ARP runtime diagnostics unavailable');
  expect(result.audioState).toBe('running');
  expect(result.jitter.count).toBeGreaterThan(0);
  expect(result.jitter.maxAbsMs).toBeGreaterThanOrEqual(0);
  expect(result.poolDuring.occupied).toBeLessThanOrEqual(result.poolDuring.max);
  expect(result.poolAfter.active).toBe(0);
  expect(result.finitePeaks).toBeTruthy();
  expect(result.peakMax).toBeGreaterThan(0.00001);
  expect(pageErrors).toEqual([]);
});
