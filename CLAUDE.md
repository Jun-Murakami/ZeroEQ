必ず日本語で回答すること。

## ZeroEQ 開発用 ルール（AGENTS）

この文書は JUCE + WebView（Vite/React/MUI）構成で「ゼロレイテンシー・スペアナ統合型 EQ」を実装するための合意ルールです。開発時の意思決定や PR レビューの基準として用います。

### 目的とスコープ

- **目的**: 最小位相 IIR による純ゼロレイテンシーのマルチバンド EQ。スペアナ統合 + インタラクティブなバンド操作を備え、放送／配信／ライブ／マスタリングいずれの用途にも汎用に使える。
- **対象フォーマット**: VST3 / AU / AAX / Standalone
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
  - AAX 署名は `.env` に PACE 情報がある場合のみ自動実行。`PACE_ORGANIZATION`（= Wrap GUID）は本プラグイン固有。

### バージョン管理

- `VERSION` ファイルで一元管理。CMake と `build_windows.ps1` がここから読む
- `webui/package.json` の `version` も手動で同期する
- コミットは**ユーザが明示的に指示しない限り行わない**

### ファイル構成メモ

```
plugin/src/
  PluginProcessor.{h,cpp}     ← APVTS + DSP チェーン
  PluginEditor.{h,cpp}        ← WebView + relay/attachment
  ParameterIDs.h              ← 全パラメータ ID
  KeyEventForwarder.{h,cpp,mm}← ホストへのキー転送
  dsp/
    Equalizer.{h,cpp}         ← 8-band IIR EQ
    Analyzer.{h,cpp}          ← Pre/Post スペアナ
    MomentaryProcessor.{h,cpp}← LKFS 400ms 窓（I/O 両方）

webui/src/
  App.tsx                     ← 現在はプレースホルダ（SpectrumView + 数値 I/O）
  components/                 ← 汎用部品（ParameterFader / HorizontalParameter / メーター / ダイアログ）
  bridge/                     ← JUCE ⇔ WebView 橋渡し
  hooks/                      ← useJuceParam など
```

### 現況（初期スケルトン時点のメモ）

- DSP（Equalizer / Analyzer）は **最小ビルド可能な実装**で入っており、バンドを ON にすれば音に効く。
- WebUI 側はプレースホルダ実装のみ。バンド UI（drag 可能なノードと curve 描画、スペアナ重ね合わせ）はこれから作る。
- 将来の課題候補: linear-phase モード / ダイナミック EQ / ミッドサイド / band の動的追加削除（現状は 8 本固定で ON/OFF 切替のみ）。
