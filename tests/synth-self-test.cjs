"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer");

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: process.cwd(),
  stdio: "ignore"
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function serverReady() {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(700, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

(async () => {
  let browser;
  const pageErrors = [];
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await serverReady();
      if (!ready) await sleep(250);
    }
    assert.ok(ready, "Local HTTP server did not start.");

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--autoplay-policy=no-user-gesture-required"
      ]
    });
    const page = await browser.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });

    assert.match(await page.title(), /SynthOslek v16\.86/, "Unexpected page title.");
    assert.ok(await page.$("#soTopBpm"), "Top-bar BPM selector is missing.");
    assert.ok(await page.$("#welcomeStart"), "Start button is missing.");
    assert.ok(await page.$("#so67ChordType"), "Chord selector is missing.");

    await page.click("#welcomeStart");
    await page.waitForFunction(
      () => Boolean(window.synth?.started && window.synth?.ctx?.state === "running"),
      { timeout: 10000 }
    );

    await page.select("#soTopBpm", "128");
    await page.waitForFunction(
      () => Number(window.SynthOslekTiming?.bpm) === 128,
      { timeout: 2000 }
    );

    await page.select("#so67ChordType", "maj7");
    await page.click("#so67Chord");
    const runtime = await page.evaluate(() => {
      const synth = window.synth;
      const layer = synth.activeLayer;
      synth.noteOn(60, 0.8, layer);
      const chord = document.querySelector('[data-nm="chord"]')?.textContent || "";
      const activeVoices = synth.voices?.size || 0;
      synth.noteOff(60, layer);
      return {
        build: document.querySelector('meta[name="synthoslek-build"]')?.content || "",
        roadmapVersion: window.SynthOslekRoadmap?.version || "",
        audioState: synth.ctx?.state || "",
        bpm: Number(window.SynthOslekTiming?.bpm),
        chord,
        activeVoices
      };
    });

    assert.match(runtime.build, /v16\.86/, "Build marker isn't v16.86.");
    assert.equal(runtime.roadmapVersion, "16.86", "Runtime roadmap version mismatch.");
    assert.equal(runtime.audioState, "running", "AudioContext isn't running after Start.");
    assert.equal(runtime.bpm, 128, "BPM selector didn't update the shared tempo.");
    assert.match(runtime.chord, /C maj7/, `Expected a C maj7 chord name, received: ${runtime.chord}`);
    assert.match(runtime.chord, /C4/ , "Chord readout doesn't include the actual note names.");
    assert.ok(runtime.activeVoices >= 3, "Chord input did not create multiple voices.");

    if (pageErrors.length) {
      throw new Error("Uncaught page errors:\n" + pageErrors.join("\n"));
    }
    await page.evaluate(() => { document.body.dataset.testStatus = "SUCCESS"; });
    const status = await page.$eval("body", (body) => body.getAttribute("data-test-status"));
    assert.equal(status, "SUCCESS");
    console.log("TEST STATUS: SUCCESS");
    console.log(JSON.stringify(runtime, null, 2));
  } catch (error) {
    console.error("TEST STATUS: FAILURE");
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})();
