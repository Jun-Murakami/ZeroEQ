# ZeroEQ

A **zero-latency**, spectrum-analyzer-integrated parametric equalizer for broadcast, streaming, live, and mastering work. 8 bands of minimum-phase IIR (Bell / Shelf / HP / LP / Notch) with per-band drag, overlaid on a Pre / Post FFT analyzer. Built with JUCE + WebView (Vite / React 19 / MUI 7). Ships as VST3 / AU / AAX / Standalone, plus an optional WebAssembly browser demo that reuses the exact same DSP.

## Highlights

- **0-sample latency** — all bands are minimum-phase IIR biquads. No lookahead, no oversampling, no linear-phase FFT. Null-tests bit-identical with the input when every band is OFF.
- **8 bands, freely routable** — Bell / LowShelf / HighShelf / HighPass / LowPass / Notch, each with independent Freq (20 Hz..20 kHz log) / Gain (±24 dB) / Q (0.1..18 log) / On.
- **Integrated Pre / Post analyzer** — FFT 2048 / Hann window / 256 log-frequency bins. Pre (blue) and Post (yellow) can be shown together or individually; Analyzer can be switched Off for total-CPU-zero mode.
- **I/O metering** — Peak / RMS / Momentary LKFS (ITU-R BS.1770-4) sent simultaneously to the UI, with hold/reset.
- **Stereo-true** — all bands apply the same gain to L/R, so the stereo image is preserved. Mid/Side routing is on the roadmap.
- **WebUI frontend** — interactive band-node editing, dark-theme React + MUI 7, hot-reload dev loop via Vite.
- **Mobile-friendly WebAssembly demo** — the same EQ DSP compiled to WASM and driven by an AudioWorklet; the UI collapses for narrow viewports.

## Layout

Placeholder at the moment (initial skeleton). The target layout is:

- **Main canvas** — overlaid Pre/Post spectrum + EQ transfer curve + 8 draggable band nodes. X = log-frequency (20 Hz..20 kHz), Y = gain (±24 dB).
- **Top bar** — Bypass, Analyzer mode (Off / Pre / Post / Pre+Post), plugin name/version.
- **Right strip** — Output Gain fader (±24 dB) and I/O meters.
- **Bottom rail** — per-band numeric readouts + Type selector (optional, for keyboard users).

The plugin window is resizable (minimum 720 × 420, default 900 × 520).

## Band types

| Type | Use | Notes |
| --- | --- | --- |
| **Bell** | Surgical cuts, broad sweeps | Peaking biquad (RBJ). Q = bandwidth. |
| **Low Shelf** | Warmth, bass tilt | RBJ shelf at the specified corner. |
| **High Shelf** | Air, top-end tilt | RBJ shelf. |
| **High Pass** | Rumble / subsonic removal | 2nd-order. Q controls Butterworth → Chebyshev feel. |
| **Low Pass** | De-essing, lo-fi | 2nd-order. |
| **Notch** | Surgical kill (60 Hz hum, feedback) | Full extinction at fc. |

Linear-phase / natural-phase / dynamic-EQ modes are on the roadmap; current implementation is minimum-phase only.

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

## Parameters

Global:

| ID              | Type   | Range                          | Default | Notes                                  |
| --------------- | ------ | ------------------------------ | ------- | -------------------------------------- |
| `BYPASS`        | bool   | off / on                       | off     | Bit-identical passthrough when on.     |
| `OUTPUT_GAIN`   | float  | -24 .. +24 dB                  | 0 dB    | Applied after the band chain.          |
| `ANALYZER_MODE` | choice | Off / Pre / Post / Pre+Post    | Post    | Controls which FFTs run / are emitted. |

Per band (`i = 0..7`):

| ID             | Type   | Range                                                           | Default              |
| -------------- | ------ | --------------------------------------------------------------- | -------------------- |
| `BAND{i}_ON`   | bool   | off / on                                                        | off                  |
| `BAND{i}_TYPE` | choice | Bell / LowShelf / HighShelf / HighPass / LowPass / Notch        | Bell                 |
| `BAND{i}_FREQ` | float  | 20..20000 Hz (log)                                              | log-distributed      |
| `BAND{i}_GAIN` | float  | -24..+24 dB                                                     | 0 dB                 |
| `BAND{i}_Q`    | float  | 0.1..18 (log)                                                   | 1.0                  |

## DSP details

### Filters

Each band is a single `juce::dsp::IIR::Filter<float>` biquad per channel. Coefficients come from `juce::dsp::IIR::Coefficients::makePeakFilter / makeLowShelf / makeHighShelf / makeHighPass / makeLowPass / makeNotch` (Robert Bristow-Johnson cookbook via JUCE). Updates are staged from the UI into a per-band dirty flag and applied at the top of `processBlock`.

### Analyzer

2048-point Hann-windowed FFT with hop = 1024. Audio samples are downmixed to mono and pushed into a power-of-two ring; a 30 Hz UI timer drains the ring on the message thread, runs the FFT, and log-resamples the magnitude to 256 display bins (20 Hz..Nyquist). Per-bin smoothing uses an asymmetric attack (0.6) / release (0.05) so peaks stay legible without flickering.

### Metering

Peak, RMS, and Momentary (BS.1770-4) are all computed every block and broadcast together at 30 Hz. The UI decides which to display — switching never resets the DSP.

## Latency verification

ZeroEQ reports **0 samples** to the host. To confirm in your DAW:

1. Check the plugin info / delay compensation display (e.g. Cubase MixConsole shows `Latency: 0 samples`).
2. Null test — duplicate a clip on two tracks; insert ZeroEQ with Bypass ON on one (or all bands OFF); invert polarity on the other; sum. The result is silence.

## Host compatibility notes

- **Pro Tools (AAX) on Windows**: the editor injects `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-device-scale-factor=1` before constructing WebView2 so the UI renders at 1× inside Pro Tools' DPI-virtualised window. It also defers a `setSize()` enforcement on the next message-loop iteration to overcome hosts that open the plugin below the declared minimum size.
- **All hosts**: a per-monitor DPI poll runs on a 30 Hz timer and forces a re-layout when the DPI scale factor changes (useful when dragging the plugin window between monitors).

## Directory layout

```
ZeroEQ/
├─ plugin/              # JUCE plugin (C++)
│  ├─ src/
│  │  ├─ PluginProcessor.*        # APVTS, DSP chain entry
│  │  ├─ PluginEditor.*           # WebView init, Web↔APVTS relays, DPI polling
│  │  ├─ ParameterIDs.h
│  │  ├─ KeyEventForwarder.*      # WebView → host DAW key forwarding
│  │  └─ dsp/
│  │     ├─ Equalizer.*           # 8-band minimum-phase IIR EQ
│  │     ├─ Analyzer.*            # Pre / Post FFT analyzer (log-freq 256 bin)
│  │     └─ MomentaryProcessor.*  # ITU-R BS.1770-4 Momentary LKFS
│  └─ CMakeLists.txt
├─ wasm/                # C++ DSP ported to pure-standard-library for Emscripten
│  ├─ src/                        # (stale: still references the ZeroComp DSP — port TBD)
│  └─ build.sh
├─ webui/               # Vite + React 19 + MUI 7 frontend (plugin + web demo)
│  ├─ src/
│  │  ├─ App.tsx                  # Layout, meter/spectrum event routing
│  │  ├─ components/              # ParameterFader / HorizontalParameter / VUMeter / dialogs
│  │  ├─ bridge/juce.ts           # Plugin: juce-framework-frontend-mirror wrapper
│  │  ├─ bridge/web/              # Web demo: audio-worklet shim
│  │  └─ hooks/useJuceParam.ts
│  ├─ vite.config.ts
│  └─ package.json
├─ cmake/               # Version.cmake, icon
├─ scripts/             # AAX signing helper, WebView2 download, etc.
├─ JUCE/                # Submodule
├─ aax-sdk/             # Optional — place the AAX SDK here to enable AAX builds
├─ installer.iss        # Inno Setup script for Windows installer
├─ build_windows.ps1    # Windows release build pipeline
├─ build_macos.zsh      # macOS release build pipeline
├─ VERSION              # Single source of truth for the version string
└─ LICENSE
```

## License

Plugin source: see `LICENSE`. Third-party SDKs (JUCE / VST3 / AAX / WebView2 etc.) are licensed separately; see the *Licenses* dialog inside the plugin UI for the runtime dependency list.

## Credits

Developed by **Jun Murakami**. Built on **JUCE** with an embedded **WebView2 / WKWebView** frontend, and a WebAssembly build of the same DSP for the browser demo.
