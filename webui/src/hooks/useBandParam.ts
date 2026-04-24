import { useJuceSliderValue, useJuceToggleValue, useJuceComboBoxIndex } from './useJuceParam';
import { usePreviewBool, usePreviewNumber } from './previewParamStore';
import { BANDS, SLOPE_VALUES_DB, slopeIdxToDb, slopeDbToIdx, type SlopeDbPerOct } from '../components/eq/BandDefs';

// ============================================================================
// バンド単位の APVTS 購読フック群。
//
// DAW ロード時 (BACKEND_LIVE=true):
//   juce-framework-frontend-mirror にそのまま委譲。mirror は param ID ごとに
//   singleton を返すため、複数の hook 呼び出しは自動で同じ state を共有する。
//
// ブラウザプレビュー時 (BACKEND_LIVE=false):
//   previewParamStore（module-level Map）を共有ストアとして利用。BandDefs の
//   静的デフォルトで初期化し、drag / wheel / クリックで値が変わる様子を再現できる。
//   複数コンポーネントから同じ ID にアクセスしても store 経由で同期する。
// ============================================================================

// "live backend" 判定:
//  - Web デモモード (VITE_RUNTIME=web): Vite エイリアスで juce-shim が resolve され、
//    shim が自前で state を持ちつつ WebAudioEngine → WASM に転送する → live 扱い。
//  - DAW モード: JUCE の WebBrowserComponent が __JUCE__.initialisationData を注入し、
//    __juce__sliders 配列が非空なら live。
const hasLiveBackend = (): boolean => {
  if (import.meta.env.VITE_RUNTIME === 'web') return true;
  const init = typeof window !== 'undefined' ? window.__JUCE__?.initialisationData : undefined;
  const sliders = (init as Record<string, unknown> | undefined)?.['__juce__sliders'];
  return Array.isArray(sliders) && sliders.length > 0;
};
const BACKEND_LIVE = hasLiveBackend();

const PARAM_RANGES = {
  freq: { min: 20, max: 20000 },
  gain: { min: -32, max: 32 },
  q:    { min: 0.1, max: 18 },
} as const;

const idOf = {
  on:    (i: number) => `BAND${i}_ON`,
  freq:  (i: number) => `BAND${i}_FREQ`,
  gain:  (i: number) => `BAND${i}_GAIN`,
  q:     (i: number) => `BAND${i}_Q`,
  type:  (i: number) => `BAND${i}_TYPE`,
  slope: (i: number) => `BAND${i}_SLOPE`,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ----------------------------------------------------------------------------
// on/off
//  既定値は BandDefs.defaultOn（HP/LP は false、それ以外は true）。DAW 側も preview
//  側も同じ値を参照する。
// ----------------------------------------------------------------------------
export function useBandOn(bandIdx: number): { on: boolean; setOn: (v: boolean) => void } {
  const defaultOn = BANDS[bandIdx]?.defaultOn ?? false;
  const { value, setValue } = useJuceToggleValue(idOf.on(bandIdx), defaultOn);
  const [preview, setPreviewV] = usePreviewBool(idOf.on(bandIdx), defaultOn);

  if (BACKEND_LIVE) return { on: value, setOn: setValue };
  return { on: preview, setOn: setPreviewV };
}

// ----------------------------------------------------------------------------
// Freq (Hz), log skew 20..20000
// ----------------------------------------------------------------------------
export function useBandFreq(bandIdx: number): { freqHz: number; setFreqHz: (hz: number) => void } {
  const { value, setScaled } = useJuceSliderValue(idOf.freq(bandIdx));
  const fallback = BANDS[bandIdx]?.defaultHz ?? 1000;
  const [preview, setPreviewV] = usePreviewNumber(idOf.freq(bandIdx), fallback);
  const { min, max } = PARAM_RANGES.freq;

  if (BACKEND_LIVE) {
    return { freqHz: value, setFreqHz: (hz) => setScaled(hz, min, max) };
  }
  return {
    freqHz: preview,
    setFreqHz: (hz) => setPreviewV(clamp(hz, min, max)),
  };
}

// ----------------------------------------------------------------------------
// Gain (dB), linear -32..+32
// ----------------------------------------------------------------------------
export function useBandGain(bandIdx: number): { gainDb: number; setGainDb: (db: number) => void } {
  const { value, setScaled } = useJuceSliderValue(idOf.gain(bandIdx));
  const [preview, setPreviewV] = usePreviewNumber(idOf.gain(bandIdx), 0);
  const { min, max } = PARAM_RANGES.gain;

  if (BACKEND_LIVE) {
    return { gainDb: value, setGainDb: (db) => setScaled(db, min, max) };
  }
  return {
    gainDb: preview,
    setGainDb: (db) => setPreviewV(clamp(db, min, max)),
  };
}

// ----------------------------------------------------------------------------
// Q, log skew 0.1..18
// ----------------------------------------------------------------------------
export function useBandQ(bandIdx: number): { q: number; setQ: (q: number) => void } {
  const { value, setScaled } = useJuceSliderValue(idOf.q(bandIdx));
  const fallback = BANDS[bandIdx]?.defaultQ ?? 1.0;
  const [preview, setPreviewV] = usePreviewNumber(idOf.q(bandIdx), fallback);
  const { min, max } = PARAM_RANGES.q;

  if (BACKEND_LIVE) {
    return { q: value, setQ: (q) => setScaled(q, min, max) };
  }
  return {
    q: preview,
    setQ: (q) => setPreviewV(clamp(q, min, max)),
  };
}

// ----------------------------------------------------------------------------
// Type — 固定レイアウト前提で UI からは通常触らない。APVTS の状態保存用。
// ----------------------------------------------------------------------------
export function useBandType(bandIdx: number): { typeIdx: number; setTypeIdx: (i: number) => void } {
  const { index, setIndex } = useJuceComboBoxIndex(idOf.type(bandIdx));
  return { typeIdx: index, setTypeIdx: setIndex };
}

// ----------------------------------------------------------------------------
// Slope — choice 0..5 = 6/12/18/24/36/48 dB/oct。HP/LP のみ意味を持つ。
// ----------------------------------------------------------------------------
export function useBandSlope(bandIdx: number): { slopeDb: SlopeDbPerOct; setSlopeDb: (db: SlopeDbPerOct) => void } {
  const defaultDb = BANDS[bandIdx]?.defaultSlopeDb ?? 12;
  const { index, setIndex } = useJuceComboBoxIndex(idOf.slope(bandIdx));
  const [preview, setPreviewV] = usePreviewNumber(idOf.slope(bandIdx), slopeDbToIdx(defaultDb));

  const idx = BACKEND_LIVE ? index : preview;
  const db = slopeIdxToDb(Math.round(idx));
  const setter = (db2: SlopeDbPerOct) => {
    const newIdx = slopeDbToIdx(db2);
    if (BACKEND_LIVE) setIndex(newIdx);
    else setPreviewV(newIdx);
  };
  // SLOPE_VALUES_DB は定数なので型を絞る
  void SLOPE_VALUES_DB;
  return { slopeDb: db, setSlopeDb: setter };
}

// ----------------------------------------------------------------------------
// 1 バンドの全状態をまとめて取得
// ----------------------------------------------------------------------------
export function useBandState(bandIdx: number) {
  const { on, setOn } = useBandOn(bandIdx);
  const { freqHz, setFreqHz } = useBandFreq(bandIdx);
  const { gainDb, setGainDb } = useBandGain(bandIdx);
  const { q, setQ } = useBandQ(bandIdx);
  const { slopeDb, setSlopeDb } = useBandSlope(bandIdx);
  return { on, setOn, freqHz, setFreqHz, gainDb, setGainDb, q, setQ, slopeDb, setSlopeDb };
}

// ----------------------------------------------------------------------------
// 全 11 バンドの状態配列。
//  Rules of Hooks を満たすため 11 回のハードコード呼び出し。
// ----------------------------------------------------------------------------
export function useAllBandStates() {
  const b0  = useBandState(0);
  const b1  = useBandState(1);
  const b2  = useBandState(2);
  const b3  = useBandState(3);
  const b4  = useBandState(4);
  const b5  = useBandState(5);
  const b6  = useBandState(6);
  const b7  = useBandState(7);
  const b8  = useBandState(8);
  const b9  = useBandState(9);
  const b10 = useBandState(10);
  return [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10];
}
