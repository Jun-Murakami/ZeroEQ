// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
// ZeroEQ Analyzer の JUCE 非依存版。plugin/src/dsp/Analyzer.{h,cpp} を移植。
//   ring buffer (downmixed mono) → Hann 窓 + FFT (radix-2) → 線形ビン間補間
//   → log-freq kNumDisplayBins リサンプル → attack/release スムージング。
#pragma once

#include "fft.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace ze_wasm {

class Analyzer
{
public:
    static constexpr int kFftOrder       = 12;           // 4096 point
    static constexpr int kFftSize        = 1 << kFftOrder;
    static constexpr int kNumBins        = kFftSize / 2;
    static constexpr int kNumDisplayBins = 256;
    static constexpr float kMaxDisplayHz = 22000.0f;

    void prepare(double sampleRate, int maxBlockSize) noexcept
    {
        sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;

        // リングは FFT サイズ × 2 + ブロック + 余裕ぶん、最小 1024。
        int size = kFftSize * 2 + (maxBlockSize > 0 ? maxBlockSize * 2 : 0) + 1024;
        int pow2 = 1; while (pow2 < size) pow2 <<= 1;
        ringSize_ = pow2;
        ringBuffer_.assign(static_cast<size_t>(ringSize_), 0.0f);

        // Hann 窓
        fftWindow_.resize(static_cast<size_t>(kFftSize));
        for (int i = 0; i < kFftSize; ++i)
        {
            const float t = 0.5f - 0.5f * std::cos(6.28318530717958647692f * static_cast<float>(i)
                                                   / static_cast<float>(kFftSize - 1));
            fftWindow_[static_cast<size_t>(i)] = t;
        }

        // FFT は複素入力レイアウトで size=kFftSize。スクラッチは 2*kFftSize floats。
        fft_.setOrder(kFftOrder);
        fftScratch_.assign(static_cast<size_t>(kFftSize) * 2, 0.0f);

        smoothedDb_.assign(static_cast<size_t>(kNumDisplayBins), -120.0f);

        writeIndex_ = 0;
        writeCounter_ = 0;
        lastReadCounter_ = 0;
    }

    void reset() noexcept
    {
        std::fill(ringBuffer_.begin(), ringBuffer_.end(), 0.0f);
        std::fill(smoothedDb_.begin(), smoothedDb_.end(), -120.0f);
        writeIndex_ = 0;
        writeCounter_ = 0;
        lastReadCounter_ = 0;
    }

    // 1 ブロックぶんのステレオサンプルを mono downmix してリングに push
    void pushBlock(const float* L, const float* R, int numSamples) noexcept
    {
        if (ringSize_ <= 0 || numSamples <= 0) return;
        int w = writeIndex_;
        const int mask = ringSize_ - 1;
        for (int i = 0; i < numSamples; ++i)
        {
            const float s = 0.5f * (L[i] + (R ? R[i] : L[i]));
            ringBuffer_[static_cast<size_t>(w)] = s;
            w = (w + 1) & mask;
        }
        writeIndex_ = w;
        writeCounter_ += numSamples;
    }

    // hop (= kFftSize/2) サンプル分たまっていれば 1 フレーム FFT + dB 配列を計算して true。
    bool drainAndCompute(float* outDb) noexcept
    {
        if (writeCounter_ - lastReadCounter_ < kFftSize / 2)
            return false;
        lastReadCounter_ = writeCounter_;

        // 最新 kFftSize サンプルを取り出し、Hann 窓を掛けながら fftScratch に配置。
        // fftScratch は complex interleaved [re, im, re, im, ...]。実入力なので im=0。
        std::fill(fftScratch_.begin(), fftScratch_.end(), 0.0f);
        const int end = writeIndex_;
        const int mask = ringSize_ - 1;
        const int start = (end - kFftSize) & mask;
        for (int i = 0; i < kFftSize; ++i)
        {
            const int idx = (start + i) & mask;
            fftScratch_[static_cast<size_t>(i) * 2]     = ringBuffer_[static_cast<size_t>(idx)]
                                                         * fftWindow_[static_cast<size_t>(i)];
            // im は 0 のまま
        }
        fft_.performForward(fftScratch_.data());

        if (outDb == nullptr) return true;

        const float norm = 2.0f / static_cast<float>(kFftSize);
        const float maxHz = std::min(kMaxDisplayHz, static_cast<float>(sampleRate_ * 0.5));

        auto magDbAtBin = [&](int bin) -> float
        {
            const float re = fftScratch_[static_cast<size_t>(bin) * 2];
            const float im = fftScratch_[static_cast<size_t>(bin) * 2 + 1];
            const float mag = std::sqrt(re * re + im * im) * norm;
            return mag > 0.0f ? 20.0f * std::log10(mag) : -120.0f;
        };

        for (int i = 0; i < kNumDisplayBins; ++i)
        {
            const float t  = static_cast<float>(i) / static_cast<float>(kNumDisplayBins - 1);
            const float hz = 20.0f * std::pow(maxHz / 20.0f, t);
            const float binF = hz * static_cast<float>(kFftSize) / static_cast<float>(sampleRate_);

            int b0 = static_cast<int>(std::floor(binF));
            if (b0 < 1) b0 = 1;
            if (b0 > kNumBins - 2) b0 = kNumBins - 2;
            const float frac = std::max(0.0f, std::min(1.0f, binF - static_cast<float>(b0)));
            const float db0  = magDbAtBin(b0);
            const float db1  = magDbAtBin(b0 + 1);
            const float db   = db0 + frac * (db1 - db0);

            // 60Hz smoothing（attack 速い、release 遅い）。plugin 側と係数を一致。
            const float prev = smoothedDb_[static_cast<size_t>(i)];
            const float attack  = 0.37f;
            const float release = 0.025f;
            const float coef = (db > prev) ? attack : release;
            const float next = prev + coef * (db - prev);
            smoothedDb_[static_cast<size_t>(i)] = next;
            outDb[i] = next;
        }
        return true;
    }

private:
    double sampleRate_ = 48000.0;
    int    ringSize_   = 0;
    std::vector<float> ringBuffer_;
    int    writeIndex_     = 0;
    int    writeCounter_   = 0;  // 単一スレッドから呼ぶ前提 (AudioWorklet は single-threaded)
    int    lastReadCounter_ = 0;

    FFT                fft_;
    std::vector<float> fftWindow_;
    std::vector<float> fftScratch_;
    std::vector<float> smoothedDb_;
};

} // namespace ze_wasm
