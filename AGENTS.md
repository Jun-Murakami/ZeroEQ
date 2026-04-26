# ZeroEQ — AGENTS

このリポジトリで作業する AI コーディングエージェント向けの要点サマリです。詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## プロジェクト

- JUCE + WebView（Vite/React/MUI）のオーディオプラグイン
- ゼロレイテンシー（最小位相 IIR のみ）のスペアナ統合型 EQ
- ユーザが触るのは、8 バンドそれぞれの ON/TYPE/FREQ/GAIN/Q とグローバルの BYPASS / OUTPUT_GAIN / ANALYZER_MODE
- linear-phase / lookahead / oversampling は現行スコープ外（将来モードとして追加予定）

## ディレクトリ概観

- `plugin/src/` — JUCE プラグイン本体（C++）
  - `PluginProcessor.*`, `PluginEditor.*`, `ParameterIDs.h`
  - `dsp/Equalizer.*` — 8 バンド × 2ch の `juce::dsp::IIR::Filter` をカスケード
  - `dsp/Analyzer.*` — Pre / Post 独立の FFT アナライザ（Hann 2048 / log-freq 256 bin）
  - `dsp/MomentaryProcessor.*` — ITU-R BS.1770-4 Momentary LKFS（I/O 両方）
  - `KeyEventForwarder.*` — WebView → DAW ホストのキーイベント転送
- `webui/src/` — Vite + React 19 + MUI v7 フロントエンド
  - `App.tsx` — 現状はプレースホルダ（SpectrumView + I/O 数値）。本番 UI は未実装
  - `components/ParameterFader.tsx`, `HorizontalParameter.tsx`, `VUMeter.tsx`, `LicenseDialog.tsx`, `GlobalDialog.tsx`, `WebDemoMenu.tsx`, `WebTransportBar.tsx`
  - `hooks/useJuceParam.ts` — APVTS 購読の React フック（useSyncExternalStore ベース）
  - `hooks/useHostShortcutForwarding.ts` — ショートカット転送

## 作業するうえでの原則

1. オーディオスレッド上では確保 / ロック / I/O を行わない（IIR 係数差し替えで僅かに alloc が生じるのは UI 操作頻度で許容）
2. パラメータは APVTS に集約、UI との双方向同期は `WebSliderRelay` / `WebToggleButtonRelay` / `WebComboBoxRelay` + `Web*ParameterAttachment` で行う
3. 高頻度データ（メーター / スペクトラム）は `std::atomic<float>` or lock-free ring で audio → UI に渡し、UI タイマーで 30Hz 送出
4. TypeScript は `any` 禁止。購読系は `useSyncExternalStore`、JUCE の `valueChangedEvent` からの呼び出しは **Latest Ref Pattern** を使う
5. 新規 DSP クラスは `plugin/src/dsp/` に置き、`plugin/CMakeLists.txt` の `target_sources` に登録
6. WebUI コンポーネントは疎結合・小さく、フェーダーは `ParameterFader` / `HorizontalParameter` に一本化

## ビルド

- Windows（本番配布）: `powershell -File build_windows.ps1 -Configuration Release` — WebUI ビルド → VST3 / AAX / Standalone コンパイル → AAX 署名（`.env` に PACE 情報あれば）→ ZIP 梱包 → Inno Setup インストーラ生成
- Windows（開発）: `cmake -B build -G "Visual Studio 17 2022" -A x64 && cmake --build build --config Debug --target ZeroEQ_VST3`
- macOS: `./build_macos.zsh`
- Linux（WSL2 Ubuntu 24.04 で動作確認）: `bash build_linux.sh` — VST3 / LV2 / CLAP / Standalone をビルドし `releases/<VERSION>/ZeroEQ_<VERSION>_Linux_VST3_LV2_CLAP_Standalone.zip` を生成。LV2 / CLAP は `if(UNIX AND NOT APPLE)` で条件付き有効化されるので Win/Mac リリース経路には影響しない
- WebUI dev: `cd webui && npm install && npm run dev`
- 型チェックのみ: `cd webui && npx tsc --noEmit`

## よく使う拡張ポイント

- 新規 APVTS パラメータ追加: `ParameterIDs.h` に ID 追加 → `createParameterLayout()` で登録 → `PluginEditor` に Web*Relay / Attachment 追加（バンド系はヘルパ `makeBandRelays` / `makeBandAttachments` を再利用）→ `.withOptionsFrom()` に追加 → WebUI 側 hook で購読
- バンド数の変更: `ParameterIDs.h` の `kNumBands`、`Equalizer::kNumBands` を揃えて更新
- 新規フィルタタイプ: `Equalizer::Type` に追加 → `Equalizer.cpp` の `makeCoeffsFor` に case 追加 → APVTS `BAND{i}_TYPE` の choice 文字列を拡張
- 新規 DAW 互換対応: `KeyEventForwarder.cpp` の `resolveHostWindowForForwarding` / `handleDefaultPostMessage`
