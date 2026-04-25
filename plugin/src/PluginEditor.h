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

    juce::WebToggleButtonParameterAttachment bypassAttachment;
    juce::WebSliderParameterAttachment       outputGainAttachment;
    juce::WebComboBoxParameterAttachment     analyzerModeAttachment;
    juce::WebToggleButtonParameterAttachment bottomPanelOpenAttachment;

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
