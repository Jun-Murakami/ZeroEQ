/**
 * juce-framework-frontend-mirror の Web 互換 shim（ZeroEQ 版）。
 * Vite エイリアスで本家モジュールの代わりにこれが解決される。
 *
 * ZeroEQ の APVTS パラメータ
 *   BYPASS / OUTPUT_GAIN / ANALYZER_MODE
 *   BAND{i}_ON / BAND{i}_TYPE / BAND{i}_FREQ / BAND{i}_GAIN / BAND{i}_Q / BAND{i}_SLOPE (i=0..10)
 * を Web 側でエミュレートし、値変化を WebAudioEngine へ直送する。
 *
 * 重要: フェーダー側 (ParameterFader / HorizontalParameter) は `setScaled` を
 *  「scaled 値 → 線形正規化 → setNormalisedValue」で呼ぶ。
 *  shim 側でも `toScaled` / `fromScaled` は線形マッピングにしておけば、plugin 側と同じ往復になる。
 */

import {
  WebSliderState,
  WebToggleState,
  WebComboBoxState,
} from './WebParamState';
import { webAudioEngine } from './WebAudioEngine';

const sliderStates   = new Map<string, WebSliderState>();
const toggleStates   = new Map<string, WebToggleState>();
const comboBoxStates = new Map<string, WebComboBoxState>();

function makeLinearSlider(defaultScaled: number, min: number, max: number): WebSliderState
{
  return new WebSliderState({
    defaultScaled,
    min,
    max,
    toScaled:   (n: number) => min + n * (max - min),
    fromScaled: (v: number) => (v - min) / (max - min),
  });
}

// ---- BAND デフォルト（plugin の ze::id::defaultFor と同じ 11 本のレイアウト）----
type BandDefault = {
  typeIdx: number;    // 0=Bell / 1=LowShelf / 2=HighShelf / 3=HighPass / 4=LowPass / 5=Notch
  freqHz: number;
  q: number;
  slopeIdx: number;   // 0=6 / 1=12 / 2=18 / 3=24 / 4=36 / 5=48
  on: boolean;
};

const BAND_DEFAULTS: BandDefault[] = [
  // idx 0,1: HPF (30, 60 Hz) — default OFF
  { typeIdx: 3, freqHz: 30,    q: 0.707, slopeIdx: 2, on: false },
  { typeIdx: 3, freqHz: 60,    q: 0.707, slopeIdx: 2, on: false },
  // idx 2: LowShelf
  { typeIdx: 1, freqHz: 120,   q: 0.707, slopeIdx: 2, on: true  },
  // idx 3..8: Bell × 6
  { typeIdx: 0, freqHz: 250,   q: 1.0,   slopeIdx: 2, on: true  },
  { typeIdx: 0, freqHz: 500,   q: 1.0,   slopeIdx: 2, on: true  },
  { typeIdx: 0, freqHz: 1000,  q: 1.0,   slopeIdx: 2, on: true  },
  { typeIdx: 0, freqHz: 2000,  q: 1.0,   slopeIdx: 2, on: true  },
  { typeIdx: 0, freqHz: 4000,  q: 1.0,   slopeIdx: 2, on: true  },
  { typeIdx: 0, freqHz: 8000,  q: 1.0,   slopeIdx: 2, on: true  },
  // idx 9: HighShelf
  { typeIdx: 2, freqHz: 12000, q: 0.707, slopeIdx: 2, on: true  },
  // idx 10: LPF — default OFF
  { typeIdx: 4, freqHz: 18000, q: 0.707, slopeIdx: 2, on: false },
];

const SLOPE_VALUES = [6, 12, 18, 24, 36, 48] as const;

function registerDefaults(): void
{
  // --- グローバル ---
  toggleStates.set('BYPASS', new WebToggleState(false));
  sliderStates.set('OUTPUT_GAIN', makeLinearSlider(0.0, -24, 24));
  comboBoxStates.set('ANALYZER_MODE', new WebComboBoxState(3, 4)); // Off / Pre / Post / Pre+Post (default Pre+Post)
  // UI 永続化用 (DAW 側では meta=true / 非 automatable な APVTS bool)。Web デモではただの toggle state。
  toggleStates.set('BOTTOM_PANEL_OPEN', new WebToggleState(true));

  // --- 11 バンドぶんの state 登録 ---
  for (let i = 0; i < BAND_DEFAULTS.length; i++)
  {
    const d = BAND_DEFAULTS[i];
    toggleStates  .set(`BAND${i}_ON`,   new WebToggleState(d.on));
    comboBoxStates.set(`BAND${i}_TYPE`, new WebComboBoxState(d.typeIdx, 6));
    sliderStates  .set(`BAND${i}_FREQ`, makeLinearSlider(d.freqHz, 20, 20000));
    sliderStates  .set(`BAND${i}_GAIN`, makeLinearSlider(0.0,      -32, 32));
    sliderStates  .set(`BAND${i}_Q`,    makeLinearSlider(d.q,      0.1, 18));
    comboBoxStates.set(`BAND${i}_SLOPE`, new WebComboBoxState(d.slopeIdx, 6));
  }

  // --- 値変化 → WASM エンジンへ直送 ---
  toggleStates.get('BYPASS')!.valueChangedEvent.addListener(() => {
    webAudioEngine.setBypass(toggleStates.get('BYPASS')!.getValue());
  });
  sliderStates.get('OUTPUT_GAIN')!.valueChangedEvent.addListener(() => {
    webAudioEngine.setOutputGainDb(sliderStates.get('OUTPUT_GAIN')!.getScaledValue());
  });
  comboBoxStates.get('ANALYZER_MODE')!.valueChangedEvent.addListener(() => {
    webAudioEngine.setAnalyzerMode(comboBoxStates.get('ANALYZER_MODE')!.getChoiceIndex());
  });

  for (let i = 0; i < BAND_DEFAULTS.length; i++)
  {
    const idx = i;
    toggleStates.get(`BAND${idx}_ON`)!.valueChangedEvent.addListener(() => {
      webAudioEngine.setBandOn(idx, toggleStates.get(`BAND${idx}_ON`)!.getValue());
    });
    comboBoxStates.get(`BAND${idx}_TYPE`)!.valueChangedEvent.addListener(() => {
      webAudioEngine.setBandType(idx, comboBoxStates.get(`BAND${idx}_TYPE`)!.getChoiceIndex());
    });
    sliderStates.get(`BAND${idx}_FREQ`)!.valueChangedEvent.addListener(() => {
      webAudioEngine.setBandFreq(idx, sliderStates.get(`BAND${idx}_FREQ`)!.getScaledValue());
    });
    sliderStates.get(`BAND${idx}_GAIN`)!.valueChangedEvent.addListener(() => {
      webAudioEngine.setBandGain(idx, sliderStates.get(`BAND${idx}_GAIN`)!.getScaledValue());
    });
    sliderStates.get(`BAND${idx}_Q`)!.valueChangedEvent.addListener(() => {
      webAudioEngine.setBandQ(idx, sliderStates.get(`BAND${idx}_Q`)!.getScaledValue());
    });
    comboBoxStates.get(`BAND${idx}_SLOPE`)!.valueChangedEvent.addListener(() => {
      const slopeIdx = comboBoxStates.get(`BAND${idx}_SLOPE`)!.getChoiceIndex();
      const slopeDb = SLOPE_VALUES[Math.max(0, Math.min(SLOPE_VALUES.length - 1, slopeIdx))];
      webAudioEngine.setBandSlope(idx, slopeDb);
    });
  }

  // --- 初期値を WASM にプッシュ（WASM 未初期化時は worklet 側で postMessage が早期 return する）---
  webAudioEngine.setBypass(toggleStates.get('BYPASS')!.getValue());
  webAudioEngine.setOutputGainDb(sliderStates.get('OUTPUT_GAIN')!.getScaledValue());
  webAudioEngine.setAnalyzerMode(comboBoxStates.get('ANALYZER_MODE')!.getChoiceIndex());
  for (let i = 0; i < BAND_DEFAULTS.length; i++)
  {
    const idx = i;
    webAudioEngine.setBandOn   (idx, toggleStates.get(`BAND${idx}_ON`)!.getValue());
    webAudioEngine.setBandType (idx, comboBoxStates.get(`BAND${idx}_TYPE`)!.getChoiceIndex());
    webAudioEngine.setBandFreq (idx, sliderStates.get(`BAND${idx}_FREQ`)!.getScaledValue());
    webAudioEngine.setBandGain (idx, sliderStates.get(`BAND${idx}_GAIN`)!.getScaledValue());
    webAudioEngine.setBandQ    (idx, sliderStates.get(`BAND${idx}_Q`)!.getScaledValue());
    const slopeIdx = comboBoxStates.get(`BAND${idx}_SLOPE`)!.getChoiceIndex();
    const slopeDb = SLOPE_VALUES[Math.max(0, Math.min(SLOPE_VALUES.length - 1, slopeIdx))];
    webAudioEngine.setBandSlope(idx, slopeDb);
  }
}

registerDefaults();

// ---------- juce-framework-frontend-mirror 互換 API ----------

export function getSliderState(id: string): WebSliderState | null
{
  return sliderStates.get(id) ?? null;
}

export function getToggleState(id: string): WebToggleState | null
{
  return toggleStates.get(id) ?? null;
}

export function getComboBoxState(id: string): WebComboBoxState | null
{
  return comboBoxStates.get(id) ?? null;
}

export function getNativeFunction(
  _name: string,
): ((...args: unknown[]) => Promise<unknown>) | null
{
  return null;
}
