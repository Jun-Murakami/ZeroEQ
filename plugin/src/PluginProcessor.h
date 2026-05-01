// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <atomic>

#include "ParameterIDs.h"
#include "dsp/Equalizer.h"
#include "dsp/Analyzer.h"
#include "dsp/MomentaryProcessor.h"

class ZeroEQAudioProcessor : public juce::AudioProcessor
{
public:
    ZeroEQAudioProcessor();
    ~ZeroEQAudioProcessor() override;

    const juce::String getName() const override;
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported(const juce::AudioProcessor::BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    bool hasEditor() const override;
    juce::AudioProcessorEditor* createEditor() override;

    double getTailLengthSeconds() const override;
    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram(int) override;
    const juce::String getProgramName(int) override;
    void changeProgramName(int, const juce::String&) override;
    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState& getState() { return parameters; }

    // ================= メーター蓄積（audio → UI）=================
    //  Peak/RMS は 区間最大を compare_exchange_weak で積み上げ、UI タイマで読み取り → 減衰。
    //  Momentary LKFS は MomentaryProcessor が内部で 400ms 窓を維持する。
    std::atomic<float> inPeakAccumL { 0.0f };
    std::atomic<float> inPeakAccumR { 0.0f };
    std::atomic<float> outPeakAccumL{ 0.0f };
    std::atomic<float> outPeakAccumR{ 0.0f };

    std::atomic<float> inRmsAccumL { 0.0f };
    std::atomic<float> inRmsAccumR { 0.0f };
    std::atomic<float> outRmsAccumL{ 0.0f };
    std::atomic<float> outRmsAccumR{ 0.0f };

    ze::dsp::MomentaryProcessor inputMomentary;
    ze::dsp::MomentaryProcessor outputMomentary;

    // ================= アナライザ（Pre / Post）=================
    //  audio thread: pre/post の両方に pushBlock()。
    //  UI thread: drainAndCompute() で dB 配列を取得。
    ze::dsp::Analyzer preAnalyzer;
    ze::dsp::Analyzer postAnalyzer;

private:
    juce::AudioProcessorValueTreeState parameters;
    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    // パラメータから Equalizer::BandSpec を読み出して DSP に反映する。
    void pullBandParamsIntoDSP() noexcept;

    ze::dsp::Equalizer equalizer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ZeroEQAudioProcessor)
};
