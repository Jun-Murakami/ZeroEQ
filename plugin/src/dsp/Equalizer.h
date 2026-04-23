#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <array>
#include <atomic>

namespace ze::dsp {

// ===============================================================================
// ゼロレイテンシー EQ（8 バンド、最小位相 IIR カスケード）
//
// - 各バンドは 1 段の biquad（juce::dsp::IIR::Filter<float>）
// - 係数は setBand(...) で即時再計算。processBlock 内での allocate は無し。
// - 全バンドが OFF のときは完全スルー（厳密な 0 sample レイテンシ、ビット同一）
// - 最小位相のみ実装。linear-phase / natural-phase は将来拡張。
// ===============================================================================
class Equalizer
{
public:
    static constexpr int kNumBands = 8;
    static constexpr int kMaxChannels = 2;

    enum class Type
    {
        Bell      = 0,
        LowShelf  = 1,
        HighShelf = 2,
        HighPass  = 3,
        LowPass   = 4,
        Notch     = 5,
    };

    struct BandSpec
    {
        bool  on     = false;
        Type  type   = Type::Bell;
        float freqHz = 1000.0f;
        float gainDb = 0.0f;
        float q      = 1.0f;
    };

    void prepare(double sampleRate, int numChannels, int maxBlockSize) noexcept;
    void reset() noexcept;

    // パラメータ更新（パラメータスレッド／UI スレッドから呼んで OK）。
    // 係数は processBlock で適用される（atomic dirty フラグで同期）。
    void setBand(int index, const BandSpec& spec) noexcept;

    // ブロック処理。全バンドが OFF なら何もしない（完全バイパス）。
    void processBlock(juce::AudioBuffer<float>& buffer) noexcept;

private:
    void rebuildCoefficients(int bandIdx) noexcept;

    double sampleRate_ = 44100.0;
    int    numChannels_ = 2;

    std::array<BandSpec, kNumBands> pending_{};                 // UI/param → audio
    std::array<std::atomic<bool>, kNumBands> dirty_{};          // 再計算フラグ
    std::array<BandSpec, kNumBands> active_{};                  // audio thread のみが触る

    // per-band per-channel の biquad フィルタ
    std::array<std::array<juce::dsp::IIR::Filter<float>, kMaxChannels>, kNumBands> filters_{};
};

} // namespace ze::dsp
