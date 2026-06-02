// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

#include <array>
#include <memory>
#include <optional>
#include <vector>

class ZeroEQAudioProcessorEditor : public juce::AudioProcessorEditor,
                                   private juce::Timer
{
public:
    // コンパクトモード + 下部パネル折りたたみで最小限の表示を維持できる下限。
    static constexpr int kMinWidth  = 640;
    static constexpr int kMinHeight = 380;
    static constexpr int kMaxWidth  = 2560;
    static constexpr int kMaxHeight = 1440;

    explicit ZeroEQAudioProcessorEditor(ZeroEQAudioProcessor&);
    ~ZeroEQAudioProcessorEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    void setScaleFactor(float newScale) override;

private:
    void timerCallback() override;

    using Resource = juce::WebBrowserComponent::Resource;
    std::optional<Resource> getResource(const juce::String& url) const;

    void handleSystemAction(const juce::Array<juce::var>& args,
                            juce::WebBrowserComponent::NativeFunctionCompletion completion);

    ZeroEQAudioProcessor& audioProcessor;

    // ---- グローバル relay / attachment ----
    juce::WebToggleButtonRelay webBypassRelay;
    juce::WebSliderRelay       webOutputGainRelay;
    juce::WebComboBoxRelay     webAnalyzerModeRelay;
    juce::WebToggleButtonRelay webBottomPanelOpenRelay;
    juce::WebComboBoxRelay     webEqDbRangeRelay;

    juce::WebToggleButtonParameterAttachment bypassAttachment;
    juce::WebSliderParameterAttachment       outputGainAttachment;
    juce::WebComboBoxParameterAttachment     analyzerModeAttachment;
    juce::WebToggleButtonParameterAttachment bottomPanelOpenAttachment;
    juce::WebComboBoxParameterAttachment     eqDbRangeAttachment;

    // ---- バンド relay / attachment（8 band × 5 param 固定） ----
    //  参照寿命: webView より前にすべて構築しておく必要があるため、宣言順で手前に置く。
    //  vector of unique_ptr にして初期化ヘルパで populate する。
    std::vector<std::unique_ptr<juce::WebToggleButtonRelay>>             bandOnRelays;
    std::vector<std::unique_ptr<juce::WebComboBoxRelay>>                 bandTypeRelays;
    std::vector<std::unique_ptr<juce::WebSliderRelay>>                   bandFreqRelays;
    std::vector<std::unique_ptr<juce::WebSliderRelay>>                   bandGainRelays;
    std::vector<std::unique_ptr<juce::WebSliderRelay>>                   bandQRelays;
    std::vector<std::unique_ptr<juce::WebComboBoxRelay>>                 bandSlopeRelays;

    std::vector<std::unique_ptr<juce::WebToggleButtonParameterAttachment>> bandOnAttachments;
    std::vector<std::unique_ptr<juce::WebComboBoxParameterAttachment>>     bandTypeAttachments;
    std::vector<std::unique_ptr<juce::WebSliderParameterAttachment>>       bandFreqAttachments;
    std::vector<std::unique_ptr<juce::WebSliderParameterAttachment>>       bandGainAttachments;
    std::vector<std::unique_ptr<juce::WebSliderParameterAttachment>>       bandQAttachments;
    std::vector<std::unique_ptr<juce::WebComboBoxParameterAttachment>>     bandSlopeAttachments;

    juce::WebControlParameterIndexReceiver controlParameterIndexReceiver;

    struct WebViewLifetimeGuard : public juce::WebViewLifetimeListener
    {
        std::atomic<bool> constructed{ false };
        void webViewConstructed(juce::WebBrowserComponent*) override { constructed.store(true,  std::memory_order_release); }
        void webViewDestructed (juce::WebBrowserComponent*) override { constructed.store(false, std::memory_order_release); }
        bool isConstructed() const { return constructed.load(std::memory_order_acquire); }
    } webViewLifetimeGuard;

    juce::WebBrowserComponent webView;

    bool useLocalDevServer = false;

    std::unique_ptr<juce::ResizableCornerComponent> resizer;
    juce::ComponentBoundsConstrainer resizerConstraints;

    std::atomic<bool> isShuttingDown{ false };

    // WebView 内のリサイズハンドルからの resizeTo を最後に処理した時刻（ms）。
    //  直近 kResizeQuietMs 以内は 60Hz の meter/spectrum 送出をスキップし、
    //  メッセージスレッド／JS スレッドをリサイズのラウンドトリップに明け渡す。
    //  （window_action ハンドラと timerCallback は共にメッセージスレッドで動くので atomic 不要。）
    juce::uint32 lastHandleResizeMs = 0;
    static constexpr juce::uint32 kResizeQuietMs = 160;

    // Host window movement/resize can temporarily stall the WebView event loop.  During that
    // period avoid queuing realtime JS events; ZeroEQ's spectrum payload is large enough to
    // make backlog recovery look like a hard UI freeze.
    void updatePeerBoundsActivity(juce::uint32 nowMs);
    bool shouldPauseRealtimeEvents(juce::uint32 nowMs) const;
    bool haveLastPeerBounds { false };
    juce::Rectangle<int> lastPeerBounds;
    juce::uint32 lastPeerBoundsChangeMs { 0 };
    static constexpr juce::uint32 kPeerBoundsQuietMs = 220;

    // Native -> JS realtime event rate limits.  The timer stays at 60 Hz for native decay and DPI
    // polling, but WebView traffic is capped so window motion cannot build an unbounded queue.
    juce::uint32 lastMeterEmitMs { 0 };
    juce::uint32 lastSpectrumEmitMs { 0 };
    static constexpr juce::uint32 kMeterEmitIntervalMs = 16;
    static constexpr juce::uint32 kSpectrumEmitIntervalMs = 16;

    // --- Linux 限定のウィンドウ制御（[[linux-dpi-resize-scaling]] と同方針）---
    //  Bitwig 等はホスト枠ドラッグをプラグインへ転送しないため、Linux では枠リサイズを無効化し
    //  （setResizable(false)）、自前ハンドルのみ許可する。高頻度リサイズで取り残された黒残り/
    //  見切れは、ホストの echo 待ち（バックプレッシャ）と落ち着き後の 1px ジグル再同期で収束。
    //  Windows/macOS は従来どおり。
    void applyDisplayScale();
    void applyWindowResize(int targetW, int targetH,
                           juce::WebBrowserComponent::NativeFunctionCompletion completion);
    void resolveResizeAck();
    bool   resizeAckPending { false };
    bool   resizeSelfDriven { false };
    juce::uint32 resizeAckStartMs { 0 };
    juce::WebBrowserComponent::NativeFunctionCompletion pendingResizeCompletion;
    juce::uint32 lastResizeActivityMs { 0 };
    bool   settleReconcileDone { true };
    bool   resyncStep2Pending { false };
    int    resyncTargetW { 0 };
    int    resyncTargetH { 0 };
    // CSS px → 論理 px の換算比率（resizeBegin/apply_layout で確定し resizeTo/初期サイズに適用）。
    //  分数スケーリング環境でハンドル(CSS px)とウィンドウ(論理px)、初期サイズのズレを防ぐ（MixCompare 方式）。
    double webResizeRatioW { 1.0 };
    double webResizeRatioH { 1.0 };
    double lastWebViewDpr { -1.0 }; // WebUI が apply_layout で報告する devicePixelRatio（真のディスプレイ倍率）
    // APVTS state の保存サイズ（editorWidth/editorHeight）から復元したか。
    //  復元した場合、apply_layout の初回 ×ratio リサイズで保存値（論理px）を上書きしない（二重適用防止）。
    bool   restoredFromSavedSize { false };
    int    designTargetW { 760 };
    int    designTargetH { 540 };

    // アナライザ描画用 scratch（UI スレッドのみ使用）
    std::array<float, ze::dsp::Analyzer::kNumDisplayBins> preSpectrumScratch{};
    std::array<float, ze::dsp::Analyzer::kNumDisplayBins> postSpectrumScratch{};

#if defined(JUCE_WINDOWS)
    double lastHwndScaleFactor { 0.0 };
    int    lastHwndDpi         { 0 };
    void   pollAndMaybeNotifyDpiChange();
#endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ZeroEQAudioProcessorEditor)
};
