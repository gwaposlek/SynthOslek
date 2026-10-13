# SynthOslek

**A single-file, browser-based morphing synthesizer.** Describe a sound in plain words, play it on screen or with a MIDI keyboard, and sweep a single MOD wheel to morph from the sound you asked for (**A**) to an expanded, richer version of it (**B**).

`v16.86` · Pure HTML/CSS/JavaScript · Web Audio API · No build step · No dependencies

---

## Highlights

- **A/B Morph instrument.** One control (MOD wheel, MIDI CC1, or phone tilt) moves between the sound you described and a deeper version of it. Each instrument family (organ, piano, e-piano, brass, strings, bass, pluck, pad, lead) has its own expansion rules.
- **Text-to-sound designer.** Type something like `warm gospel organ` or `bright 80s synth brass`. A built-in keyword and synonym engine maps your words to synth parameters. It runs entirely in the browser (rule-based, no network calls or AI service).
- **Autocomplete vocabulary** that suggests descriptive words as you type.
- **Surprise Me.** Generates a random hybrid A/B pair (for example, organ crossed with strings).
- **Recent pairs strip.** Recalls your last 8 generated pairs, including the morph position.
- **Two-layer engine** with per-layer volume, pan, FX send, mute, solo and enable, plus A/B snapshot capture.
- **Performance tools:** arpeggiator, 16-step sequencer, scale quantizer, chord generator (triads through 13ths), split/stack routing, 4 scene slots.
- **Live visuals:** oscilloscope and spectrum view, active-key highlighting, runtime audio diagnostics.

## Quick start

SynthOslek is one HTML file, so there is nothing to install.

1. Download or clone this repository.
2. Open `index.html` in a modern browser (rename the file if yours is named differently).
3. Click **START** (browsers require a user gesture before audio can begin).
4. Type a sound, click **MAKE A SOUND**, play the keys, and move the **MOD** wheel.

You can also host it on GitHub Pages: *Settings → Pages → Deploy from branch → `main` / root*.

> Note: the title font (Oxanium) loads from Google Fonts. Offline, the app falls back to system fonts and works normally.

## Browser support

| Feature | Chrome / Edge | Firefox | Safari / iOS |
|---|---|---|---|
| Synth and on-screen keyboard | Yes | Yes | Yes |
| Web MIDI (USB keyboards) | Yes | Yes (with permission prompt) | No |
| Bluetooth LE MIDI | Yes | No | No |
| Gyro morph | Android Chrome; iOS Safari (asks permission) | Limited | iOS Safari |

Chrome or Edge on desktop or Android gives the full experience.

## Controls

### Playing
| Control | Action |
|---|---|
| On-screen keys | Click or touch. Drag across keys for glissando. |
| **MOD wheel** | Morph between A and B (0 → 1). |
| **PITCH wheel** | Pitch bend (±200 cents), springs back to center. |
| **Oct − / Oct +** | Shift the on-screen keyboard by octaves. |
| **Panic** or `Esc` | Silence all voices. |
| `` ` `` (backtick) | Toggle MIN / ADV view. |

### MIDI
| Message | Action |
|---|---|
| CC 1 | Mod wheel → morph |
| CC 7 | Master volume |
| CC 10 | Pan (active layer) |
| CC 64 | Sustain pedal |
| CC 20–23 / 28–31 / 36–39 / 44–47 | Layer volume / pan / FX / enable |
| CC 120 / 121 / 123 | All sound off / reset controllers / all notes off |
| Pitch bend | ±200 cents |

Connect a USB MIDI keyboard (auto-detected) or press **BT MIDI** for a Bluetooth LE MIDI device. The app remembers your last device and tries to reconnect.

### Gyro (phones)
Tilt to morph and bend. Tap **▾** to choose an axis layout; long-press **GYRO** to recalibrate.

## MIN and ADV modes

- **MIN** (default): sound prompt, Surprise Me, scope, keyboard, wheels, recent pairs.
- **ADV** (`⚙ ADV`): adds the layer mixer, scenes, MIDI routing, help panel and the performance section (arpeggiator, sequencer, scale/chord, split routing, mod matrix, FM layer, sample layer, recording, preset sharing).

## Performance section (ADV)

- **Arpeggiator:** up, down, up/down, random and order; rate 1/1 to 1/32; 1–4 octaves; gate length.
- **Step sequencer:** 8 or 16 steps; export the pattern as a `.mid` file.
- **Scale and chord:** Major, Minor, Dorian, Mixolydian, Pentatonic and Blues with any root; chord types from triads to 13ths.
- **Tempo:** BPM selector in the top bar (60 to 200).
- **Recording:** captures the output and downloads a `.webm` or `.ogg` file.
- **Presets:** save locally, download as JSON, or copy a shareable link.

## How the morph works

1. Your text produces **patch A** (oscillators, filter, envelopes, effects).
2. **Patch B** is derived from A using family-specific rules (for example, pads get longer attack and release, wider unison and more reverb), plus a deterministic variation seeded from the patch itself.
3. The MOD wheel interpolates the two. Time and frequency parameters use geometric (exponential) interpolation; most others use linear.
4. If two layers hold different sounds, the wheel instead crossfades the layers. With neither, it applies a "macro" morph (brighter, wider, wetter).

## Project structure

```
index.html   # the entire application (HTML + CSS + JS)
README.md
```

Main code sections inside the file: synth engine (`SynthOslek`), voice pool, morph/pair system, sound-designer rules (`SD`), pair memory, keyboard and wheels, gyro, BLE/Web MIDI managers, performance layer (arp, sequencer, music theory), diagnostics panel.

## Known limitations

- MPE is present in the code but disabled.
- Some parameters (glide, mono/legato mode, delay sync) are in the data model but not fully wired to the audio engine yet.
- Android mode uses a lighter audio graph (reduced reverb, chorus and unison) to protect performance.
- Safari lacks Web MIDI and Web Bluetooth, so use the on-screen keyboard there.

## Contributing

Issues and pull requests are welcome. For bugs, please include your browser, OS, and (if relevant) your MIDI device. The **Audio stats** button (bottom right) can copy a diagnostics report to paste into an issue.

## License

Add your license here (for example MIT) and include a `LICENSE` file.

---

*Built by [your name]. SynthOslek: type a sound, play it, morph it.*
