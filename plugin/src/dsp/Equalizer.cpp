#include "Equalizer.h"

#include <cmath>

namespace ze::dsp {

namespace {

// 各バンドタイプに応じた IIR biquad 係数を生成。
juce::dsp::IIR::Coefficients<float>::Ptr makeCoeffsFor(const Equalizer::BandSpec& spec,
                                                      double sampleRate)
{
    const double sr = sampleRate;
    const double f  = juce::jlimit(10.0, sr * 0.49, static_cast<double>(spec.freqHz));
    const double q  = juce::jlimit(0.1, 18.0, static_cast<double>(spec.q));
    const double g  = juce::jlimit(-24.0, 24.0, static_cast<double>(spec.gainDb));

    using Coeffs = juce::dsp::IIR::Coefficients<float>;
    using Type   = Equalizer::Type;

    switch (spec.type)
    {
        case Type::Bell:      return Coeffs::makePeakFilter (sr, f, q, juce::Decibels::decibelsToGain(static_cast<float>(g)));
        case Type::LowShelf:  return Coeffs::makeLowShelf   (sr, f, q, juce::Decibels::decibelsToGain(static_cast<float>(g)));
        case Type::HighShelf: return Coeffs::makeHighShelf  (sr, f, q, juce::Decibels::decibelsToGain(static_cast<float>(g)));
        case Type::HighPass:  return Coeffs::makeHighPass   (sr, f, q);
        case Type::LowPass:   return Coeffs::makeLowPass    (sr, f, q);
        case Type::Notch:     return Coeffs::makeNotch      (sr, f, q);
    }
    return Coeffs::makePeakFilter(sr, f, q, 1.0f);
}

} // namespace

void Equalizer::prepare(double sampleRate, int numChannels, int maxBlockSize) noexcept
{
    juce::ignoreUnused(maxBlockSize);
    sampleRate_  = sampleRate;
    numChannels_ = juce::jlimit(1, kMaxChannels, numChannels);

    juce::dsp::ProcessSpec spec{};
    spec.sampleRate       = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(juce::jmax(1, maxBlockSize));
    spec.numChannels      = 1;  // per-channel biquad（手動でチャネル毎にかけるので常に 1）

    for (int b = 0; b < kNumBands; ++b)
    {
        for (int ch = 0; ch < kMaxChannels; ++ch)
            filters_[b][ch].prepare(spec);

        // 初期係数（パススルー相当の Bell at 1kHz, 0dB）を入れておく
        auto coeffs = makeCoeffsFor(active_[b], sampleRate_);
        for (int ch = 0; ch < kMaxChannels; ++ch)
            *filters_[b][ch].coefficients = *coeffs;
    }
}

void Equalizer::reset() noexcept
{
    for (int b = 0; b < kNumBands; ++b)
        for (int ch = 0; ch < kMaxChannels; ++ch)
            filters_[b][ch].reset();
}

void Equalizer::setBand(int index, const BandSpec& spec) noexcept
{
    if (index < 0 || index >= kNumBands) return;
    pending_[index] = spec;
    dirty_[index].store(true, std::memory_order_release);
}

void Equalizer::rebuildCoefficients(int b) noexcept
{
    active_[b] = pending_[b];
    auto coeffs = makeCoeffsFor(active_[b], sampleRate_);
    for (int ch = 0; ch < kMaxChannels; ++ch)
        *filters_[b][ch].coefficients = *coeffs;
}

void Equalizer::processBlock(juce::AudioBuffer<float>& buffer) noexcept
{
    // dirty なバンドの係数を再計算（オーディオスレッドで alloc しない設計：
    //   juce::dsp::IIR::Coefficients は RefCountedObject を差し替えるため、
    //   短時間の allocate が発生しうる。レアイベント前提で妥協。
    //   完全ゼロ alloc を保証したい場合は pre-sized の coeffs プール化が必要）
    for (int b = 0; b < kNumBands; ++b)
    {
        bool expected = true;
        if (dirty_[b].compare_exchange_strong(expected, false,
                                              std::memory_order_acq_rel,
                                              std::memory_order_relaxed))
            rebuildCoefficients(b);
    }

    const int numChannels = juce::jmin(buffer.getNumChannels(), numChannels_);
    const int numSamples  = buffer.getNumSamples();
    if (numSamples <= 0 || numChannels <= 0) return;

    for (int b = 0; b < kNumBands; ++b)
    {
        if (! active_[b].on) continue;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            auto* data = buffer.getWritePointer(ch);
            juce::dsp::AudioBlock<float> block(&data, 1, static_cast<size_t>(numSamples));
            juce::dsp::ProcessContextReplacing<float> ctx(block);
            filters_[b][ch].process(ctx);
        }
    }
}

} // namespace ze::dsp
