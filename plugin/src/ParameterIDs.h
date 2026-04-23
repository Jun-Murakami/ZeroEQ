#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace ze::id {

// ===============================================================================
// ゼロレイテンシー EQ のパラメータ群
//
// グローバル:
//   - BYPASS:          bool        （既定 false）
//   - OUTPUT_GAIN:     -24..+24 dB （既定 0）
//   - ANALYZER_MODE:   choice      0=Off / 1=Pre / 2=Post / 3=Pre+Post（既定 Post）
//
// バンド（8 本、Pro-Q ライクの最小位相 IIR カスケード）:
//   - BAND{n}_ON:    bool         （既定 false）
//   - BAND{n}_TYPE:  choice       0=Bell / 1=LowShelf / 2=HighShelf / 3=HighPass / 4=LowPass / 5=Notch
//   - BAND{n}_FREQ:  20..20000 Hz （log skew, 既定値はバンドごとに分散配置）
//   - BAND{n}_GAIN:  -24..+24 dB  （Bell/Shelf のみ有効）
//   - BAND{n}_Q:     0.1..18.0    （log skew, 既定 1.0）
// ===============================================================================

static constexpr int kNumBands = 8;

// グローバル
const juce::ParameterID BYPASS       { "BYPASS",        1 };
const juce::ParameterID OUTPUT_GAIN  { "OUTPUT_GAIN",   1 };
const juce::ParameterID ANALYZER_MODE{ "ANALYZER_MODE", 1 };

// バンド ID（文字列を動的に組み立てる。APVTS は StringRef ベースなので問題なし）
inline juce::String bandOnID   (int i) { return "BAND" + juce::String(i) + "_ON";   }
inline juce::String bandTypeID (int i) { return "BAND" + juce::String(i) + "_TYPE"; }
inline juce::String bandFreqID (int i) { return "BAND" + juce::String(i) + "_FREQ"; }
inline juce::String bandGainID (int i) { return "BAND" + juce::String(i) + "_GAIN"; }
inline juce::String bandQID    (int i) { return "BAND" + juce::String(i) + "_Q";    }

}  // namespace ze::id
