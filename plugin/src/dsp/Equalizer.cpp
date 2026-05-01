// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#include "Equalizer.h"

#include <cmath>

namespace ze::dsp {

namespace {

using Coeffs    = juce::dsp::IIR::Coefficients<float>;
using CoeffsPtr = Coeffs::Ptr;

// Bell / Shelf / Notch のための biquad 係数
//  Coefficients<float> に合わせてローカルを float に統一（double→float の縮退警告 C4244 を回避）。
CoeffsPtr makeToneCoeffs(const Equalizer::BandSpec& spec, double sampleRate)
{
    const float sr   = static_cast<float>(sampleRate);
    const float f    = juce::jlimit(10.0f, sr * 0.49f, spec.freqHz);
    const float q    = juce::jlimit(0.1f,  18.0f,     spec.q);
    const float g    = juce::jlimit(-32.0f, 32.0f,    spec.gainDb);
    const float gLin = juce::Decibels::decibelsToGain(g);

    using Type = Equalizer::Type;
    switch (spec.type)
    {
        case Type::Bell:      return Coeffs::makePeakFilter (sr, f, q, gLin);
        case Type::LowShelf:  return Coeffs::makeLowShelf   (sr, f, q, gLin);
        case Type::HighShelf: return Coeffs::makeHighShelf  (sr, f, q, gLin);
        case Type::Notch:     return Coeffs::makeNotch      (sr, f, q);
        default: break;
    }
    return Coeffs::makePeakFilter(sr, f, q, 1.0f);
}

// HP/LP 用 biquad（resonance Q を gainDb から導出）
CoeffsPtr makeHpLpBiquad(Equalizer::Type type, double sampleRate, float freqHz, float Q)
{
    const float sr = static_cast<float>(sampleRate);
    const float f  = juce::jlimit(10.0f, sr * 0.49f, freqHz);
    const float q  = juce::jlimit(0.1f,  18.0f,     Q);
    if (type == Equalizer::Type::HighPass) return Coeffs::makeHighPass(sr, f, q);
    return Coeffs::makeLowPass(sr, f, q);
}

// HP/LP 用 1st-order フィルタ（biquad 形式で b2=a2=0）
CoeffsPtr makeHpLpFirstOrder(Equalizer::Type type, double sampleRate, float freqHz)
{
    const float sr = static_cast<float>(sampleRate);
    const float f  = juce::jlimit(10.0f, sr * 0.49f, freqHz);
    if (type == Equalizer::Type::HighPass) return Coeffs::makeFirstOrderHighPass(sr, f);
    return Coeffs::makeFirstOrderLowPass(sr, f);
}

// HP/LP gain knob 値 → Butterworth Q への乗算係数。
//   0 dB → 1.0 (pure Butterworth = maximally flat)
//   + で各段 Q 拡大（共振増）、− で damping 強化。
inline float resonanceScaleFromGainDb(float gainDb) noexcept
{
    return std::pow(10.0f, gainDb / 20.0f);
}

// Butterworth n 次を biquad 段に分解した各段の Q 値。式: 1 / (2·sin((2k-1)π/(2n)))。
// 最大段数は kMaxBiquads = 4 (48 dB/oct = 8 次)。
struct SlopeStagePlan
{
    int  numBiquads;      // 0..4
    bool has1stOrder;     // 奇数次なら true
    float biquadQs[4];    // 未使用部は 0
};

inline const SlopeStagePlan& slopeStagePlan(int slopeDbPerOct) noexcept
{
    // 係数は一度計算して static に保持（alloc 不要、lookup 定数時間）。
    //   Butterworth Q_k = 1 / (2·sin((2k-1)π/(2n))), k=1..⌊n/2⌋
    static const SlopeStagePlan s6  = { 0, true,  { 0.0f,          0.0f,          0.0f,          0.0f          } };
    static const SlopeStagePlan s12 = { 1, false, { 0.70710678f,   0.0f,          0.0f,          0.0f          } };
    static const SlopeStagePlan s18 = { 1, true,  { 1.0f,          0.0f,          0.0f,          0.0f          } };
    static const SlopeStagePlan s24 = { 2, false, { 1.30656296f,   0.54119610f,   0.0f,          0.0f          } };
    static const SlopeStagePlan s36 = { 3, false, { 1.93185165f,   0.70710678f,   0.51763809f,   0.0f          } };
    static const SlopeStagePlan s48 = { 4, false, { 2.56291545f,   0.89997622f,   0.60134489f,   0.50979558f   } };
    static const SlopeStagePlan sdefault = s12;

    switch (slopeDbPerOct)
    {
        case  6: return s6;
        case 12: return s12;
        case 18: return s18;
        case 24: return s24;
        case 36: return s36;
        case 48: return s48;
        default: return sdefault;
    }
}

} // namespace

void Equalizer::prepare(double sampleRate, int numChannels, int maxBlockSize) noexcept
{
    sampleRate_  = sampleRate;
    numChannels_ = juce::jlimit(1, kMaxChannels, numChannels);

    juce::dsp::ProcessSpec spec{};
    spec.sampleRate       = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(juce::jmax(1, maxBlockSize));
    spec.numChannels      = 1; // per-channel で手動ループ

    for (int b = 0; b < kNumBands; ++b)
    {
        for (int s = 0; s < kMaxStages; ++s)
            for (int ch = 0; ch < kMaxChannels; ++ch)
                filters_[b][s][ch].prepare(spec);

        activeStageCount_[b] = 0;
        dirty_[b].store(true, std::memory_order_release);
        rebuildCoefficients(b);
    }
}

void Equalizer::reset() noexcept
{
    for (int b = 0; b < kNumBands; ++b)
        for (int s = 0; s < kMaxStages; ++s)
            for (int ch = 0; ch < kMaxChannels; ++ch)
                filters_[b][s][ch].reset();
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
    const auto& s = active_[b];

    // Bell / Shelf / Notch は単一 biquad
    if (s.type == Type::Bell || s.type == Type::LowShelf
        || s.type == Type::HighShelf || s.type == Type::Notch)
    {
        auto coeffs = makeToneCoeffs(s, sampleRate_);
        for (int ch = 0; ch < kMaxChannels; ++ch)
            *filters_[b][0][ch].coefficients = *coeffs;
        activeStageCount_[b] = 1;
        return;
    }

    // HighPass / LowPass: 各 biquad 段に Butterworth の段別 Q を割り当てて maximally flat を基本形にし、
    // ユーザの gainDb は共通スケールとして各段 Q に乗算する。0 dB = Butterworth、+ で共振増。
    const auto& plan = slopeStagePlan(s.slopeDbPerOct);
    const float scale = resonanceScaleFromGainDb(s.gainDb);

    int stage = 0;
    for (int i = 0; i < plan.numBiquads; ++i, ++stage)
    {
        const float stageQ = juce::jlimit(0.1f, 18.0f, plan.biquadQs[i] * scale);
        auto coeffs = makeHpLpBiquad(s.type, sampleRate_, s.freqHz, stageQ);
        for (int ch = 0; ch < kMaxChannels; ++ch)
            *filters_[b][stage][ch].coefficients = *coeffs;
    }

    if (plan.has1stOrder)
    {
        auto coeffs = makeHpLpFirstOrder(s.type, sampleRate_, s.freqHz);
        for (int ch = 0; ch < kMaxChannels; ++ch)
            *filters_[b][stage][ch].coefficients = *coeffs;
        ++stage;
    }
    activeStageCount_[b] = stage;
}

void Equalizer::processBlock(juce::AudioBuffer<float>& buffer) noexcept
{
    // dirty なバンドの係数を再計算
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
        const int stages = activeStageCount_[b];
        if (stages <= 0) continue;

        for (int ch = 0; ch < numChannels; ++ch)
        {
            auto* data = buffer.getWritePointer(ch);
            juce::dsp::AudioBlock<float> block(&data, 1, static_cast<size_t>(numSamples));
            juce::dsp::ProcessContextReplacing<float> ctx(block);
            for (int s = 0; s < stages; ++s)
                filters_[b][s][ch].process(ctx);
        }
    }
}

} // namespace ze::dsp
