#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace ze::id {

// ===============================================================================
// ZeroEQ のパラメータ群（11 バンド固定配置）
//
// グローバル:
//   - BYPASS:          bool
//   - OUTPUT_GAIN:     -24..+24 dB
//   - ANALYZER_MODE:   choice  0=Off / 1=Pre / 2=Post / 3=Pre+Post
//
// バンド（11 本、固定タイプ配置）:
//   インデックス → タイプ:
//     0, 1           = HighPass   （左端の 2 本、slope は Q で制御）
//     2              = LowShelf
//     3, 4, 5, 6, 7, 8 = Bell    （6 本）
//     9              = HighShelf
//     10             = LowPass
//
//   - BAND{n}_ON:    bool           （既定 false）
//   - BAND{n}_TYPE:  choice 0..5    0=Bell / 1=LowShelf / 2=HighShelf / 3=HighPass / 4=LowPass / 5=Notch
//   - BAND{n}_FREQ:  20..20000 Hz   log skew
//   - BAND{n}_GAIN:  -32..+32 dB    Bell/Shelf のみ有効、HP/LP では UI が無効化
//   - BAND{n}_Q:     0.1..18.0      log skew
// ===============================================================================

static constexpr int kNumBands = 11;

// グローバル
const juce::ParameterID BYPASS            { "BYPASS",            1 };
const juce::ParameterID OUTPUT_GAIN       { "OUTPUT_GAIN",       1 };
const juce::ParameterID ANALYZER_MODE     { "ANALYZER_MODE",     1 };
// UI 状態（下部セクションパネルの開閉）。非オートメーション / meta 扱いで APVTS に保持。
const juce::ParameterID BOTTOM_PANEL_OPEN { "BOTTOM_PANEL_OPEN", 1 };

// バンド ID（文字列を動的に組み立てる。APVTS は StringRef ベースなので問題なし）
inline juce::String bandOnID    (int i) { return "BAND" + juce::String(i) + "_ON";    }
inline juce::String bandTypeID  (int i) { return "BAND" + juce::String(i) + "_TYPE";  }
inline juce::String bandFreqID  (int i) { return "BAND" + juce::String(i) + "_FREQ";  }
inline juce::String bandGainID  (int i) { return "BAND" + juce::String(i) + "_GAIN";  }
inline juce::String bandQID     (int i) { return "BAND" + juce::String(i) + "_Q";     }
inline juce::String bandSlopeID (int i) { return "BAND" + juce::String(i) + "_SLOPE"; }

// slope choice index → dB/oct 値。APVTS では choice (0..5) で保存。
//   0=6, 1=12, 2=18, 3=24, 4=36, 5=48 dB/oct
inline int slopeIdxToDbPerOct(int idx) noexcept
{
    constexpr int kTable[] = { 6, 12, 18, 24, 36, 48 };
    if (idx < 0 || idx >= 6) return 12;
    return kTable[idx];
}

// バンドごとのデフォルト設定（WebUI 側 BandDefs.ts と揃える）。
//   - typeIdx は TYPE choice の index
//   - freqHz は対数で分散配置（30 / 60 / 120 / 250 / 500 / 1k / 2k / 4k / 8k / 12k / 18k Hz）
//   - HP/LP の Q は 0.707 (12 dB/oct Butterworth)、それ以外は 1.0
struct BandDefault
{
    int   typeIdx;
    float freqHz;
    float q;
    bool  on;       // HP/LP は既定 OFF、それ以外は既定 ON
    int   slopeIdx; // HP/LP 用の slope choice index（0=6, 1=12, 2=18, 3=24, 4=36, 5=48 dB/oct）
};

inline BandDefault defaultFor(int i) noexcept
{
    static const BandDefault kDefaults[kNumBands] = {
        //  type, freq Hz, Q,    on,    slope idx (18 dB/oct = 2)
        {  3,   30.0f, 0.707f, false, 2 }, // HPF
        {  3,   60.0f, 0.707f, false, 2 }, // HPF
        {  1,  120.0f, 0.707f, true,  2 }, // LowShelf
        {  0,  250.0f, 1.000f, true,  2 }, // Bell
        {  0,  500.0f, 1.000f, true,  2 }, // Bell
        {  0, 1000.0f, 1.000f, true,  2 }, // Bell
        {  0, 2000.0f, 1.000f, true,  2 }, // Bell
        {  0, 4000.0f, 1.000f, true,  2 }, // Bell
        {  0, 8000.0f, 1.000f, true,  2 }, // Bell
        {  2, 12000.0f, 0.707f, true, 2 }, // HighShelf
        {  4, 18000.0f, 0.707f, false, 2 }, // LowPass
    };
    if (i < 0 || i >= kNumBands) return { 0, 1000.0f, 1.0f, false, 2 };
    return kDefaults[i];
}

}  // namespace ze::id
