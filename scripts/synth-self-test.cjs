'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const REPORT_PATH = path.join(ROOT, 'test-results', 'synth-self-test.json');
const html = fs.readFileSync(INDEX_PATH, 'utf8');
const checks = [];

function pass(name, detail) {
  checks.push({ name, status: 'PASS', detail: detail || '' });
  console.log('PASS:', name, detail || '');
}

function requireCheck(condition, message) {
  assert.ok(condition, message);
}

async function main() {
  let browser;
  let server;
  try {
    const build = html.match(/<meta\s+name=["']synthoslek-build["']\s+content=["']([^"']+)["']/i);
    const title = html.match(/<title>([\s\S]*?)<\/title>/i);
    const footer = html.match(/<div class=["']footer["']>([\s\S]*?)<\/div>/i);
    const version = html.match(/SynthOslek v(\d+\.\d+)/);
    const buildVersion = build?.[1]?.match(/v(\d+\.\d+)/)?.[1];
    requireCheck(build && version && buildVersion === version[1], 'Build metadata must match the visible semantic version.');
    requireCheck(title && title[1].includes('v' + version[1]), 'Browser title must match the visible semantic version.');
    requireCheck(footer && footer[1].includes('v' + version[1]), 'Visible footer must match the visible semantic version.');
    pass('Build/version labels', build[1]);

    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => ({ tag: match[0].slice(0, match[0].indexOf('>') + 1), source: match[1] }))
      .filter(item => item.source.trim().length > 0);
    requireCheck(scripts.length === 3, 'Expected 3 non-empty inline scripts; found ' + scripts.length + '.');
    scripts.forEach((item, index) => {
      new vm.Script(item.source, { filename: 'index.html:inline-script-' + (index + 1) });
    });
    pass('Inline JavaScript syntax', scripts.length + ' script blocks compile');

    const requiredSelectors = [
      '#welcomeStart',
      '#stxt',
      '#bleMidiBtn',
      '#so67',
      '#so67Arp',
      '#so67Gate',
      '#soTopBpm',
      '#so67Chord',
      '#so67ChordType'
    ];
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/' || pathname === '/index.html') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        });
        response.end(html);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = 'http://127.0.0.1:' + address.port + '/index.html?test=true';

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => (
      !!window.synth &&
      !!window.SynthOslekRoadmap &&
      typeof window.startSynthOslekFromGesture === 'function' &&
      !!document.querySelector('#welcomeStart')
    ), { timeout: 12000 });

    const preflight = await page.evaluate(selectors => ({
      version: String(window.SynthOslekRoadmap.version),
      title: document.title,
      build: document.querySelector('meta[name="synthoslek-build"]')?.content || '',
      selectors: Object.fromEntries(selectors.map(selector => [selector, !!document.querySelector(selector)])),
      methods: {
        noteOn: typeof window.synth.noteOn,
        noteOff: typeof window.synth.noteOff,
        panic: typeof window.synth.panic,
        setBend: typeof window.synth.setBend,
        setModWheel: typeof window.synth.setModWheel
      }
    }), requiredSelectors);
    requireCheck(preflight.version === '16.89', 'Runtime version mismatch: ' + preflight.version + '.');
    requireCheck(preflight.selectors && Object.values(preflight.selectors).every(Boolean),
      'Missing UI elements: ' + Object.entries(preflight.selectors).filter(([, exists]) => !exists).map(([key]) => key).join(', '));
    for (const method of ['noteOn', 'noteOff', 'panic']) {
      requireCheck(preflight.methods[method] === 'function', 'Missing synth method ' + method + '.');
    }
    pass('Page/UI initialization', 'Runtime API and required controls are present');

    const browserConsoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') browserConsoleErrors.push(message.text());
    });
    await page.click('#welcomeStart');
    await page.waitForFunction(() => {
      const status = document.querySelector('#stxt')?.textContent || '';
      return (
        (!!window.synth?.started && window.synth.ctx?.state === 'running') ||
        status.includes('Audio start failed') ||
        document.querySelector('#errorScreen')?.style.display === 'block'
      );
    }, { timeout: 6500 }).catch(() => {});
    const startup = await page.evaluate(() => ({
      started: !!window.synth?.started,
      audioState: window.synth?.ctx?.state || 'missing',
      statusText: document.querySelector('#stxt')?.textContent || '',
      errorText: document.querySelector('#errorText')?.textContent || '',
      errorDetail: document.querySelector('#errorDetail')?.textContent || '',
      errorScreenVisible: document.querySelector('#errorScreen')?.style.display === 'block'
    }));
    const startupReady = startup.started && startup.audioState === 'running';
    if (!startupReady) {
      throw new Error('Audio startup did not reach ready state: ' + JSON.stringify({ startup, pageErrors, browserConsoleErrors }));
    }
    requireCheck(pageErrors.length === 0, 'Browser runtime errors after startup: ' + pageErrors.join(' | '));
    pass('Audio engine startup', 'AudioContext is running; UI status: ' + startup.statusText);

    // The top-bar BPM roulette must change by one BPM per arrow key and
    // keep the shared clock used by the ARP/sequencer in sync.
    await page.focus('#soTopBpm');
    await page.keyboard.press('ArrowUp');
    const oneStepResult = await page.evaluate(() => ({
      selected: document.querySelector('#soTopBpm')?.getAttribute('aria-valuenow') || '',
      clock: Number(window.SynthOslekTiming?.bpm)
    }));
    requireCheck(oneStepResult.selected === '121' && oneStepResult.clock === 121,
      'BPM roulette did not increment exactly one BPM: ' + JSON.stringify(oneStepResult));
    await page.evaluate(() => document.querySelector('#soTopBpmList [data-bpm="128"]')?.click());
    const bpmResult = await page.evaluate(() => ({
      selected: document.querySelector('#soTopBpm')?.getAttribute('aria-valuenow') || '',
      clock: Number(window.SynthOslekTiming?.bpm)
    }));
    requireCheck(bpmResult.selected === '128' && bpmResult.clock === 128,
      'BPM roulette and shared clock disagree: ' + JSON.stringify(bpmResult));
    pass('Top-bar BPM wheel', 'One-BPM keyboard step and 128 BPM wheel selection reached the shared clock');

    // Verify the named chord readout agrees with the notes actually generated.
    await page.select('#so67ChordType', 'maj7');
    const chordResult = await page.evaluate(() => {
      const button = document.querySelector('#so67Chord');
      if (!button) throw new Error('Chord toggle is missing.');
      // DOM click exercises the real handler without relying on the control's
      // current layout/viewport position in a headless browser.
      if (window.SynthOslekRoadmap.state.music.chord === 'off') button.click();
      const synth = window.synth;
      synth.panic();
      synth.noteOn(60, 0.7, 0);
      const display = document.querySelector('[data-nm="chord"]')?.textContent || '';
      const activeVoices = synth.voices.size;
      synth.noteOff(60, 0);
      synth.panic();
      if (window.SynthOslekRoadmap.state.music.chord !== 'off') button.click();
      return { display, activeVoices };
    });
    requireCheck(/C maj7/.test(chordResult.display),
      'Expected the displayed chord name to be C maj7; received: ' + chordResult.display);
    requireCheck(['C4', 'E4', 'G4', 'B4'].every(note => chordResult.display.includes(note)),
      'Chord readout does not list the exact C maj7 notes: ' + chordResult.display);
    requireCheck(chordResult.activeVoices >= 3,
      'C maj7 did not create multiple voices: ' + chordResult.activeVoices);
    pass('Named chord display', chordResult.display + ' (' + chordResult.activeVoices + ' voices)');

    const noteResult = await page.evaluate(() => {
      const synth = window.synth;
      synth.panic();
      synth.noteOn(60, 0.7, 0);
      const voicesAfterOn = synth.voices.size;
      synth.noteOff(60, 0);
      const voicesAfterOff = synth.voices.size;
      synth.panic();
      return { voicesAfterOn, voicesAfterOff };
    });
    requireCheck(noteResult.voicesAfterOn > 0, 'A test note did not create an active voice.');
    requireCheck(noteResult.voicesAfterOff === 0, 'Note-off left ' + noteResult.voicesAfterOff + ' active voices.');
    pass('Note-on/note-off lifecycle', 'voices ' + noteResult.voicesAfterOn + ' → ' + noteResult.voicesAfterOff);

    const capResult = await page.evaluate(() => {
      const synth = window.synth;
      synth.panic();
      for (let midi = 42; midi < 74; midi++) synth.noteOn(midi, 0.45, 0);
      const active = synth.voices.size;
      const cap = synth.mobileAudio ? 12 : 24;
      synth.panic();
      return { active, cap, afterPanic: synth.voices.size };
    });
    requireCheck(capResult.active > 0 && capResult.active <= capResult.cap,
      'Voice protection failed: ' + capResult.active + ' active voices, expected ≤ ' + capResult.cap + '.');
    requireCheck(capResult.afterPanic === 0, 'Panic did not clear active voices.');
    pass('Polyphony pressure/panic', capResult.active + '/' + capResult.cap + ' active voices; panic cleared');

    // Exercise the actual ARP control and timer path, not just the presence of its UI.
    await page.evaluate(() => {
      const control = document.querySelector('#so67Arp');
      if (!control) throw new Error('ARP control is missing from the document.');
      control.click();
    });
    const arpEnabled = await page.evaluate(() => window.SynthOslekRoadmap.state.arp.on === true);
    requireCheck(arpEnabled, 'ARP control click handler did not enable ARP.');
    await page.evaluate(() => window.synth.noteOn(60, 0.6, 0));
    await new Promise(resolve => setTimeout(resolve, 700));
    const arpResult = await page.evaluate(() => ({
      held: window.SynthOslekRoadmap.state.arp.on,
      timingSamples: window.SynthOslekDiagnostics?.snapshot?.().count ?? 0,
      active: window.synth.voices.size
    }));
    await page.evaluate(() => {
      window.synth.panic();
      const control = document.querySelector('#so67Arp');
      if (control && window.SynthOslekRoadmap.state.arp.on) control.click();
    });
    requireCheck(arpResult.timingSamples > 0, 'ARP scheduler did not produce a timing sample.');
    requireCheck(pageErrors.length === 0, 'Browser runtime errors during note/ARP test: ' + pageErrors.join(' | '));
    pass('ARP scheduler smoke test', arpResult.timingSamples + ' scheduler timing sample(s)');

    const finalStatus = await page.evaluate(() => ({
      audioState: window.synth.ctx?.state || 'missing',
      voices: window.synth.voices.size,
      runtimeVersion: String(window.SynthOslekRoadmap.version)
    }));
    requireCheck(finalStatus.runtimeVersion === '16.89', 'Final runtime version changed unexpectedly.');
    requireCheck(finalStatus.voices === 0, 'Test cleanup left ' + finalStatus.voices + ' active voices.');
    requireCheck(finalStatus.audioState === 'running', 'Audio context ended in state ' + finalStatus.audioState + '.');
    pass('Test cleanup', 'Audio engine remains running; no active voices left');

    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    const report = {
      status: 'SUCCESS',
      version: '16.89',
      testedCommit: process.env.GITHUB_SHA || 'local',
      checks
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\nSELF-TEST SUCCESS: ' + checks.length + ' checks passed.');
  } catch (error) {
    console.error('\nSELF-TEST FAILED:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
