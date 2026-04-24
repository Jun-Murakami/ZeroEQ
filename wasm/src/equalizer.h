// ZeroEQ Equalizer の JUCE 非依存版。
//  plugin/src/dsp/Equalizer.{h,cpp} を純 C++ に移植。ビヘイビアは同一（11 バンド、
//  HP/LP の Butterworth Q 分解、全バンド OFF 時のビット同一パス含む）。
//  biquad は Transposed Direct Form II を使用。RBJ クックブック係数は
//  webui/src/components/eq/eqCurve.ts と揃えてある。
#pragma once

#include <array>
#include <cmath>

namespace ze_wasm {

class Equalizer
{
public:
    static constexpr int kNumBands = 11;
    static constexpr int kMaxChannels = 2;
    static constexpr int kMaxStages = 5;

    enum Type
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
        int   type           = Bell;
        float freqHz         = 1000.0f;
        float gainDb         = 0.0f;
        float q              = 1.0f;
        int   slopeDbPerOct  = 12;
    };

    void prepare(double sampleRate) noexcept
    {
        sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
        for (int b = 0; b < kNumBands; ++b)
        {
            activeStageCount_[b] = 0;
            rebuildCoefficients(b);
        }
        reset();
    }

    void reset() noexcept
    {
        for (int b = 0; b < kNumBands; ++b)
            for (int s = 0; s < kMaxStages; ++s)
                for (int ch = 0; ch < kMaxChannels; ++ch)
                    state_[b][s][ch] = {};
    }

    void setBand(int index, const BandSpec& spec) noexcept
    {
        if (index < 0 || index >= kNumBands) return;
        active_[index] = spec;
        rebuildCoefficients(index);
    }

    // In-place stereo processing. チャネル数は 2 固定（AudioWorklet の常用ケース）。
    void processBlock(float* L, float* R, int numSamples) noexcept
    {
        if (numSamples <= 0) return;

        // 全バンド OFF ならバイパス（ビット同一）
        bool anyOn = false;
        for (int b = 0; b < kNumBands; ++b) if (active_[b].on) { anyOn = true; break; }
        if (! anyOn) return;

        for (int b = 0; b < kNumBands; ++b)
        {
            if (! active_[b].on) continue;
            const int stages = activeStageCount_[b];
            for (int s = 0; s < stages; ++s)
            {
                auto& co = coeffs_[b][s];
                auto& stL = state_[b][s][0];
                auto& stR = state_[b][s][1];
                for (int i = 0; i < numSamples; ++i)
                {
                    const float xl = L[i];
                    const float yl = co.b0 * xl + stL.z1;
                    stL.z1 = co.b1 * xl - co.a1 * yl + stL.z2;
                    stL.z2 = co.b2 * xl - co.a2 * yl;
                    L[i] = yl;

                    const float xr = R[i];
                    const float yr = co.b0 * xr + stR.z1;
                    stR.z1 = co.b1 * xr - co.a1 * yr + stR.z2;
                    stR.z2 = co.b2 * xr - co.a2 * yr;
                    R[i] = yr;
                }
            }
        }
    }

private:
    struct Coeffs
    {
        // normalised: a0=1 になるよう a/b を前もって a0 で割っておく
        float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
        float a1 = 0.0f, a2 = 0.0f;
    };
    struct State { float z1 = 0.0f, z2 = 0.0f; };

    // ---- RBJ biquad 生成（a0 正規化済みを返す） ----
    static Coeffs makePeak(double sr, double f, double Q, double A)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double a0 = 1.0 + alpha / A;
        Coeffs c;
        c.b0 = static_cast<float>((1.0 + alpha * A) / a0);
        c.b1 = static_cast<float>((-2.0 * cosw) / a0);
        c.b2 = static_cast<float>((1.0 - alpha * A) / a0);
        c.a1 = static_cast<float>((-2.0 * cosw) / a0);
        c.a2 = static_cast<float>((1.0 - alpha / A) / a0);
        return c;
    }
    static Coeffs makeLowShelf(double sr, double f, double Q, double A)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double sqrtA2alpha = 2.0 * std::sqrt(A) * alpha;
        const double a0 = (A + 1.0) + (A - 1.0) * cosw + sqrtA2alpha;
        Coeffs c;
        c.b0 = static_cast<float>((A * ((A + 1.0) - (A - 1.0) * cosw + sqrtA2alpha)) / a0);
        c.b1 = static_cast<float>((2.0 * A * ((A - 1.0) - (A + 1.0) * cosw)) / a0);
        c.b2 = static_cast<float>((A * ((A + 1.0) - (A - 1.0) * cosw - sqrtA2alpha)) / a0);
        c.a1 = static_cast<float>((-2.0 * ((A - 1.0) + (A + 1.0) * cosw)) / a0);
        c.a2 = static_cast<float>(((A + 1.0) + (A - 1.0) * cosw - sqrtA2alpha) / a0);
        return c;
    }
    static Coeffs makeHighShelf(double sr, double f, double Q, double A)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double sqrtA2alpha = 2.0 * std::sqrt(A) * alpha;
        const double a0 = (A + 1.0) - (A - 1.0) * cosw + sqrtA2alpha;
        Coeffs c;
        c.b0 = static_cast<float>((A * ((A + 1.0) + (A - 1.0) * cosw + sqrtA2alpha)) / a0);
        c.b1 = static_cast<float>((-2.0 * A * ((A - 1.0) + (A + 1.0) * cosw)) / a0);
        c.b2 = static_cast<float>((A * ((A + 1.0) + (A - 1.0) * cosw - sqrtA2alpha)) / a0);
        c.a1 = static_cast<float>((2.0 * ((A - 1.0) - (A + 1.0) * cosw)) / a0);
        c.a2 = static_cast<float>(((A + 1.0) - (A - 1.0) * cosw - sqrtA2alpha) / a0);
        return c;
    }
    static Coeffs makeHighPass(double sr, double f, double Q)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double a0 = 1.0 + alpha;
        Coeffs c;
        c.b0 = static_cast<float>(((1.0 + cosw) / 2.0) / a0);
        c.b1 = static_cast<float>((-(1.0 + cosw)) / a0);
        c.b2 = static_cast<float>(((1.0 + cosw) / 2.0) / a0);
        c.a1 = static_cast<float>((-2.0 * cosw) / a0);
        c.a2 = static_cast<float>((1.0 - alpha) / a0);
        return c;
    }
    static Coeffs makeLowPass(double sr, double f, double Q)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double a0 = 1.0 + alpha;
        Coeffs c;
        c.b0 = static_cast<float>(((1.0 - cosw) / 2.0) / a0);
        c.b1 = static_cast<float>((1.0 - cosw) / a0);
        c.b2 = static_cast<float>(((1.0 - cosw) / 2.0) / a0);
        c.a1 = static_cast<float>((-2.0 * cosw) / a0);
        c.a2 = static_cast<float>((1.0 - alpha) / a0);
        return c;
    }
    static Coeffs makeNotch(double sr, double f, double Q)
    {
        const double w0 = 2.0 * 3.14159265358979323846 * f / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * Q);
        const double a0 = 1.0 + alpha;
        Coeffs c;
        c.b0 = static_cast<float>(1.0 / a0);
        c.b1 = static_cast<float>((-2.0 * cosw) / a0);
        c.b2 = static_cast<float>(1.0 / a0);
        c.a1 = static_cast<float>((-2.0 * cosw) / a0);
        c.a2 = static_cast<float>((1.0 - alpha) / a0);
        return c;
    }
    // 1 次 HP/LP を biquad コンテナに詰める（b2=a2=0）
    static Coeffs makeFirstOrderHP(double sr, double f)
    {
        const double K = std::tan(3.14159265358979323846 * f / sr);
        const double denom = K + 1.0;
        Coeffs c;
        c.b0 = static_cast<float>(1.0 / denom);
        c.b1 = static_cast<float>(-1.0 / denom);
        c.b2 = 0.0f;
        c.a1 = static_cast<float>((K - 1.0) / denom);
        c.a2 = 0.0f;
        return c;
    }
    static Coeffs makeFirstOrderLP(double sr, double f)
    {
        const double K = std::tan(3.14159265358979323846 * f / sr);
        const double denom = K + 1.0;
        const double g = K / denom;
        Coeffs c;
        c.b0 = static_cast<float>(g);
        c.b1 = static_cast<float>(g);
        c.b2 = 0.0f;
        c.a1 = static_cast<float>((K - 1.0) / denom);
        c.a2 = 0.0f;
        return c;
    }

    struct SlopePlan { int numBiquads; bool has1stOrder; float biquadQs[4]; };
    static const SlopePlan& slopeStagePlan(int slopeDbPerOct) noexcept
    {
        // Butterworth n 次の biquad 分解 Q = 1/(2·sin((2k-1)π/(2n)))
        static const SlopePlan s6  = { 0, true,  { 0.0f,        0.0f,        0.0f,        0.0f        } };
        static const SlopePlan s12 = { 1, false, { 0.70710678f, 0.0f,        0.0f,        0.0f        } };
        static const SlopePlan s18 = { 1, true,  { 1.0f,        0.0f,        0.0f,        0.0f        } };
        static const SlopePlan s24 = { 2, false, { 1.30656296f, 0.54119610f, 0.0f,        0.0f        } };
        static const SlopePlan s36 = { 3, false, { 1.93185165f, 0.70710678f, 0.51763809f, 0.0f        } };
        static const SlopePlan s48 = { 4, false, { 2.56291545f, 0.89997622f, 0.60134489f, 0.50979558f } };
        static const SlopePlan sdefault = s12;

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

    static float clampf(float v, float lo, float hi) noexcept
    {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    void rebuildCoefficients(int b) noexcept
    {
        const BandSpec& s = active_[b];
        const double sr = sampleRate_;
        const double f  = static_cast<double>(clampf(s.freqHz, 10.0f, static_cast<float>(sr * 0.49)));
        const double q  = static_cast<double>(clampf(s.q,      0.1f,  18.0f));
        const double g  = static_cast<double>(clampf(s.gainDb, -32.0f, 32.0f));

        // Bell/Shelf/Notch は単一 biquad
        if (s.type == Bell || s.type == LowShelf || s.type == HighShelf || s.type == Notch)
        {
            const double A = std::pow(10.0, g / 40.0);
            switch (s.type)
            {
                case Bell:      coeffs_[b][0] = makePeak      (sr, f, q, A); break;
                case LowShelf:  coeffs_[b][0] = makeLowShelf  (sr, f, q, A); break;
                case HighShelf: coeffs_[b][0] = makeHighShelf (sr, f, q, A); break;
                case Notch:     coeffs_[b][0] = makeNotch     (sr, f, q);    break;
                default: coeffs_[b][0] = Coeffs{}; break;
            }
            activeStageCount_[b] = 1;
            return;
        }

        // HP/LP: Butterworth Q を各段に割り当て、gainDb で resonance 倍率をスケール
        const SlopePlan& plan = slopeStagePlan(s.slopeDbPerOct);
        const float scale = static_cast<float>(std::pow(10.0, g / 20.0));

        int stage = 0;
        for (int i = 0; i < plan.numBiquads; ++i, ++stage)
        {
            const float stageQ = clampf(plan.biquadQs[i] * scale, 0.1f, 18.0f);
            coeffs_[b][stage] = (s.type == HighPass)
                ? makeHighPass(sr, f, stageQ)
                : makeLowPass (sr, f, stageQ);
        }
        if (plan.has1stOrder)
        {
            coeffs_[b][stage] = (s.type == HighPass)
                ? makeFirstOrderHP(sr, f)
                : makeFirstOrderLP(sr, f);
            ++stage;
        }
        activeStageCount_[b] = stage;
    }

    double sampleRate_ = 48000.0;
    std::array<BandSpec, kNumBands> active_{};
    std::array<std::array<Coeffs, kMaxStages>, kNumBands> coeffs_{};
    std::array<std::array<std::array<State, kMaxChannels>, kMaxStages>, kNumBands> state_{};
    std::array<int, kNumBands> activeStageCount_{};
};

} // namespace ze_wasm
