#include "Analyzer.h"

#include <algorithm>
#include <cmath>

namespace ze::dsp {

Analyzer::Analyzer() = default;

void Analyzer::prepare(double sampleRate, int maxBlockSize) noexcept
{
    sampleRate_ = sampleRate;

    // リングは少なくとも FFT size × 2 + 余裕ぶん確保
    ringSize_ = juce::nextPowerOfTwo(kFftSize * 2 + juce::jmax(maxBlockSize * 2, 1024));
    ringBuffer_.assign(static_cast<size_t>(ringSize_), 0.0f);

    // Hann 窓
    fftWindow_.resize(kFftSize);
    for (int i = 0; i < kFftSize; ++i)
        fftWindow_[static_cast<size_t>(i)] =
            0.5f - 0.5f * std::cos(juce::MathConstants<float>::twoPi * static_cast<float>(i)
                                   / static_cast<float>(kFftSize - 1));

    fftScratch_.assign(static_cast<size_t>(kFftSize) * 2, 0.0f);
    smoothedDb_.assign(static_cast<size_t>(kNumDisplayBins), -120.0f);

    writeIndex_.store(0, std::memory_order_relaxed);
    writeCounter_.store(0, std::memory_order_relaxed);
    lastReadCounter_ = 0;
}

void Analyzer::reset() noexcept
{
    std::fill(ringBuffer_.begin(), ringBuffer_.end(), 0.0f);
    std::fill(smoothedDb_.begin(), smoothedDb_.end(), -120.0f);
    writeIndex_.store(0, std::memory_order_relaxed);
    writeCounter_.store(0, std::memory_order_relaxed);
    lastReadCounter_ = 0;
}

void Analyzer::pushBlock(const juce::AudioBuffer<float>& buffer) noexcept
{
    if (ringSize_ <= 0) return;

    const int numChannels = buffer.getNumChannels();
    const int numSamples  = buffer.getNumSamples();
    if (numChannels <= 0 || numSamples <= 0) return;

    const float invCh = 1.0f / static_cast<float>(numChannels);
    int w = writeIndex_.load(std::memory_order_relaxed);

    for (int i = 0; i < numSamples; ++i)
    {
        float sum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
            sum += buffer.getSample(ch, i);
        ringBuffer_[static_cast<size_t>(w)] = sum * invCh;
        w = (w + 1) & (ringSize_ - 1);
    }

    writeIndex_.store(w, std::memory_order_release);
    writeCounter_.fetch_add(numSamples, std::memory_order_release);
}

bool Analyzer::drainAndCompute(float* outDb) noexcept
{
    const int cur = writeCounter_.load(std::memory_order_acquire);
    if (cur - lastReadCounter_ < kFftSize / 2)
        return false;   // まだ 1 フレーム分（hop = FFT/2）たまっていない
    lastReadCounter_ = cur;

    // 最新 kFftSize サンプルを rings から取り出し、窓をかけて FFT 入力にコピー
    const int end = writeIndex_.load(std::memory_order_acquire);
    int start = (end - kFftSize) & (ringSize_ - 1);

    // fftScratch_ は [re, im, re, im, ...] ではなく、JUCE の performRealOnlyForwardTransform は
    // 実数列 size kFftSize を受け取り、同じバッファに結果を書き戻す（ハーフ複素）形。
    std::fill(fftScratch_.begin(), fftScratch_.end(), 0.0f);
    for (int i = 0; i < kFftSize; ++i)
    {
        const int idx = (start + i) & (ringSize_ - 1);
        fftScratch_[static_cast<size_t>(i)] = ringBuffer_[static_cast<size_t>(idx)]
                                             * fftWindow_[static_cast<size_t>(i)];
    }
    fft_.performRealOnlyForwardTransform(fftScratch_.data());

    // マグニチュード（ハーフ複素）→ dB → log-freq リサンプル → 表示用配列
    //  低域は複数の表示ビンが同じ FFT ビンに集まる（FFT の線形周波数解像度の制約）ため、
    //  隣接 FFT ビン間を dB 空間で線形補間して階段状を防ぐ。
    if (outDb != nullptr)
    {
        const float norm = 2.0f / static_cast<float>(kFftSize);
        // 表示上限: min(22kHz, Nyquist)
        const float maxHz = juce::jmin(kMaxDisplayHz, static_cast<float>(sampleRate_ * 0.5));

        auto magDbAtBin = [&](int bin) noexcept -> float
        {
            const float re = fftScratch_[static_cast<size_t>(bin * 2)];
            const float im = fftScratch_[static_cast<size_t>(bin * 2 + 1)];
            const float mag = std::sqrt(re * re + im * im) * norm;
            return juce::Decibels::gainToDecibels(mag, -120.0f);
        };

        for (int i = 0; i < kNumDisplayBins; ++i)
        {
            // log-freq: 20Hz..maxHz を kNumDisplayBins で対数等分
            const float t  = static_cast<float>(i) / static_cast<float>(kNumDisplayBins - 1);
            const float hz = 20.0f * std::pow(maxHz / 20.0f, t);
            const float binF = hz * static_cast<float>(kFftSize) / static_cast<float>(sampleRate_);

            // dB 空間で隣接 FFT ビン間を線形補間（低域の階段解消）
            const int   b0   = juce::jlimit(1, kNumBins - 2, static_cast<int>(std::floor(binF)));
            const float frac = juce::jlimit(0.0f, 1.0f, binF - static_cast<float>(b0));
            const float db0  = magDbAtBin(b0);
            const float db1  = magDbAtBin(b0 + 1);
            const float db   = db0 + frac * (db1 - db0);

            // スムージング（アタック速い、リリース遅い）
            const float prev = smoothedDb_[static_cast<size_t>(i)];
            const float attack  = 0.6f;
            const float release = 0.05f;
            const float coef = (db > prev) ? attack : release;
            const float next = prev + coef * (db - prev);
            smoothedDb_[static_cast<size_t>(i)] = next;
            outDb[i] = next;
        }
    }

    return true;
}

} // namespace ze::dsp
