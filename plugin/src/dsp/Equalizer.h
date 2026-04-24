#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <array>
#include <atomic>

namespace ze::dsp {

// ===============================================================================
// ゼロレイテンシー EQ（11 バンド、最小位相 IIR カスケード）
//
// - Bell / LowShelf / HighShelf / Notch: 1 段の biquad
// - HighPass / LowPass: slope (6/12/18/24/36/48 dB/oct) に応じて
//     6  → 1st-order 1 段
//     12 → biquad 1 段
//     18 → biquad 1 段 + 1st-order 1 段
//     24 → biquad 2 段
//     36 → biquad 3 段
//     48 → biquad 4 段
//   のカスケード。各 biquad 段には次数 n の Butterworth 分解 Q (1/(2sin((2k-1)π/(2n)))) を
//   割り当て、gainDb=0 でちょうど maximally flat になるようにしてある。ユーザの
//   gainDb は Butterworth Q への乗算係数 (= 10^(gainDb/20)) として全段に共通適用され、
//   0 dB で flat、+ で共振増、- で damping 増となる。
// - 係数は setBand(...) で即時反映。processBlock 内での alloc は係数差し替えの
//   短時間のみ（IIR::Coefficients は RefCountedObject なので UI 操作頻度では許容）。
// - 全バンド OFF 時は完全スルー（厳密な 0 sample レイテンシ、ビット同一）
// ===============================================================================
class Equalizer
{
public:
    static constexpr int kNumBands = 11;
    static constexpr int kMaxChannels = 2;
    // 1 バンドあたりの最大フィルタ段数 (4 biquad + 1 first-order = 5)
    static constexpr int kMaxStages = 5;

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
        bool  on             = false;
        Type  type           = Type::Bell;
        float freqHz         = 1000.0f;
        float gainDb         = 0.0f;
        float q              = 1.0f;
        int   slopeDbPerOct  = 12;  // HP/LP のみ意味を持つ。値は 6/12/18/24/36/48 のいずれか。
    };

    void prepare(double sampleRate, int numChannels, int maxBlockSize) noexcept;
    void reset() noexcept;

    // パラメータ更新（パラメータスレッド／UI スレッドから呼んで OK）
    void setBand(int index, const BandSpec& spec) noexcept;

    // ブロック処理。全バンドが OFF なら何もしない（完全バイパス）。
    void processBlock(juce::AudioBuffer<float>& buffer) noexcept;

private:
    void rebuildCoefficients(int bandIdx) noexcept;

    double sampleRate_ = 44100.0;
    int    numChannels_ = 2;

    std::array<BandSpec, kNumBands> pending_{};
    std::array<std::atomic<bool>, kNumBands> dirty_{};
    std::array<BandSpec, kNumBands> active_{};

    // per-band × per-channel × per-stage の IIR フィルタ
    //   stage 数は activeStageCount_[band] で可変。1st-order も biquad コンテナで扱う（b2=a2=0）。
    std::array<std::array<std::array<juce::dsp::IIR::Filter<float>, kMaxChannels>, kMaxStages>, kNumBands> filters_{};
    std::array<int, kNumBands> activeStageCount_{};
};

} // namespace ze::dsp
