# Real G-code Playback

**Real G-code Playback** is an [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) plugin that adds a **Playback** tab: it plays your sliced G-code the way a printer would print it, in real time.

Each move is timed by a motion planner that models acceleration and cornering. The playback clock is synced to OrcaSlicer's own time estimate, so what you watch lines up with the print time OrcaSlicer reports.

## Features

- Play, pause, step move by move or layer by layer, and scrub a timeline at any speed from 0.01× to 10000×
- Timeline shows layer bands plus markers for filament changes, pauses and heating waits
- Live readout of the current layer, line type, actual vs. set speed, volumetric flow, acceleration and the G-code line being run
- G-code panel: scroll through the whole file; it follows playback, and clicking a line jumps to that moment
- Lines drawn with their actual cross-section from the G-code: scarf seams, Z contouring (Z anti-aliasing), variable-width walls and gap fill show their real width and height
- Colour by line type, actual speed, set speed, volumetric flow, line height, line width, layer time or filament
- Shading options: lit round lines, layer contrast, height shading or flat colours
- Print options: choose bed leveling, flow calibration, timelapse and the other printer flags in Bambu Lab G-code; blocks the printer would skip are not drawn or timed
- Moving-bed view for bed slingers such as the Bambu Lab A1 and A1 mini
- Picks up each new slice when you open the tab, and asks before replacing one you're already viewing
- Pauses when you leave the tab (optional)
- Export: videos (MP4, WebM, GIF) of the whole print, the current layer, a range of layers, the time between two events or any time span, at a chosen speed, size and frame rate; pictures (PNG, JPEG, WebP) of the 3D view or of the whole window with its panels
- Also opens `.gcode` and `.gcode.3mf` files directly

## Install

Requires an OrcaSlicer build with the Python plugin system (releases after 2.4.2, or a nightly).

1. Download [`dist/orca_playback.py`](dist/orca_playback.py).
2. In OrcaSlicer open **Plugins → Install local plugin** and pick the file, then activate it.
3. A **Playback** tab appears in the top bar.

### Recommended setup

In the **Process** settings (Advanced mode), go to **Others → Slicing Pipeline Plugin** and add **Playback capture**. New slices then load with no permission prompts. Bambu Lab printers are captured on every slice; other printers when you export or send.

Without it, **Latest slice** reads OrcaSlicer's temporary G-code instead, and OrcaSlicer asks once for read permission.

## Notes

- Read-only: never changes your G-code or model.
- No network access, and no files written outside the plugin's own folder.
- Exports: OrcaSlicer's page can't open a Save dialog, so videos and pictures are saved into the plugin's own `exports` folder, and the Export dialog shows the full path with a Copy button. Videos are rendered and encoded frame by frame, so their length, frame count and size are exactly what the dialog says, however fast the computer is. Inside OrcaSlicer the bundled WebAssembly encoders are used (H.264 for MP4, VP8 for WebM; about 10 frames a second at 1080p); in a browser that has WebCodecs, the graphics card's encoder.
- No extra Python packages to install.
- Heating time is not counted. Bed leveling counts as 260 s, as in OrcaSlicer's estimate.
- On Linux, OrcaSlicer's plugin sandbox blocks paths containing `conf` (its data folder is `~/.config/OrcaSlicer`), so Playback capture cannot work there; use Latest slice or open a file.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to make changes. Commit titles follow Conventional Commits (`feat: …`, `fix: …`). **Note:** a push to `main` that changes the version in `src/changelog.json` publishes that version to Orca Cloud (see [Releasing](#releasing)).

```
src/
  core.js        G-code parser and motion planner (no DOM; runs in node)
  app.js         the player: Three.js scene, timeline, HUD, G-code panel, options
  page.html      page layout and styles
  plugin.py      the OrcaSlicer plugin: Pages tab + slicing-pipeline capture step
  changelog.json single source for the version number and the changelog
build.py         assembles dist/orca_playback.py and dist/playback.html
test/            G-code generators, node tests, Playwright tests with a mock `orca` module
```

Build:

```
npm install          # three.js r147 and the export libraries, used only at build time
python3 build.py     # writes dist/orca_playback.py and dist/playback.html
```

`dist/playback.html` is the same player as a standalone page: open it in a browser and drop a G-code file on it.

Test (needs node, Python 3 and `pip install playwright && playwright install chromium`):

```
test/run_all.sh
```

## Releasing

The version in the plugin header, the in-app changelog and the plugin's docstring all come from `src/changelog.json`.

1. Add the new version at the top of `src/changelog.json` (and set `"version"` to it), then run `python3 build.py`.
2. Commit, including `dist/orca_playback.py`, and push to `main`.

[`.github/workflows/release-on-push.yml`](.github/workflows/release-on-push.yml) sees that the push changed the version and creates the GitHub release `v<version>` with that version's changelog entry as its notes. Pushes that don't change the version release nothing; commit messages are not looked at. It stops if the version already has a release, is not higher than the latest one, or `dist/orca_playback.py` is not rebuilt. To release a version that was bumped earlier without being released, run **Release on push** by hand from the Actions tab. You can also create a release by hand on GitHub with the tag `v<version>`.

Publishing the release runs [`.github/workflows/publish-orcacloud.yml`](.github/workflows/publish-orcacloud.yml), which finds the commit whose `dist/orca_playback.py` has that version and uploads that file to Orca Cloud as `real_gcode_playback_any.py`. Orca Cloud uses the tag as the version (it must be higher than the published one) and the release notes as that version's changelog; leave the notes empty to use the entry from `src/changelog.json`.

Earlier versions are uploaded the same way: create a release with the tag `v<old version>` on `main`, oldest first, and wait for each run to finish before the next. Orca Cloud only accepts uploads from release runs.

One-time setup: create a fine-grained personal access token for this repository with **Contents: Read and write**, and save it as the Actions secret `RELEASE_TOKEN` (GitHub doesn't start the publish workflow for releases made with the built-in token). In Orca Cloud, open **Edit plugin → GitHub publishing**, enter `Chungchiyu/real-gcode-playback` and click **Connect**; the upload itself needs no secret, because it signs in with a GitHub OIDC token.

## License

MIT, see [LICENSE](LICENSE). Bundles, all under the MIT License: [three.js](https://threejs.org) r147 (Copyright 2010-2022 Three.js Authors), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 and [webm-muxer](https://github.com/Vanilagy/webm-muxer) 5.1.4 (Copyright 2022-2023 Vanilagy), [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 (Copyright 2017 Matt DesLauriers), [h264-mp4-encoder](https://github.com/TrevorSundberg/h264-mp4-encoder) 1.0.12 (Copyright 2020 Trevor Sundberg). Also bundles [webm-wasm](https://github.com/GoogleChromeLabs/webm-wasm) 0.4.1 (Apache License 2.0, Copyright 2018 Google), which includes libvpx and libwebm (BSD-3-Clause); h264-mp4-encoder includes minih264 (public domain) and libmp4v2 (Mozilla Public License 1.1, source at https://github.com/TrevorSundberg/libmp4v2).
