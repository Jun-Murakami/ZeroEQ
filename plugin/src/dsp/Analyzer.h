// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <atomic>
#include <array>
#include <vector>

namespace ze::dsp {

// ===============================================================================
// スペクトラムアナライザ（FFT, log-freq ビン化, プレ/ポスト独立）
//
// 責務:
//   1. オーディオスレッドから入力サンプルをロックフリーで受け取る
//      （複数チャネルは push() 内で平均して 1ch にダウンミックス）
//   2. メッセージスレッド / タイマから drain → FFT → log-freq ビン化
//   3. WebUI 側に 30〜60Hz で転送できる表示用 dB 配列を提供
//
// 本スケルトンではプレーンリングバッファと FFT オブジェクトを用意するのみで、
// 実計算はまだ無し。UI 配線の土台として最小限のインタフェースを確定させる。
// ===============================================================================
class Analyzer
{
public:
    static constexpr int kFftOrder = 12;           // 4096 point — 低域分解能を上げるため 2048 から増量
    static constexpr int kFftSize  = 1 << kFftOrder;
    static constexpr int kNumBins  = kFftSize / 2;
    static constexpr int kNumDisplayBins = 256;    // UI 送信用（log-freq リサンプル済み）
    static constexpr float kMaxDisplayHz = 22000.0f; // 22kHz 超はカット（可聴域外）

    Analyzer();
    ~Analyzer() = default;

    void prepare(double sampleRate, int maxBlockSize) noexcept;
    void reset() noexcept;

    // audio thread: 1 ブロックぶんのサンプルをダウンミックスしてリングバッファへ積む
    void pushBlock(const juce::AudioBuffer<float>& buffer) noexcept;

    // message thread: 利用可能なサンプルを FFT にかけ、表示用 dB 配列を更新する
    // @param outDb    size = kNumDisplayBins の出力配列。nullptr 許容（その場合は計算だけ進める）。
    // @return         true if a new frame was produced this call
    bool drainAndCompute(float* outDb) noexcept;

    double getSampleRate() const noexcept { return sampleRate_; }

private:
    double sampleRate_ = 44100.0;

    // リングバッファ（ダウンミックス済みモノラル）
    std::vector<float>       ringBuffer_;
    std::atomic<int>         writeIndex_{ 0 };
    std::atomic<int>         writeCounter_{ 0 };   // 累積書き込みサンプル数（非同期 drain 判定用）
    int                      lastReadCounter_ = 0; // message thread のみ
    int                      ringSize_ = 0;

    // FFT 本体
    juce::dsp::FFT           fft_{ kFftOrder };
    std::vector<float>       fftWindow_;           // Hann 窓
    std::vector<float>       fftScratch_;          // size = kFftSize * 2（実数 + 虚数）

    // ピーク/ホールド用の per-bin スムージング
    std::vector<float>       smoothedDb_;
};

} // namespace ze::dsp
