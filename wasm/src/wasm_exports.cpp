// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
// JS 側（AudioWorklet）が呼ぶ C ABI。
// エンジン本体は dsp_engine.h。ZeroEQ 固有パラメータ（11 バンド + グローバル）を公開。
#include "dsp_engine.h"
#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define WASM_EXPORT
#endif

static ze_wasm::DspEngine* g_engine = nullptr;

extern "C" {

// ---------- 初期化 / 解放 ----------

WASM_EXPORT void dsp_init(double sampleRate, int maxBlockSize)
{
    if (g_engine) delete g_engine;
    g_engine = new ze_wasm::DspEngine();
    g_engine->prepare(sampleRate, maxBlockSize);
}

WASM_EXPORT void dsp_destroy()
{
    delete g_engine;
    g_engine = nullptr;
}

// ---------- メモリ ----------

WASM_EXPORT float* dsp_alloc_buffer(int numSamples)
{
    return static_cast<float*>(std::malloc(sizeof(float) * static_cast<size_t>(numSamples)));
}

WASM_EXPORT void dsp_free_buffer(float* p)
{
    std::free(p);
}

// ---------- ソース管理 ----------

WASM_EXPORT void dsp_load_source(const float* L, const float* R, int numSamples, double sampleRate)
{
    if (g_engine) g_engine->loadSource(L, R, numSamples, sampleRate);
}

WASM_EXPORT void dsp_clear_source()
{
    if (g_engine) g_engine->clearSource();
}

// ---------- トランスポート ----------

WASM_EXPORT void dsp_set_playing(int p)            { if (g_engine) g_engine->setPlaying(p != 0); }
WASM_EXPORT int  dsp_is_playing()                  { return g_engine && g_engine->isPlaying() ? 1 : 0; }
WASM_EXPORT void dsp_set_loop(int enabled)         { if (g_engine) g_engine->setLoop(enabled != 0); }
WASM_EXPORT int  dsp_consume_stopped_at_end()      { return g_engine && g_engine->consumeStoppedAtEnd() ? 1 : 0; }
WASM_EXPORT void dsp_seek_normalised(double norm)  { if (g_engine) g_engine->seekNormalized(norm); }
WASM_EXPORT double dsp_get_position()              { return g_engine ? g_engine->getPositionSeconds() : 0.0; }
WASM_EXPORT double dsp_get_duration()              { return g_engine ? g_engine->getDurationSeconds() : 0.0; }

// ---------- バンドパラメータ ----------

WASM_EXPORT void dsp_set_band_on    (int idx, int on)     { if (g_engine) g_engine->setBandOn(idx, on != 0); }
WASM_EXPORT void dsp_set_band_type  (int idx, int t)      { if (g_engine) g_engine->setBandType(idx, t); }
WASM_EXPORT void dsp_set_band_freq  (int idx, float hz)   { if (g_engine) g_engine->setBandFreqHz(idx, hz); }
WASM_EXPORT void dsp_set_band_gain  (int idx, float db)   { if (g_engine) g_engine->setBandGainDb(idx, db); }
WASM_EXPORT void dsp_set_band_q     (int idx, float q)    { if (g_engine) g_engine->setBandQ(idx, q); }
WASM_EXPORT void dsp_set_band_slope (int idx, int slope)  { if (g_engine) g_engine->setBandSlopeDb(idx, slope); }

// ---------- グローバルパラメータ ----------

WASM_EXPORT void dsp_set_bypass       (int b)        { if (g_engine) g_engine->setBypass(b != 0); }
WASM_EXPORT void dsp_set_output_gain_db(float db)    { if (g_engine) g_engine->setOutputGainDb(db); }
WASM_EXPORT void dsp_set_analyzer_mode(int m)        { if (g_engine) g_engine->setAnalyzerMode(m); }
WASM_EXPORT void dsp_set_metering_mode(int m)        { if (g_engine) g_engine->setMeteringMode(m); }

// ---------- メイン処理 / メーター ----------

WASM_EXPORT void dsp_process_block(float* outL, float* outR, int numSamples)
{
    if (g_engine) g_engine->processBlock(outL, outR, numSamples);
}

WASM_EXPORT void dsp_get_meter_data(float* buf13)
{
    if (g_engine) g_engine->getMeterData(buf13);
}

WASM_EXPORT void dsp_reset_momentary()
{
    if (g_engine) g_engine->resetMomentaryHold();
}

// ---------- スペクトラム ----------
// outPre / outPost: size = 256 (kNumDisplayBins) の float 配列。
// 戻り値 bit 0 = pre 更新, bit 1 = post 更新。両方 null は未定義動作。
WASM_EXPORT int dsp_drain_spectrum(float* outPre, float* outPost)
{
    if (!g_engine) return 0;
    return g_engine->drainSpectrum(outPre, outPost);
}

WASM_EXPORT int dsp_spectrum_bins()
{
    return ze_wasm::DspEngine::kSpectrumBins;
}

} // extern "C"
