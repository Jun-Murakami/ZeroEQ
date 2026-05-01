// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
// 11 バンド固定配置。左→右 = 低→高周波で視覚的に並べる。
//   [HPF, HPF, LowShelf, Bell×6, HighShelf, LPF]
//
//  色はユーザー要望のカラーパレット（低 = 暖色、中 = 緑～青、高 = 紫～ピンク）。
//  freq の初期値は対数で分散。HP/LP は Q の代わりに "slope" (12 / 24 dB/oct) を持つ。

export const BAND_COUNT = 11;

export type BandType = 'HighPass' | 'LowShelf' | 'Bell' | 'HighShelf' | 'LowPass';

// HP/LP のスロープ（dB/oct）。6/12/18/24/36/48 の 6 択。
//   APVTS では choice index (0..5) で保存。
export const SLOPE_VALUES_DB = [6, 12, 18, 24, 36, 48] as const;
export type SlopeDbPerOct = typeof SLOPE_VALUES_DB[number];

export const slopeIdxToDb = (idx: number): SlopeDbPerOct =>
  SLOPE_VALUES_DB[Math.max(0, Math.min(SLOPE_VALUES_DB.length - 1, idx))];
export const slopeDbToIdx = (db: number): number =>
  Math.max(0, SLOPE_VALUES_DB.indexOf(db as SlopeDbPerOct));

export interface BandDef {
  index: number;
  type: BandType;
  color: string;
  defaultHz: number;
  defaultGainDb: number;  // Bell/Shelf: 直接ゲイン / HP/LP: ピーク高さ（Q に換算）
  defaultQ: number;       // Bell/Shelf のみ有効。HP/LP では BAND_Q は使わない
  defaultSlopeDb: SlopeDbPerOct; // HP/LP の slope（他タイプでは未使用）
  defaultOn: boolean;     // 既定 ON/OFF。HP/LP は OFF、それ以外は ON。
  isSlopeType: boolean;   // HP/LP 識別フラグ。slope セレクタ + Gain→ピーク動作に分岐。
}

export const BANDS: BandDef[] = [
  { index: 0,  type: 'HighPass',  color: '#B22A5A', defaultHz: 30,    defaultGainDb: 0, defaultQ: 0.707, defaultSlopeDb: 18, defaultOn: false, isSlopeType: true  },
  { index: 1,  type: 'HighPass',  color: '#C42D2B', defaultHz: 60,    defaultGainDb: 0, defaultQ: 0.707, defaultSlopeDb: 18, defaultOn: false, isSlopeType: true  },
  { index: 2,  type: 'LowShelf',  color: '#E07A1F', defaultHz: 120,   defaultGainDb: 0, defaultQ: 0.707, defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 3,  type: 'Bell',      color: '#E8C62A', defaultHz: 250,   defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 4,  type: 'Bell',      color: '#98C43A', defaultHz: 500,   defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 5,  type: 'Bell',      color: '#4CA341', defaultHz: 1000,  defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 6,  type: 'Bell',      color: '#5BB2E3', defaultHz: 2000,  defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 7,  type: 'Bell',      color: '#1C52E6', defaultHz: 4000,  defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 8,  type: 'Bell',      color: '#3F2FB3', defaultHz: 8000,  defaultGainDb: 0, defaultQ: 1.0,   defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 9,  type: 'HighShelf', color: '#9C4A9C', defaultHz: 12000, defaultGainDb: 0, defaultQ: 0.707, defaultSlopeDb: 18, defaultOn: true,  isSlopeType: false },
  { index: 10, type: 'LowPass',   color: '#D0478F', defaultHz: 18000, defaultGainDb: 0, defaultQ: 0.707, defaultSlopeDb: 18, defaultOn: false, isSlopeType: true  },
];

// HP/LP の gain knob 値 → Butterworth Q に掛ける resonance scale。
//   gainDb =  0 → scale = 1    (pure Butterworth = maximally flat, ピーク無し)
//   gainDb >  0 → scale > 1    (各段 Q が拡大して共振増加)
//   gainDb <  0 → scale < 1    (各段 Q が縮小してよりなだらか)
// 全段に共通のスケールを掛ける multiplicative 方式。段間の Q 比を保つので、
// 共振を増やしても次数本来の形は崩れにくい。
export const resonanceScaleFromGainDb = (gainDb: number): number =>
  Math.pow(10, gainDb / 20);

// slope(dB/oct) → Butterworth フィルタ次数
export const slopeToOrder = (slopeDb: number): number => {
  switch (slopeDb) {
    case 6:  return 1;
    case 12: return 2;
    case 18: return 3;
    case 24: return 4;
    case 36: return 6;
    case 48: return 8;
    default: return 2;
  }
};

// n 次 Butterworth を pairs = ⌊n/2⌋ 段の biquad に分解した各段の Q 値。
//   式: Q_k = 1 / (2·sin((2k-1)π/(2n)))，k = 1..pairs
//   例: n=2 → [0.7071], n=4 → [1.3066, 0.5412], n=8 → [2.5629, 0.9000, 0.6013, 0.5098]
//   奇数 n では 1 段の 1st-order が別途追加される (本ファイルでは返さない)。
//   全段をカスケードするとちょうど n 次の Butterworth (maximally flat) になる。
export const butterworthBiquadQs = (order: number): readonly number[] => {
  const pairs = Math.floor(order / 2);
  const qs: number[] = [];
  for (let k = 1; k <= pairs; k++) {
    qs.push(1 / (2 * Math.sin(((2 * k - 1) * Math.PI) / (2 * order))));
  }
  return qs;
};

// slope(dB/oct) → 各 biquad 段の Butterworth Q 配列 + 1st-order 有無。
//   6 → [],                 1st ✓
//  12 → [0.7071],            1st ✗
//  18 → [1.0],               1st ✓
//  24 → [1.307, 0.541],      1st ✗
//  36 → [1.932, 0.707, 0.518], 1st ✗
//  48 → [2.563, 0.900, 0.601, 0.510], 1st ✗
export interface SlopeStages { biquadQs: readonly number[]; has1stOrder: boolean; }
export const slopeStagesFor = (slopeDb: number): SlopeStages => {
  const order = slopeToOrder(slopeDb);
  return { biquadQs: butterworthBiquadQs(order), has1stOrder: (order % 2) === 1 };
};
