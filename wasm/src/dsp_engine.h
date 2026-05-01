// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
// WASM デモ用 DSP オーケストレータ（ZeroEQ 版）。
//  - 1 本のオーディオソース（PCM L/R）+ トランスポート
//  - 11 バンド EQ (Equalizer)
//  - Pre / Post アナライザ (Analyzer × 2)
//  - Output ゲイン
//  - Input / Output メーター（Peak / RMS / Momentary LKFS）
#pragma once

#include "equalizer.h"
#include "analyzer.h"
#include "momentary_processor.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <vector>

namespace ze_wasm {

class DspEngine
{
public:
    static constexpr int kNumBands = Equalizer::kNumBands;    // 11
    static constexpr int kSpectrumBins = Analyzer::kNumDisplayBins; // 256

    void prepare(double sr, int maxBlock) noexcept
    {
        sampleRate = std::isfinite(sr) && sr > 0.0 ? sr : 48000.0;
        maxBlockSize = std::max(1, maxBlock);

        equalizer.prepare(sampleRate);
        preAnalyzer .prepare(sampleRate, maxBlockSize);
        postAnalyzer.prepare(sampleRate, maxBlockSize);
        momentaryIn .prepare(sampleRate, maxBlockSize);
        momentaryOut.prepare(sampleRate, maxBlockSize);

        // ワーキング用スクラッチ
        scratchL.assign(static_cast<size_t>(maxBlockSize), 0.0f);
        scratchR.assign(static_cast<size_t>(maxBlockSize), 0.0f);

        resetMeters();
    }

    // ====== ソース管理 ======

    void loadSource(const float* L, const float* R, int numSamples, double sourceSampleRate) noexcept
    {
        if (numSamples <= 0) { clearSource(); return; }
        sourceL.assign(L, L + numSamples);
        sourceR.assign(R ? R : L, (R ? R : L) + numSamples);
        for (auto& s : sourceL) s = sanitize(s);
        for (auto& s : sourceR) s = sanitize(s);
        sourceNumSamples = numSamples;
        sourceRate       = std::isfinite(sourceSampleRate) && sourceSampleRate > 0.0 ? sourceSampleRate : sampleRate;

        rateRatio = sourceRate / sampleRate;
        playPos   = 0.0;
        playing   = false;
        stoppedAtEnd = false;
    }

    void clearSource() noexcept
    {
        sourceL.clear(); sourceR.clear();
        sourceNumSamples = 0;
        playPos = 0.0;
        playing = false;
    }

    bool hasSource() const noexcept { return sourceNumSamples > 0; }

    // ====== トランスポート ======

    void setPlaying(bool p) noexcept
    {
        if (p && !hasSource()) return;
        if (p && stoppedAtEnd) { playPos = 0.0; stoppedAtEnd = false; }
        playing = p;
    }
    bool isPlaying() const noexcept { return playing; }

    void setLoop(bool enabled) noexcept { loopEnabled = enabled; }
    bool getLoop() const noexcept { return loopEnabled; }

    void seekNormalized(double norm) noexcept
    {
        if (sourceNumSamples <= 0) return;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;
        playPos = norm * static_cast<double>(sourceNumSamples);
        stoppedAtEnd = false;
    }

    double getPositionSeconds() const noexcept
    {
        return sourceRate > 0.0 ? playPos / sourceRate : 0.0;
    }
    double getDurationSeconds() const noexcept
    {
        return sourceRate > 0.0 ? static_cast<double>(sourceNumSamples) / sourceRate : 0.0;
    }

    bool consumeStoppedAtEnd() noexcept
    {
        if (stoppedAtEnd) { stoppedAtEnd = false; return true; }
        return false;
    }

    // ====== パラメータ ======

    void setBandOn     (int i, bool on)   noexcept { if (inRange(i)) { bands[i].on = on; push(i); } }
    void setBandType   (int i, int type)  noexcept { if (inRange(i)) { bands[i].type = clampType(type); push(i); } }
    void setBandFreqHz (int i, float hz)  noexcept { if (inRange(i)) { bands[i].freqHz = clampF(hz, 20.0f, 20000.0f, 1000.0f); push(i); } }
    void setBandGainDb (int i, float db)  noexcept { if (inRange(i)) { bands[i].gainDb = clampF(db, -32.0f, 32.0f, 0.0f); push(i); } }
    void setBandQ      (int i, float q)   noexcept { if (inRange(i)) { bands[i].q      = clampF(q,   0.1f,  18.0f, 1.0f); push(i); } }
    void setBandSlopeDb(int i, int slope) noexcept { if (inRange(i)) { bands[i].slopeDbPerOct = slope; push(i); } }

    void setBypass(bool b) noexcept         { bypass = b; }
    void setOutputGainDb(float db) noexcept { outputGainDb = clampF(db, -24.0f, 24.0f, 0.0f); }
    // 0=Off / 1=Pre / 2=Post / 3=Pre+Post
    void setAnalyzerMode(int m) noexcept    { if (m < 0) m = 0; if (m > 3) m = 3; analyzerMode = m; }

    void setMeteringMode(int m) noexcept { meteringMode = m; }

    // ====== メイン処理 ======

    void processBlock(float* outL, float* outR, int numSamples) noexcept
    {
        if (numSamples <= 0) return;
        if (numSamples > maxBlockSize)
        {
            int off = 0;
            while (off < numSamples)
            {
                const int chunk = std::min(maxBlockSize, numSamples - off);
                processBlock(outL + off, outR + off, chunk);
                off += chunk;
            }
            return;
        }

        // 1) source fetch
        fetchSource(outL, outR, numSamples);
        sanitizeStereo(outL, outR, numSamples);

        // 2) Input メーター + momentary
        accumInMeters(outL, outR, numSamples);
        momentaryIn.processStereo(outL, outR, numSamples);

        // 3) Pre アナライザ push（analyzerMode に応じて）
        if (analyzerMode == 1 || analyzerMode == 3)
            preAnalyzer.pushBlock(outL, outR, numSamples);

        // 4) EQ
        if (!bypass)
            equalizer.processBlock(outL, outR, numSamples);

        // 5) Output gain
        const float outGainLin = std::pow(10.0f, outputGainDb / 20.0f);
        if (std::fabs(outGainLin - 1.0f) > 1.0e-6f)
        {
            for (int i = 0; i < numSamples; ++i)
            {
                outL[i] *= outGainLin;
                outR[i] *= outGainLin;
            }
        }

        // 6) Output メーター + momentary + Post アナライザ
        accumOutMeters(outL, outR, numSamples);
        momentaryOut.processStereo(outL, outR, numSamples);
        if (analyzerMode == 2 || analyzerMode == 3)
            postAnalyzer.pushBlock(outL, outR, numSamples);
    }

    // ====== メーターデータ ======
    //  レイアウト（13 floats）:
    //   0: meteringMode
    //   1: inPeakL  2: inPeakR  3: inRmsL  4: inRmsR  5: inMomentary
    //   6: outPeakL 7: outPeakR 8: outRmsL 9: outRmsR 10: outMomentary
    //  11: reserved 12: reserved
    void getMeterData(float* out) noexcept
    {
        const float minDb   = -60.0f;
        const float minLkfs = -70.0f;

        out[0]  = static_cast<float>(meteringMode);
        out[1]  = ampToDb(inPeakAccumL, minDb);
        out[2]  = ampToDb(inPeakAccumR, minDb);
        out[3]  = ampToDb(inRmsAccumL,  minDb);
        out[4]  = ampToDb(inRmsAccumR,  minDb);
        out[5]  = momentaryIn.getMomentaryLKFS();  if (out[5] < minLkfs) out[5] = minLkfs;
        out[6]  = ampToDb(outPeakAccumL, minDb);
        out[7]  = ampToDb(outPeakAccumR, minDb);
        out[8]  = ampToDb(outRmsAccumL,  minDb);
        out[9]  = ampToDb(outRmsAccumR,  minDb);
        out[10] = momentaryOut.getMomentaryLKFS(); if (out[10] < minLkfs) out[10] = minLkfs;
        out[11] = 0.0f;
        out[12] = 0.0f;

        // plugin 60Hz タイマ想定の減衰（0.965 ≈ ~20dB/s リリース）
        constexpr float kDecay = 0.965f;
        inPeakAccumL  *= kDecay; inPeakAccumR  *= kDecay;
        outPeakAccumL *= kDecay; outPeakAccumR *= kDecay;
        inRmsAccumL   *= kDecay; inRmsAccumR   *= kDecay;
        outRmsAccumL  *= kDecay; outRmsAccumR  *= kDecay;
    }

    void resetMomentaryHold() noexcept
    {
        momentaryIn.reset();
        momentaryOut.reset();
    }

    // ====== スペクトラム pull ======
    // outPre/outPost: それぞれ size = kSpectrumBins (256) の float 配列。
    //   hop たまっていれば drain → FFT → dB 配列を書き込み、戻り値は bit0=pre, bit1=post。
    //   呼び出し頻度は JS 側 ~60Hz を想定。
    int drainSpectrum(float* outPre, float* outPost) noexcept
    {
        int flags = 0;
        if (outPre  && (analyzerMode == 1 || analyzerMode == 3))
            if (preAnalyzer.drainAndCompute(outPre))  flags |= 0x1;
        if (outPost && (analyzerMode == 2 || analyzerMode == 3))
            if (postAnalyzer.drainAndCompute(outPost)) flags |= 0x2;
        return flags;
    }

private:
    static bool  inRange(int i) noexcept { return i >= 0 && i < kNumBands; }
    static int   clampType(int t) noexcept { if (t < 0) t = 0; if (t > 5) t = 5; return t; }
    static float sanitize(float v) noexcept { return std::isfinite(v) ? v : 0.0f; }
    static float clampF(float v, float lo, float hi, float fallback) noexcept
    {
        if (!std::isfinite(v)) return fallback;
        return v < lo ? lo : (v > hi ? hi : v);
    }
    static void sanitizeStereo(float* L, float* R, int n) noexcept
    {
        for (int i = 0; i < n; ++i) { L[i] = sanitize(L[i]); R[i] = sanitize(R[i]); }
    }
    static float ampToDb(float amp, float floorDb) noexcept
    {
        if (!std::isfinite(amp) || amp <= 0.0f) return floorDb;
        const float db = 20.0f * std::log10(amp);
        return std::max(db, floorDb);
    }

    void push(int i) noexcept
    {
        Equalizer::BandSpec spec;
        spec.on            = bands[i].on;
        spec.type          = bands[i].type;
        spec.freqHz        = bands[i].freqHz;
        spec.gainDb        = bands[i].gainDb;
        spec.q             = bands[i].q;
        spec.slopeDbPerOct = bands[i].slopeDbPerOct;
        equalizer.setBand(i, spec);
    }

    void fetchSource(float* outL, float* outR, int n) noexcept
    {
        if (!playing || sourceNumSamples <= 0)
        {
            std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
            std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
            return;
        }
        for (int i = 0; i < n; ++i)
        {
            double idx = playPos;
            int i0 = static_cast<int>(idx);
            int i1 = i0 + 1;
            double frac = idx - static_cast<double>(i0);

            if (i0 >= sourceNumSamples)
            {
                if (loopEnabled) { playPos = 0.0; stoppedAtEnd = false; idx = 0.0; i0 = 0; i1 = 1; frac = 0.0; }
                else
                {
                    outL[i] = 0.0f; outR[i] = 0.0f;
                    playing = false; stoppedAtEnd = true;
                    for (int k = i + 1; k < n; ++k) { outL[k] = 0.0f; outR[k] = 0.0f; }
                    return;
                }
            }
            if (i1 >= sourceNumSamples) i1 = loopEnabled ? 0 : i0;

            const float l0 = sourceL[static_cast<size_t>(i0)];
            const float l1 = sourceL[static_cast<size_t>(i1)];
            const float r0 = sourceR[static_cast<size_t>(i0)];
            const float r1 = sourceR[static_cast<size_t>(i1)];
            outL[i] = static_cast<float>(l0 + (l1 - l0) * frac);
            outR[i] = static_cast<float>(r0 + (r1 - r0) * frac);

            playPos += rateRatio;
        }
    }

    void accumInMeters(const float* L, const float* R, int n) noexcept
    {
        float pL = inPeakAccumL, pR = inPeakAccumR;
        double sumL = 0.0, sumR = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const float l = sanitize(L[i]);
            const float r = sanitize(R[i]);
            const float aL = std::fabs(l);
            const float aR = std::fabs(r);
            if (aL > pL) pL = aL;
            if (aR > pR) pR = aR;
            sumL += static_cast<double>(l) * l;
            sumR += static_cast<double>(r) * r;
        }
        inPeakAccumL = pL; inPeakAccumR = pR;
        const float rmsL = static_cast<float>(std::sqrt(sumL / static_cast<double>(n)));
        const float rmsR = static_cast<float>(std::sqrt(sumR / static_cast<double>(n)));
        if (rmsL > inRmsAccumL) inRmsAccumL = rmsL;
        if (rmsR > inRmsAccumR) inRmsAccumR = rmsR;
    }

    void accumOutMeters(const float* L, const float* R, int n) noexcept
    {
        float pL = outPeakAccumL, pR = outPeakAccumR;
        double sumL = 0.0, sumR = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const float l = sanitize(L[i]);
            const float r = sanitize(R[i]);
            const float aL = std::fabs(l);
            const float aR = std::fabs(r);
            if (aL > pL) pL = aL;
            if (aR > pR) pR = aR;
            sumL += static_cast<double>(l) * l;
            sumR += static_cast<double>(r) * r;
        }
        outPeakAccumL = pL; outPeakAccumR = pR;
        const float rmsL = static_cast<float>(std::sqrt(sumL / static_cast<double>(n)));
        const float rmsR = static_cast<float>(std::sqrt(sumR / static_cast<double>(n)));
        if (rmsL > outRmsAccumL) outRmsAccumL = rmsL;
        if (rmsR > outRmsAccumR) outRmsAccumR = rmsR;
    }

    void resetMeters() noexcept
    {
        inPeakAccumL = inPeakAccumR = 0.0f;
        outPeakAccumL = outPeakAccumR = 0.0f;
        inRmsAccumL = inRmsAccumR = 0.0f;
        outRmsAccumL = outRmsAccumR = 0.0f;
    }

    // ---- state ----
    double sampleRate = 48000.0;
    int    maxBlockSize = 128;

    // Source
    std::vector<float> sourceL, sourceR;
    int    sourceNumSamples = 0;
    double sourceRate = 48000.0;
    double rateRatio = 1.0;

    // Transport
    double playPos = 0.0;
    bool   playing = false;
    bool   loopEnabled = true;
    bool   stoppedAtEnd = false;

    // EQ state (cached for partial updates)
    struct BandState
    {
        bool on = false; int type = 0;
        float freqHz = 1000.0f, gainDb = 0.0f, q = 1.0f;
        int slopeDbPerOct = 18;
    };
    std::array<BandState, kNumBands> bands{};

    // Global
    bool  bypass        = false;
    float outputGainDb  = 0.0f;
    int   analyzerMode  = 3;      // default Pre+Post
    int   meteringMode  = 0;

    // DSP
    Equalizer           equalizer;
    Analyzer            preAnalyzer;
    Analyzer            postAnalyzer;
    MomentaryProcessor  momentaryIn;
    MomentaryProcessor  momentaryOut;

    // Meter accumulators
    float inPeakAccumL  = 0.0f, inPeakAccumR  = 0.0f;
    float outPeakAccumL = 0.0f, outPeakAccumR = 0.0f;
    float inRmsAccumL   = 0.0f, inRmsAccumR   = 0.0f;
    float outRmsAccumL  = 0.0f, outRmsAccumR  = 0.0f;

    // スクラッチ
    std::vector<float> scratchL, scratchR;
};

} // namespace ze_wasm
