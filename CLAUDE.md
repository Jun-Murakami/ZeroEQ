必ず日本語で回答すること。

## ZeroEQ 開発用 ルール（AGENTS）

この文書は JUCE + WebView（Vite/React/MUI）構成で「ゼロレイテンシー・スペアナ統合型 EQ」を実装するための合意ルールです。開発時の意思決定や PR レビューの基準として用います。

### 目的とスコープ

- **目的**: 最小位相 IIR による純ゼロレイテンシーのマルチバンド EQ。スペアナ統合 + インタラクティブなバンド操作を備え、放送／配信／ライブ／マスタリングいずれの用途にも汎用に使える。
- **対象フォーマット**: VST3 / AU / AAX / Standalone（Windows / macOS）+ VST3 / LV2 / CLAP / Standalone（Linux）
- **主要機能**:
  - 8 バンドの IIR EQ（Bell / LowShelf / HighShelf / HighPass / LowPass / Notch）
  - 各バンド: ON / TYPE / FREQ（20..20kHz log）/ GAIN（±24 dB）/ Q（0.1..18 log）
  - グローバル: BYPASS / OUTPUT_GAIN（±24 dB）/ ANALYZER_MODE（Off / Pre / Post / Pre+Post）
  - スペアナ（FFT 2048 / Hann / log-freq 256 bin）を Pre / Post 独立描画
  - I/O メーター（Peak / RMS / Momentary LKFS を常時同時送信）
- **非機能**:
  - 完全なゼロサンプルレイテンシ。linear-phase / lookahead / oversampling は現行スコープ外（将来拡張で別モードとして追加する）。
  - 全バンド OFF 時はビット同一のスルー。

### アーキテクチャ

- **C++/JUCE**:
  - `PluginProcessor` が APVTS を保持、`processBlock` で DSP チェーンを実行
  - `ze::dsp::Equalizer`（`plugin/src/dsp/Equalizer.h/.cpp`）— 8 バンド × 2ch の `juce::dsp::IIR::Filter<float>` をカスケード
  - `ze::dsp::Analyzer`（`plugin/src/dsp/Analyzer.h/.cpp`）— リングバッファ → FFT → log-freq 256 bin 化。Pre / Post 独立インスタンス。
  - `ze::dsp::MomentaryProcessor` — 400ms 窓の LKFS 積算（in/out それぞれ）。
  - I/O メータ値は `std::atomic<float>` で audio → UI に受け渡し（区間最大を `compare_exchange_weak` で更新）。
- **WebUI**:
  - APVTS とは `useJuceParam.ts` 経由で `useSyncExternalStore` 購読（tearing-free）
  - バンド relay / attachment は 8 バンド × 5 パラメータ（ON/TYPE/FREQ/GAIN/Q）= 40 本。`std::vector<std::unique_ptr<…>>` で保持し、ヘルパで populate。
  - フェーダーは `ParameterFader`（縦）と `HorizontalParameter`（横）に統一
  - スペクトラム描画は `<canvas>` 2D、30Hz タイマで emit された `spectrumUpdate` を消費

### DSP の要点

- **IIR 係数**: `juce::dsp::IIR::Coefficients::makePeakFilter / makeLowShelf / makeHighShelf / makeHighPass / makeLowPass / makeNotch` を使用。Bell/Shelf は dB → リニア変換して渡す。
- **係数の再計算**: バンド毎に `std::atomic<bool> dirty_` を持ち、processBlock 冒頭でまとめて compare_exchange → rebuild。alloc が生じうるが、UI 操作頻度では実用上問題ない。
- **全 OFF 時の完全バイパス**: `on` フラグが全て false の場合はフィルタを通さず、ゲインステージも 1.0 ならスキップ。
- **Nyquist 付近の補正**: Bell のゲインが Nyquist に近いとカーブが歪む（cramping 未実装）。必要になったら bilinear prewarp / analog prototype 方式へ切替。

### アナライザの要点

- **FFT**: サイズ 2048（`kFftOrder=11`）、Hann 窓、hop = 1024。
- **データ転送**: audio thread は `pushBlock()` で downmix した mono をリングに積む。message thread タイマ（30Hz）が `drainAndCompute()` を呼んで dB 配列を取得 → WebUI へ emit。
- **log-freq リサンプル**: 20Hz..sampleRate/2 を対数等分した 256 bin（`kNumDisplayBins`）に丸め、アタック 0.6 / リリース 0.05 のスムージング。
- **WebUI 送信**: 現状は `juce::Array<juce::var>` ベースの JSON 送信。数値配列が重くなってきたら ArrayBuffer 送信に切替える（FabFilter 級の描画品質を出す段階で検討）。

### オーディオスレッド原則

- `processBlock` 内でのメモリ確保・ロック・ファイル I/O は禁止（IIR::Coefficients 差し替えの alloc は UI 操作頻度で許容）。
- メーター蓄積は `compare_exchange_weak` で区間最大を保持し、UI タイマーで `exchange` して取り出し。
- パラメータ読み取りは `getRawParameterValue(...)->load()`。`AudioProcessorValueTreeState::Listener` は使わない（UI スレッドからのコールバック発火を避ける）。

### UI/UX 原則

- ダークテーマ前提。MUI v7、`@fontsource/jost` をデフォルトフォントに使用。
- スペクトラムキャンバスは HiDPI 対応（`devicePixelRatio` を使って内部解像度を拡大）。
- バンドノードの drag: Pointer Events で実装。X 軸 = freq（log）、Y 軸 = gain、Alt/Shift + drag で Q、ダブルクリックで on/off。具体仕様は UI 実装フェーズで確定。
- 数値入力欄は `block-host-shortcuts` クラスでキーイベントの DAW 転送を抑制。
- 既定値: 全バンド OFF / バンド既定周波数は 100〜6.5k を対数等分（Processor 側 `defaultBandFreq()`）/ Output 0 / Analyzer Post。

### ブリッジ / メッセージ設計

- JS → C++（コマンド系、`callNative` 経由）:
  - `system_action("ready")` — 初期化完了通知。`{ pluginName, version, numBands }` が返る。
  - `system_action("forward_key_event", payload)` — キー転送
  - `open_url(url)` — 外部 URL の起動
  - `window_action("resizeTo", w, h)` / `("resizeBy", dw, dh)` — Standalone 用リサイズ
- C++ → JS（イベント系、30Hz スロットル）:
  - `meterUpdate`: `{ input: {peakLeft, peakRight, rmsLeft, rmsRight, momentary}, output: {...同じ} }`
    - Peak/RMS は dB、momentary は LKFS。モード切替は UI 側で見せ方を変えるだけ（常に 3 系統とも送る）。
  - `spectrumUpdate`: `{ numBins, pre?: number[], post?: number[] }`
    - `ANALYZER_MODE` に応じて pre/post のどちらかまたは両方が入る。drainAndCompute が新フレームを生成した時だけ emit。

### パラメータ一覧（APVTS）

グローバル:

- `BYPASS`:        bool, 既定 false
- `OUTPUT_GAIN`:   float, -24..+24 dB, 既定 0
- `ANALYZER_MODE`: choice [Off, Pre, Post, Pre+Post], 既定 Post

バンド（`i = 0..7`、`ze::id::kNumBands == 8`）:

- `BAND{i}_ON`:   bool, 既定 false
- `BAND{i}_TYPE`: choice [Bell, LowShelf, HighShelf, HighPass, LowPass, Notch], 既定 Bell
- `BAND{i}_FREQ`: float, 20..20000 Hz (log), 既定は対数等分
- `BAND{i}_GAIN`: float, -24..+24 dB, 既定 0
- `BAND{i}_Q`:    float, 0.1..18 (log), 既定 1.0

### React 設計方針

- 外部ストア購読は `useSyncExternalStore`（`hooks/useJuceParam.ts`）。tearing-free で StrictMode 安全。
- `useEffect` は最小限。JUCE 由来のコールバックでは Latest Ref Pattern を使う（`useEffectEvent` は `valueChangedEvent` からの発火で race する実績あり）。
- Latest Ref Pattern: `const xRef = useRef(x); xRef.current = x;` を render 中に実行。

### コーディング規約（C++）

- 明示的な型、早期 return、2 段以上の深いネスト回避
- 例外は原則不使用。戻り値でエラー伝搬
- コメントは「なぜ」を中心に要点のみ
- 新規 DSP クラスは `plugin/src/dsp/` 配下、`namespace ze::dsp` で統一

### コーディング規約（Web）

- TypeScript 必須。`any` 型は禁止
- ESLint + Prettier。コンポーネントは疎結合・小さく
- MUI テーマはダーク優先
- `useEffect` の新規追加時は `useeffect-guard` skill で STEP1/2/3 チェックを通す

### ビルド

- Dev: WebView は `http://127.0.0.1:5173`（Vite dev server）
- Prod: `webui build` を zip 化 → `juce_add_binary_data` で埋め込み
- AAX SDK は `aax-sdk/` 配下に配置された場合のみ自動的に有効化
- Windows 配布ビルド: `powershell -File build_windows.ps1 -Configuration Release`
  - 成果物: `releases/<VERSION>/ZeroEQ_<VERSION>_Windows_VST3_AAX_Standalone.zip` と `ZeroEQ_<VERSION>_Windows_Setup.exe`（Inno Setup 6 必須）
  - AAX 署名は `.env` に PACE 情報がある場合のみ自動実行。**`PACE_ORGANIZATION`（= Wrap GUID）は本プラグイン固有**なので、ZeroComp 等の既存 GUID は流用できない。PACE Eden ポータルで "ZeroEQ" 用の製品登録を行って新しい Wrap GUID を発行する必要がある。加えて:
    - `.pfx` 開発用証明書: `$RootDir\zeroeq-dev.pfx` / `$env:USERPROFILE\.zeroeq\dev.pfx` / `certificates\zeroeq-dev.pfx` のいずれかに配置するか、`PACE_PFX_PATH` 環境変数で明示。
    - 必須環境変数: `PACE_USERNAME` / `PACE_PASSWORD` / `PACE_ORGANIZATION` / `PACE_KEYPASSWORD`。欠けていると署名はスキップされ unsigned ビルドになる（ビルド自体は成功）。
    - 署名未構成の段階では `releases/.../ZeroEQ*.aaxplugin` は developer-unsigned のまま同梱される。Pro Tools では unsigned プラグインは DEVELOPER モードでのみロード可能。
- Linux 配布ビルド: `bash build_linux.sh`（WSL2 Ubuntu 24.04 で動作確認）
  - 成果物: `releases/<VERSION>/ZeroEQ_<VERSION>_Linux_VST3_LV2_CLAP_Standalone.zip`。VST3 / LV2 / CLAP / Standalone を同梱
  - 自動インストール先: `~/.vst3/ZeroEQ.vst3`, `~/.lv2/ZeroEQ.lv2`, `~/.clap/ZeroEQ.clap`（VST3 / LV2 は JUCE の `COPY_PLUGIN_AFTER_BUILD`、CLAP は `build_linux.sh` 側で明示コピー）
  - LV2 / CLAP は **Linux ビルドでのみ** 有効化（`if(UNIX AND NOT APPLE)` で条件分岐）。Windows / macOS の既存リリース経路には影響させない
  - LV2URI: `https://junmurakami.com/plugins/zeroeq`（`plugin/CMakeLists.txt` の `juce_add_plugin` 内）。LV2 規約上 stable な URI 必須なのでバージョンを跨いで変更しない
  - CLAP: `clap-juce-extensions` を submodule として取り込み、`clap_juce_extensions_plugin(... CLAP_ID "com.junmurakami.zeroeq" CLAP_FEATURES audio-effect equalizer)` を呼ぶ
  - 必要 apt パッケージ: `build-essential pkg-config cmake ninja-build git libasound2-dev libjack-jackd2-dev libcurl4-openssl-dev libfreetype-dev libfontconfig1-dev libx11-dev libxcomposite-dev libxcursor-dev libxext-dev libxinerama-dev libxrandr-dev libxrender-dev libwebkit2gtk-4.1-dev libglu1-mesa-dev mesa-common-dev libgtk-3-dev`

#### WASM ビルド（Web デモ用 DSP）

`wasm/src/wasm_exports.cpp` を Emscripten でビルドし、`webui/public-web/wasm/zeroeq_dsp.wasm` に配置して Vite から配信する。
**plugin/src/dsp/ 内の DSP を純 C++ に移植した `wasm/src/{equalizer,analyzer,momentary_processor,fft}.h` が本体**。JUCE には依存しない。

- 前提: emsdk が `D:/Synching/code/JUCE/emsdk` に checkout 済み。未 activate なら一度だけ以下を実行:
  ```powershell
  cd D:\Synching\code\JUCE\emsdk
  python emsdk.py install latest
  python emsdk.py activate 5.0.4
  ```
- `wasm/build.sh` は Unix bash 用。**Windows では使わない**。
  加えて Windows のシステム Python が 3.10 未満だと emcc がアサートで落ちるので、emsdk 同梱の Python を PATH 先頭に入れる:
  ```powershell
  $env:PATH = 'D:\Synching\code\JUCE\emsdk\python\3.13.3_64bit;' + $env:PATH
  & 'D:\Synching\code\JUCE\emsdk\emsdk_env.ps1'
  cd D:\Synching\code\JUCE\ZeroEQ\wasm
  Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
  New-Item -ItemType Directory build | Out-Null
  cd build
  emcmake cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
  cmake --build .
  # 配信先にコピー
  Copy-Item -Force dist\zeroeq_dsp.wasm ..\dist\
  Copy-Item -Force dist\zeroeq_dsp.wasm ..\..\webui\public-web\wasm\
  ```
- macOS / Linux は `wasm/build.sh` をそのまま使える（`source /path/to/emsdk_env.sh` 後に `./wasm/build.sh`）。
- 出力サイズは Release -O3 で ~44KB（11-band EQ + FFT + MomentaryProc 込み）。`STANDALONE_WASM=1` + `ALLOW_MEMORY_GROWTH=1`。エクスポート関数一覧は `wasm/CMakeLists.txt` の `EXPORTED_FUNCTIONS` を参照。
- **DSP に変更を入れたら必ず WASM も再ビルドして `webui/public-web/wasm/` 配下を更新する**。WASM を更新せず `webui build:web` すると Web デモだけ旧ロジックのままになる。

### バージョン管理

- `VERSION` ファイルで一元管理。CMake と `build_windows.ps1` がここから読む
- `webui/package.json` の `version` も手動で同期する
- コミットは**ユーザが明示的に指示しない限り行わない**

### ファイル構成メモ

```
plugin/src/
  PluginProcessor.{h,cpp}     ← APVTS + DSP チェーン
  PluginEditor.{h,cpp}        ← WebView + relay/attachment + DPI ポーリング + resize
  ParameterIDs.h              ← 全パラメータ ID（11 バンド × 6 種類 + グローバル）
  KeyEventForwarder.{h,cpp,mm}← ホストへのキー転送
  dsp/
    Equalizer.{h,cpp}         ← 11-band IIR EQ（各段 Butterworth Q 分解）
    Analyzer.{h,cpp}          ← Pre/Post スペアナ（4096 pt FFT, log-freq 256 bin）
    MomentaryProcessor.{h,cpp}← LKFS 400ms 窓（I/O 両方）

wasm/src/                     ← Web デモ用 JUCE 非依存 DSP
  wasm_exports.cpp            ← C ABI (band params × 11 + global + spectrum drain)
  dsp_engine.h                ← オーケストレータ (source / transport / EQ / analyzer / meter)
  equalizer.h                 ← RBJ biquad + Butterworth Q 分解（plugin 側と挙動一致）
  analyzer.h                  ← ring + Hann + FFT + log-freq + smoothing
  momentary_processor.h       ← ITU BS.1770-4 K-weighting（ZeroComp 版と同一）
  fft.h                       ← 自前 radix-2 Cooley-Tukey（JUCE 非依存）

webui/src/
  App.tsx                     ← メイン画面（11 バンド列 + SpectrumEditor + OUTPUT フェーダー）
  components/
    eq/                       ← EQ 固有（BandControlColumn / SpectrumEditor / InteractiveKnob など）
    OutputMeterWidget.tsx     ← OUT メーター + dB 目盛り（meterUpdate を自分で購読）
    ParameterFader.tsx        ← 縦フェーダー（OUTPUT 用）
  bridge/
    juce.ts / web/            ← DAW ⇔ WebView / Web デモの両系統
    web/juce-shim.ts          ← 11 バンド APVTS を WebAudioEngine にルーティング
    web/WebAudioEngine.ts     ← Web デモ用 AudioWorklet マネージャ
  hooks/                      ← useJuceParam / useBandParam など
```

### 現況

- DSP（Equalizer / Analyzer / Momentary）は plugin 側・WASM 側とも完全実装済み、挙動は一致。
- WebUI は主要機能揃ったプロダクションに近い状態（バンドノード drag、スペアナ Pre/Post ゴースト、60Hz リフレッシュ、ツールチップ、Reset All / Spectrum トグル、リサイズハンドル、DPI 対応）。
- Web デモ (VITE_RUNTIME=web) も音が鳴る。`npm run build:web` → Vite dev/preview で動作確認可能。
- 将来の課題候補: linear-phase モード / ダイナミック EQ / ミッドサイド / プリセット管理 / 測定結果のロギング。
