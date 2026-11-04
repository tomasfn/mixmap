# Mixmap

See your Ableton Live set as a 3D mix map. Every track becomes a shape of light in a room, so you can see where each sound lives, what collides, and which parts of the spectrum are empty, bar by bar.

**Try it:** https://tomasfn.github.io/mixmap/ (there's a demo song if you don't have a set at hand)

Everything runs in your browser. Your project and audio never leave your computer.

## What you see

| Axis | Meaning |
| --- | --- |
| Height | Frequency, from sub at the floor to air at the top (log scale, 20 Hz–20 kHz) |
| Width | Stereo width of the sound; left/right position follows its balance |
| Depth | Level (K-weighted, close to LUFS). Louder sounds come forward |
| Color | The notes being played, beat by beat, on the circle of fifths (C is red, like Scriabin's wheel). Saturation is how tonal the sound is; brightness is how bright it sounds |

On top of that:

- **Pulse.** Shapes pulse with each track's own rhythm, in sixteenth notes. Press play to watch the song at its real tempo.
- **Clashes.** Pairs of tracks that share most of their energy in the same bar are outlined in amber, with the frequency range where they overlap.
- **Empty zones.** Parts of the spectrum where nothing is playing in that bar.
- **Insights.** A few plain-language findings for the whole song: everything panned to the center, a low-heavy balance, a crowded band, silent tracks, gaps in the arrangement.
- **Timeline.** A miniature arrangement. In synesthesia mode each bar takes the color of its notes.

## How to use it

1. In Live, save your set. Run **File → Collect All and Save** so every sample sits inside the project folder.
2. For the most accurate map, export stems: **File → Export Audio/Video**, set **Rendered Track** to **All Individual Tracks**, start at bar 1, and save them into the project folder.
3. Open Mixmap and drop the whole project folder (or click **Choose folder**).

When the map is ready you can **Save map file** (`.mixmap.json`). It holds only the analysis, not your audio, so you can send it to someone and they can open it in Mixmap.

### What is measured and what is estimated

| Track | Source | Accuracy |
| --- | --- | --- |
| Any track with an exported stem | The stem | Measured, including effects, volume and pan |
| Audio track without a stem | Its clip samples, with clip gain, transposition, warp, track volume and pan | Measured, but effects aren't included |
| MIDI track without a stem | Its notes, played through a generic synth model | Estimated. Level and tone are approximate |

Stems are matched to tracks by name. Live's default export names (`Set Name Track Name.wav`) work as they are. You can also drop only stems, with no `.als`; set the tempo under **Options**.

## Limitations

- Tempo and time-signature changes are ignored. The map uses the set's base tempo.
- Automation, sends and return tracks are not part of the analysis unless they're baked into stems.
- Group tracks are skipped, so their children aren't counted twice.
- Tested with Live 12 sets. Live 10 and 11 use the same format and should work.

## Development

```bash
npm install
npm run dev        # http://localhost:5174
npm run demo       # regenerates public/demo.mixmap.json from a synthetic song (add -- --wav to write the stems too)
npm run lint
npm run build      # typecheck + production build into dist/
```

There is no build step for the analysis beyond Vite. The code is plain TypeScript:

- `src/als.ts` reads `.als` files (gzipped XML): tracks, mixer, clips, loops, warp markers and MIDI notes.
- `src/dsp.ts` holds the FFT, 1/3-octave bands, K-weighting and pitch-class profiles.
- `src/analyze.ts` turns audio, or notes, into one frame per bar.
- `src/build.ts` matches stems to tracks and maps clip playback back onto the arrangement.
- `src/viewer.ts` is the three.js scene, panel and timeline.

The demo song is generated from code in `scripts/make-demo.ts`. Node 22.6+ runs it directly; it uses the same analysis code as the app.

## License

MIT. Mixmap is an independent project and is not affiliated with or endorsed by Ableton.
