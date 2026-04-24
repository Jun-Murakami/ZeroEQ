#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <cmath>
#include <algorithm>
#include <memory>
#include <vector>

namespace {
    inline void atomicMaxFloat(std::atomic<float>& slot, float candidate) noexcept
    {
        float prev = slot.load(std::memory_order_relaxed);
        while (candidate > prev &&
               !slot.compare_exchange_weak(prev, candidate,
                                           std::memory_order_acq_rel,
                                           std::memory_order_relaxed))
        { /* retry */ }
    }

    inline float sanitizeFinite(float v, float fallback = 0.0f) noexcept
    {
        return std::isfinite(v) ? v : fallback;
    }

    inline float clampFinite(float v, float lo, float hi, float fallback) noexcept
    {
        return juce::jlimit(lo, hi, sanitizeFinite(v, fallback));
    }

    inline void sanitizeBufferFinite(juce::AudioBuffer<float>& buffer, int numChannels, int numSamples) noexcept
    {
        for (int ch = 0; ch < numChannels; ++ch)
        {
            auto* data = buffer.getWritePointer(ch);
            for (int i = 0; i < numSamples; ++i)
                if (! std::isfinite(data[i]))
                    data[i] = 0.0f;
        }
    }

    juce::NormalisableRange<float> makeLogRange(float start, float end, float interval = 0.0f)
    {
        return juce::NormalisableRange<float>(
            start, end,
            [](float a, float b, float t)  { return a * std::pow(b / a, t); },
            [](float a, float b, float v)  { return std::log(v / a) / std::log(b / a); },
            [interval](float a, float b, float v)
            {
                v = juce::jlimit(a, b, v);
                if (interval > 0.0f)
                    v = a * std::pow(b / a, std::round(std::log(v / a) / std::log(b / a) / interval) * interval);
                return v;
            });
    }

} // anonymous namespace

ZeroEQAudioProcessor::ZeroEQAudioProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      parameters(*this, nullptr, juce::Identifier("ZeroEQ"), createParameterLayout())
{
}

ZeroEQAudioProcessor::~ZeroEQAudioProcessor() = default;

juce::AudioProcessorValueTreeState::ParameterLayout ZeroEQAudioProcessor::createParameterLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    // グローバル
    params.push_back(std::make_unique<juce::AudioParameterBool>(
        ze::id::BYPASS, "Bypass", false));

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        ze::id::OUTPUT_GAIN, "Output Gain",
        juce::NormalisableRange<float>(-24.0f, 24.0f, 0.1f), 0.0f,
        juce::AudioParameterFloatAttributes().withLabel("dB")));

    params.push_back(std::make_unique<juce::AudioParameterChoice>(
        ze::id::ANALYZER_MODE, "Analyzer",
        juce::StringArray{ "Off", "Pre", "Post", "Pre+Post" }, 3)); // Pre+Post: EQ 前後のゴースト比較表示

    // バンド（11 本固定配置。デフォルト type / freq / Q は ze::id::defaultFor(i) に集約）
    const juce::StringArray bandTypeNames{ "Bell", "LowShelf", "HighShelf", "HighPass", "LowPass", "Notch" };

    for (int i = 0; i < ze::id::kNumBands; ++i)
    {
        const auto def = ze::id::defaultFor(i);
        const juce::String label = "Band " + juce::String(i + 1);

        params.push_back(std::make_unique<juce::AudioParameterBool>(
            ze::id::bandOnID(i),   label + " On",   def.on));

        params.push_back(std::make_unique<juce::AudioParameterChoice>(
            ze::id::bandTypeID(i), label + " Type", bandTypeNames, def.typeIdx));

        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            ze::id::bandFreqID(i), label + " Freq",
            makeLogRange(20.0f, 20000.0f), def.freqHz,
            juce::AudioParameterFloatAttributes().withLabel("Hz")));

        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            ze::id::bandGainID(i), label + " Gain",
            juce::NormalisableRange<float>(-32.0f, 32.0f, 0.1f), 0.0f,
            juce::AudioParameterFloatAttributes().withLabel("dB")));

        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            ze::id::bandQID(i),    label + " Q",
            makeLogRange(0.1f, 18.0f), def.q));

        // HP/LP 用スロープ (choice 0..5 = 6/12/18/24/36/48 dB/oct)。他タイプでは未使用だが保存用に全バンド作成。
        params.push_back(std::make_unique<juce::AudioParameterChoice>(
            ze::id::bandSlopeID(i), label + " Slope",
            juce::StringArray{ "6 dB/oct", "12 dB/oct", "18 dB/oct", "24 dB/oct", "36 dB/oct", "48 dB/oct" },
            def.slopeIdx));
    }

    return { params.begin(), params.end() };
}

const juce::String ZeroEQAudioProcessor::getName() const { return JucePlugin_Name; }
bool ZeroEQAudioProcessor::acceptsMidi() const           { return false; }
bool ZeroEQAudioProcessor::producesMidi() const          { return false; }
bool ZeroEQAudioProcessor::isMidiEffect() const          { return false; }
double ZeroEQAudioProcessor::getTailLengthSeconds() const{ return 0.0; }

int ZeroEQAudioProcessor::getNumPrograms() { return 1; }
int ZeroEQAudioProcessor::getCurrentProgram() { return 0; }
void ZeroEQAudioProcessor::setCurrentProgram(int) {}
const juce::String ZeroEQAudioProcessor::getProgramName(int) { return {}; }
void ZeroEQAudioProcessor::changeProgramName(int, const juce::String&) {}

void ZeroEQAudioProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    const int numCh = juce::jmax(1, getTotalNumOutputChannels());
    equalizer.prepare(sampleRate, numCh, samplesPerBlock);
    pullBandParamsIntoDSP();

    inputMomentary.prepareToPlay(sampleRate, samplesPerBlock);
    outputMomentary.prepareToPlay(sampleRate, samplesPerBlock);

    preAnalyzer.prepare(sampleRate, samplesPerBlock);
    postAnalyzer.prepare(sampleRate, samplesPerBlock);
}

void ZeroEQAudioProcessor::releaseResources()
{
    equalizer.reset();
    inputMomentary.reset();
    outputMomentary.reset();
    preAnalyzer.reset();
    postAnalyzer.reset();
}

bool ZeroEQAudioProcessor::isBusesLayoutSupported(const juce::AudioProcessor::BusesLayout& layouts) const
{
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();
    if (mainIn.isDisabled() || mainOut.isDisabled()) return false;
    if (mainIn != mainOut) return false;
    return mainOut == juce::AudioChannelSet::mono()
        || mainOut == juce::AudioChannelSet::stereo();
}

void ZeroEQAudioProcessor::pullBandParamsIntoDSP() noexcept
{
    for (int i = 0; i < ze::id::kNumBands; ++i)
    {
        ze::dsp::Equalizer::BandSpec spec;
        if (auto* p = parameters.getRawParameterValue(ze::id::bandOnID(i)))    spec.on     = p->load() > 0.5f;
        if (auto* p = parameters.getRawParameterValue(ze::id::bandTypeID(i)))  spec.type   = static_cast<ze::dsp::Equalizer::Type>(juce::jlimit(0, 5, static_cast<int>(p->load() + 0.5f)));
        if (auto* p = parameters.getRawParameterValue(ze::id::bandFreqID(i)))  spec.freqHz = clampFinite(p->load(), 20.0f, 20000.0f, 1000.0f);
        if (auto* p = parameters.getRawParameterValue(ze::id::bandGainID(i)))  spec.gainDb = clampFinite(p->load(), -32.0f, 32.0f,     0.0f);
        if (auto* p = parameters.getRawParameterValue(ze::id::bandQID(i)))     spec.q      = clampFinite(p->load(), 0.1f, 18.0f,       1.0f);
        if (auto* p = parameters.getRawParameterValue(ze::id::bandSlopeID(i)))
            spec.slopeDbPerOct = ze::id::slopeIdxToDbPerOct(juce::jlimit(0, 5, static_cast<int>(p->load() + 0.5f)));
        equalizer.setBand(i, spec);
    }
}

void ZeroEQAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/)
{
    juce::ScopedNoDenormals noDenormals;

    const int numChannels = buffer.getNumChannels();
    const int numSamples  = buffer.getNumSamples();
    if (numSamples <= 0 || numChannels <= 0) return;

    sanitizeBufferFinite(buffer, numChannels, numSamples);

    // --- パラメータ ---
    const bool  bypass    = parameters.getRawParameterValue(ze::id::BYPASS.getParamID())->load() > 0.5f;
    const float outGainDb = clampFinite(parameters.getRawParameterValue(ze::id::OUTPUT_GAIN.getParamID())->load(), -24.0f, 24.0f, 0.0f);
    const int   anaMode   = juce::jlimit(0, 3, static_cast<int>(parameters.getRawParameterValue(ze::id::ANALYZER_MODE.getParamID())->load() + 0.5f));

    pullBandParamsIntoDSP();

    // --- 入力メータ + Pre アナライザ ---
    {
        auto* l = buffer.getReadPointer(0);
        auto* r = buffer.getReadPointer(std::min(1, numChannels - 1));
        float peakL = 0.0f, peakR = 0.0f, sqL = 0.0f, sqR = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            const float al = std::abs(l[i]);
            const float ar = std::abs(r[i]);
            peakL = std::max(peakL, al);
            peakR = std::max(peakR, ar);
            sqL += l[i] * l[i];
            sqR += r[i] * r[i];
        }
        atomicMaxFloat(inPeakAccumL, peakL);
        atomicMaxFloat(inPeakAccumR, peakR);
        const float invN = 1.0f / static_cast<float>(numSamples);
        atomicMaxFloat(inRmsAccumL, std::sqrt(sqL * invN));
        atomicMaxFloat(inRmsAccumR, std::sqrt(sqR * invN));
    }
    inputMomentary.processBlock(buffer);
    if (anaMode == 1 || anaMode == 3)
        preAnalyzer.pushBlock(buffer);

    // --- EQ 本体 ---
    if (! bypass)
        equalizer.processBlock(buffer);

    // --- 出力ゲイン ---
    const float outGainLin = std::pow(10.0f, outGainDb / 20.0f);
    if (std::abs(outGainLin - 1.0f) > 1.0e-6f)
    {
        for (int ch = 0; ch < numChannels; ++ch)
            buffer.applyGain(ch, 0, numSamples, outGainLin);
    }

    // --- 出力メータ + Post アナライザ ---
    {
        auto* l = buffer.getReadPointer(0);
        auto* r = buffer.getReadPointer(std::min(1, numChannels - 1));
        float peakL = 0.0f, peakR = 0.0f, sqL = 0.0f, sqR = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            const float al = std::abs(l[i]);
            const float ar = std::abs(r[i]);
            peakL = std::max(peakL, al);
            peakR = std::max(peakR, ar);
            sqL += l[i] * l[i];
            sqR += r[i] * r[i];
        }
        atomicMaxFloat(outPeakAccumL, peakL);
        atomicMaxFloat(outPeakAccumR, peakR);
        const float invN = 1.0f / static_cast<float>(numSamples);
        atomicMaxFloat(outRmsAccumL, std::sqrt(sqL * invN));
        atomicMaxFloat(outRmsAccumR, std::sqrt(sqR * invN));
    }
    outputMomentary.processBlock(buffer);
    if (anaMode == 2 || anaMode == 3)
        postAnalyzer.pushBlock(buffer);
}

bool ZeroEQAudioProcessor::hasEditor() const { return true; }

juce::AudioProcessorEditor* ZeroEQAudioProcessor::createEditor()
{
    return new ZeroEQAudioProcessorEditor(*this);
}

void ZeroEQAudioProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    if (auto xml = parameters.copyState().createXml())
        copyXmlToBinary(*xml, destData);
}

void ZeroEQAudioProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary(data, sizeInBytes))
    {
        if (xml->hasTagName(parameters.state.getType()))
            parameters.replaceState(juce::ValueTree::fromXml(*xml));
    }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ZeroEQAudioProcessor();
}
