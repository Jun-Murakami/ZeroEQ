# ZeroEQ

A **zero-latency**, spectrum-analyzer-integrated parametric equalizer for broadcast, streaming, live, and mastering work. 11 fixed-slot bands of minimum-phase IIR (2× HPF + Low Shelf + 6× Bell + High Shelf + LPF), with per-band drag, overlaid on a Pre / Post FFT analyzer. Built with JUCE + WebView (Vite / React 19 / MUI 7). Ships as VST3 / AU / AAX / Standalone, plus a WebAssembly browser demo that reuses the exact same DSP.

You can find the demo site running on WebAssembly here.
https://zeroeq-demo.web.app/

<img width="1003" height="706" alt="sc_zeroeq" src="https://github.com/user-attachments/assets/6c49c8a4-a18d-455d-aaf3-981998c5f7a5" />

## Highlights

- **0-sample latency** — all bands are minimum-phase IIR biquads. No lookahead, no oversampling, no linear-phase FFT. Null-tests bit-identical with the input when every band is OFF (or Bypass is on).
- **11 fixed-slot bands** — 2× High Pass (left) + Low Shelf + 6× Bell + High Shelf + Low Pass (right). Each band is colour-coded and draggable directly on the spectrum. No add/remove operations; the layout is always the same, which makes muscle memory transferable across sessions.
- **High Pass / Low Pass with proper Butterworth Q** — slopes of 6 / 12 / 18 / 24 / 36 / 48 dB/oct. Each cascaded biquad stage is assigned the correct Butterworth Q (e.g. 24 dB/oct uses `Q = 0.5412, 1.3066`) so the default response is maximally flat at unity "resonance". The node's `Gain` control multiplies each stage's Q uniformly, acting as a continuous resonance dial.
- **Integrated Pre / Post analyzer** — 4096-point Hann-windowed FFT, 256 log-frequency display bins (20 Hz..22 kHz). Pre (source) and Post (post-EQ) are both emitted and drawn as translucent fills with a Post outline. Analyzer can be toggled Off from the top-right button for zero-CPU headroom mode.
- **Interactive node editor** — drag any node to change Freq + Gain (or "peak height" for HP/LP). Scroll-wheel over a node adjusts Q (for Bell/Shelf/Notch) or steps through slope values (for HP/LP). Ctrl/Cmd+click resets a single band. `Reset All` clears everything back to defaults.
- **Variable vertical scale** — ±3 / ±6 / ±12 / ±24 / ±32 dB toggle in the top-left. The grid and node hit-testing follow the selected range instantly.
- **Adaptive node tooltip** — hovering or dragging a node shows Freq / Gain / Q (or Slope) on a frosted-glass chip rendered in a Portal, so it always stays on top and never gets clipped by the canvas.
- **60 Hz UI** — meters and spectrum refresh at 60 Hz (vsync-friendly). Smoothing coefficients are matched to the new rate so perceived attack/release feel identical to the previous 30 Hz build.
- **Output stage** — dedicated -24..+24 dB Output Gain fader on the right, independent from the band gains.
- **I/O metering** — Peak / RMS / Momentary LKFS (ITU-R BS.1770-4) are all computed every block and broadcast together. Out meter is displayed with its own dB scale.
- **Stereo-true** — identical coefficients and envelope state per band, applied channel-by-channel, so the stereo image is preserved end-to-end.
- **WebAssembly demo** — the same C++ DSP (11-band EQ + Pre/Post FFT analyzer + meters) compiled to WASM and driven by an `AudioWorklet`. The React UI is reused verbatim via a Vite alias that swaps `juce-framework-frontend-mirror` for a web shim that forwards parameter changes to the worklet.

## Layout

- **Main canvas** — overlaid Pre/Post spectrum + EQ transfer curve + 11 coloured band nodes. X = log-frequency (20 Hz..22 kHz), Y = gain (±N dB depending on scale toggle). Drag a node to change Freq + Gain; scroll over a node for Q (or slope). Double-click to toggle On/Off.
- **Top-left overlay** — scale toggle (±3 / ±6 / ±12 / ±24 / ±32).
- **Top-right overlay** — `Reset All` and `Spectrum` (Off/On) toggles.
- **Right strip** — OUT L / R level meters with a -30..0 dB scale.
- **Bottom rail** — per-band column: On/Off switch (filter-icon), Gain knob, Freq knob, Q knob or Slope select, each with inline numeric input.
- **Right column** — Output Gain fader (-24..+24 dB).

The plugin window is resizable (minimum 875 × 450, default 875 × 450).

## Band types

| Type | Use | Notes |
| --- | --- | --- |
| **High Pass** | Rumble / subsonic removal | Slopes 6 / 12 / 18 / 24 / 36 / 48 dB/oct. Per-stage Butterworth Q — maximally flat at "Gain = 0 dB". Positive Gain acts as a resonance boost on the cutoff. |
| **Low Shelf** | Warmth, bass tilt | RBJ shelf biquad at the specified corner. |
| **Bell** | Surgical cuts, broad sweeps | RBJ peaking biquad. Q controls bandwidth. |
| **High Shelf** | Air, top-end tilt | RBJ shelf biquad. |
| **Low Pass** | De-essing, lo-fi | Slopes 6 / 12 / 18 / 24 / 36 / 48 dB/oct. Same Butterworth design as HP. |
| **Notch** | Surgical kill (60 Hz hum, feedback) | Full extinction at fc. Selected via the per-band `BAND{i}_TYPE` parameter (not directly exposed by the fixed layout, but supported by the DSP). |

Linear-phase / natural-phase / dynamic-EQ / mid-side modes are on the roadmap; current implementation is minimum-phase, full-stereo only.

## Requirements

- CMake 3.22+
- C++17 toolchain
  - Windows: Visual Studio 2022 with the C++ workload
  - macOS: Xcode 14+
- Node.js 18+ and npm (for the WebUI)
- JUCE (included as a submodule)
- Optional: AAX SDK for Pro Tools builds (drop at `aax-sdk/`)
- Optional: Inno Setup 6 for the Windows installer
- Optional: [Emscripten](https://emscripten.org) for the WebAssembly demo

## Getting started

```bash
# 1. Clone with submodules
git clone <this-repo>
cd ZeroEQ
git submodule update --init --recursive

# 2. WebUI dependencies
cd webui && npm install && cd ..

# 3. Build (Windows, Release distribution)
powershell -ExecutionPolicy Bypass -File build_windows.ps1 -Configuration Release
# → produces releases/<VERSION>/ZeroEQ_<VERSION>_Windows_VST3_AAX_Standalone.zip
#   and (if Inno Setup 6 is installed) ZeroEQ_<VERSION>_Windows_Setup.exe

# 4. Build (macOS)
./build_macos.zsh
```

### Manual CMake build (for development)

```bash
# Windows (Debug)
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Debug --target ZeroEQ_VST3

# macOS (Debug)
cmake -B build -G Xcode
cmake --build build --config Debug --target ZeroEQ_VST3
```

### Development mode (hot-reload WebUI)

```bash
# Terminal A: Vite dev server
cd webui && npm run dev

# Terminal B: Debug build of the plugin
cmake --build build --config Debug --target ZeroEQ_Standalone
```

Debug builds load the WebUI from `http://127.0.0.1:5173`. Release builds embed the bundled assets via `juce_add_binary_data`.

### Web demo (WebAssembly)

The same C++ EQ + analyzer DSP is compiled to WebAssembly and driven by an `AudioWorklet` in the browser. The React UI is reused verbatim; a Vite alias swaps `juce-framework-frontend-mirror` for a local shim that owns the parameter state (58 params: 3 global + 11 bands × 5-6 fields each) and forwards every change to the AudioWorklet.

```bash
# Build the WASM module (requires emsdk activated in the shell)
cd wasm
bash build.sh        # emits webui/public-web/wasm/zeroeq_dsp.wasm
# Windows alternative (system Python 3.9 fails; use the emsdk-bundled 3.13):
#   $env:PATH = 'D:\...\emsdk\python\3.13.3_64bit;' + $env:PATH
#   & 'D:\...\emsdk\emsdk_env.ps1'
#   Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
#   mkdir build; cd build
#   emcmake cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build .
#   Copy-Item -Force dist\zeroeq_dsp.wasm ..\dist\
#   Copy-Item -Force dist\zeroeq_dsp.wasm ..\..\webui\public-web\wasm\

# Start the web-demo dev server
cd ../webui
npm run dev:web      # http://127.0.0.1:5174

# Production bundle
npm run build:web    # dist/ ready for static hosting

# Firebase Hosting deploy
npm run deploy:web   # requires firebase CLI + zeroeq-demo project
```

The WASM binary is ~44 KB (Release -O3) and contains the full 11-band EQ + Pre/Post 4096-point FFT analyzer + meters. On Web, the UI sits inside a fixed-size card (960 × 650) with a transport bar above and a short description below.

## Parameters

Global:

| ID              | Type   | Range                          | Default   | Notes                                                   |
| --------------- | ------ | ------------------------------ | --------- | ------------------------------------------------------- |
| `BYPASS`        | bool   | off / on                       | off       | Bit-identical passthrough when on.                      |
| `OUTPUT_GAIN`   | float  | -24..+24 dB                    | 0 dB      | Applied after the band chain.                           |
| `ANALYZER_MODE` | choice | Off / Pre / Post / Pre+Post    | Pre+Post  | Controls which FFTs run and are emitted to the UI.      |

Per band (`i = 0..10`; slot roles are fixed in the UI layout):

| ID              | Type   | Range                                                    | Default (slot-dependent)    |
| --------------- | ------ | -------------------------------------------------------- | --------------------------- |
| `BAND{i}_ON`    | bool   | off / on                                                 | HPF/LPF: off, others: on    |
| `BAND{i}_TYPE`  | choice | Bell / LowShelf / HighShelf / HighPass / LowPass / Notch | per slot (fixed visually)   |
| `BAND{i}_FREQ`  | float  | 20..20000 Hz (log)                                       | log-distributed             |
| `BAND{i}_GAIN`  | float  | -32..+32 dB                                              | 0 dB                        |
| `BAND{i}_Q`     | float  | 0.1..18 (log)                                            | 1.0 (Bell) / 0.707 (Shelf)  |
| `BAND{i}_SLOPE` | choice | 6 / 12 / 18 / 24 / 36 / 48 dB/oct                        | 18 dB/oct                   |

`BAND{i}_Q` is used by Bell / LowShelf / HighShelf / Notch. `BAND{i}_SLOPE` and `BAND{i}_GAIN` (as a resonance-multiplier) are used by HighPass / LowPass.

## DSP details

### Biquad / state

Each band instantiates up to **5 cascaded biquad stages** (enough for an 8th-order filter = 4 biquads + optional 1st-order). All filtering is done in Transposed Direct Form II with per-channel state. Coefficients come from the RBJ cookbook and are rebuilt whenever a band's parameters change; the old state is kept to avoid click-on-change artefacts.

### HP / LP: Butterworth per-stage Q

Slopes 6 / 12 / 18 / 24 / 36 / 48 dB/oct decompose as:

| dB/oct | Order | Biquads (Q values)                            | 1st-order |
| ------ | ----- | --------------------------------------------- | --------- |
| 6      | 1     | —                                             | ✓         |
| 12     | 2     | 0.7071                                        | —         |
| 18     | 3     | 1.0                                           | ✓         |
| 24     | 4     | 1.3066, 0.5412                                | —         |
| 36     | 6     | 1.9319, 0.7071, 0.5178                        | —         |
| 48     | 8     | 2.5629, 0.9000, 0.6013, 0.5098                | —         |

At `Gain = 0 dB` the response is exactly Butterworth (maximally flat, no resonance peak). Moving Gain up/down multiplies every stage's Q by `10^(gainDb/20)`, preserving the per-stage Q ratio and widening/narrowing the knee uniformly.

### Analyzer

4096-point Hann-windowed FFT with hop = 2048. Audio samples are downmixed to mono and pushed into a power-of-two ring; the UI timer drains the ring at 60 Hz, runs the FFT (a custom radix-2 implementation in the WASM build, `juce::dsp::FFT` in the plugin), and log-resamples the magnitude to 256 display bins (20 Hz..min(22 kHz, Nyquist)).

Per-bin smoothing uses an asymmetric attack (0.37) / release (0.025) calibrated for 60 Hz calls so peaks stay legible without flickering. When the spectrum outline crosses the floor (-90 dB) it is broken at the exact boundary to avoid "stuck to the bottom" horizontal lines; the downward/upward transition draws one more point against the floor so the outline never appears to vanish mid-slope.

### Metering

Peak, RMS, and Momentary (BS.1770-4) are all computed every block and broadcast together at 60 Hz. Meter decay is `0.965` per-frame (≈ 20 dB/sec release, matching the previous 30 Hz build's `0.93`). The UI decides which to display — switching never resets the DSP.

## Latency verification

ZeroEQ reports **0 samples** to the host. To confirm in your DAW:

1. Check the plugin info / delay compensation display (e.g. Cubase MixConsole shows `Latency: 0 samples`).
2. Null test — duplicate a clip on two tracks; insert ZeroEQ with Bypass ON on one (or all bands OFF); invert polarity on the other; sum. The result is silence.

## Host compatibility notes

- **Pro Tools (AAX) on Windows**: the editor injects `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-device-scale-factor=1` before constructing WebView2 so the UI renders at 1× inside Pro Tools' DPI-virtualised window. It also defers a `setSize()` enforcement on the next message-loop iteration to overcome hosts that open the plugin below the declared minimum size.
- **All hosts**: a per-monitor DPI poll runs on a 60 Hz timer and forces a re-layout when the DPI scale factor changes (useful when dragging the plugin window between monitors).
- **Custom resize grip**: a 24×24 transparent overlay sits in the bottom-right corner with a small dot pattern; dragging it posts `window_action("resizeTo", w, h)` back to the native side, which clamps to `kMinWidth × kMinHeight = 875 × 450` and applies the new size to the host window.

## Directory layout

```
ZeroEQ/
├─ plugin/              # JUCE plugin (C++)
│  ├─ src/
│  │  ├─ PluginProcessor.*        # APVTS (3 global + 11 bands × 6 params), DSP chain entry
│  │  ├─ PluginEditor.*           # WebView init, Web↔APVTS relays, DPI polling, 60 Hz timer
│  │  ├─ ParameterIDs.h           # All parameter IDs + per-slot defaults
│  │  ├─ KeyEventForwarder.*      # WebView → host DAW key forwarding
│  │  └─ dsp/
│  │     ├─ Equalizer.*           # 11-band minimum-phase IIR EQ, Butterworth-cascaded HP/LP
│  │     ├─ Analyzer.*            # Pre / Post FFT analyzer (4096 pt, log-freq 256 bin)
│  │     └─ MomentaryProcessor.*  # ITU-R BS.1770-4 Momentary LKFS
│  └─ CMakeLists.txt
├─ wasm/                # C++ DSP ported to pure-standard-library for Emscripten
│  ├─ src/
│  │  ├─ wasm_exports.cpp         # C ABI consumed by the AudioWorklet
│  │  ├─ dsp_engine.h             # Orchestrator (source, transport, EQ, analyzer, meters)
│  │  ├─ equalizer.h              # Pure-C++ port of Equalizer (RBJ biquads, Butterworth Q)
│  │  ├─ analyzer.h               # Pure-C++ port of Analyzer (radix-2 FFT + log resample)
│  │  ├─ momentary_processor.h    # Pure-C++ port of MomentaryProcessor
│  │  └─ fft.h                    # Tiny in-house Cooley-Tukey radix-2 forward FFT
│  ├─ CMakeLists.txt
│  └─ build.sh                    # emcmake + emmake, copies to webui/public-web/wasm/
├─ webui/               # Vite + React 19 + MUI 7 frontend (plugin + web demo)
│  ├─ src/
│  │  ├─ App.tsx                  # Layout, grid/card switching, dev-mode gating
│  │  ├─ components/
│  │  │  ├─ eq/
│  │  │  │  ├─ SpectrumEditor.tsx # Canvas: spectrum + EQ curve + draggable band nodes + tooltip
│  │  │  │  ├─ BandControlColumn.tsx # Per-band UI column (switch, 3 knobs, inputs, slope select)
│  │  │  │  ├─ InteractiveKnob.tsx # Drag / wheel / reset with modifier-key fine-adjust
│  │  │  │  ├─ InlineNumberInput.tsx # Editable numeric field with unit suffix
│  │  │  │  ├─ eqCurve.ts         # TS mirror of the biquad math (for curve drawing)
│  │  │  │  └─ BandDefs.ts        # Per-slot defaults + Butterworth Q tables
│  │  │  ├─ OutputMeterWidget.tsx # OUT L/R meters (internal meterUpdate subscription)
│  │  │  ├─ ParameterFader.tsx    # Vertical OUTPUT fader
│  │  │  ├─ WebTransportBar.tsx   # Web-demo only: play/pause/seek/loop/file upload
│  │  │  ├─ WebDemoMenu.tsx       # Web-demo only: hamburger drawer (plugin downloads / sources)
│  │  │  └─ ...
│  │  ├─ bridge/juce.ts           # Plugin: juce-framework-frontend-mirror wrapper
│  │  ├─ bridge/web/              # Web demo: Vite alias targets
│  │  │  ├─ WebAudioEngine.ts     # AudioContext + worklet bridge, message queue until WASM ready
│  │  │  ├─ juce-shim.ts          # Parameter-state drop-in for the frontend-mirror API (58 params)
│  │  │  └─ WebParamState.ts      # Local WebSliderState / WebToggleState / WebComboBoxState
│  │  └─ hooks/useBandParam.ts    # Reactive APVTS subscription per band (useSyncExternalStore)
│  ├─ public-web/                 # Web-demo static assets (WASM, worklet, sample.mp3)
│  │  ├─ wasm/zeroeq_dsp.wasm     # Compiled WASM DSP (~44 KB)
│  │  └─ worklet/dsp-processor.js # AudioWorkletProcessor (instantiates WASM, drives buffers)
│  ├─ vite.config.ts              # Plugin build (embedded into the native binary)
│  ├─ vite.config.web.ts          # Web-demo SPA build (VITE_RUNTIME=web)
│  ├─ firebase.json / .firebaserc # Firebase Hosting config (project: zeroeq-demo)
│  └─ package.json
├─ cmake/               # Version.cmake, icon
├─ scripts/             # AAX signing helper, WebView2 download, etc.
├─ docs/                # AAX signing guide, SDK README, developer build guide
├─ JUCE/                # Submodule
├─ aax-sdk/             # Optional — place the AAX SDK here to enable AAX builds
├─ installer.iss        # Inno Setup script for Windows installer
├─ build_windows.ps1    # Windows release build pipeline (WebUI + VST3 / AAX / Standalone + signing + installer)
├─ build_macos.zsh      # macOS release build pipeline
├─ VERSION              # Single source of truth for the version string
└─ LICENSE
```

## License

Plugin source: see `LICENSE`. Third-party SDKs (JUCE / VST3 / AAX / WebView2 etc.) are licensed separately; see the *Licenses* dialog inside the plugin UI for the runtime dependency list.

## Credits

Developed by **Jun Murakami**. Built on **JUCE** with an embedded **WebView2 / WKWebView** frontend, and a WebAssembly build of the same DSP for the browser demo.
