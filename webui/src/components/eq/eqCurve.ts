// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
// ============================================================================
// EQ カーブ合成（純関数・単体テスト可能）
//
// JUCE::dsp::IIR::Coefficients と同じ RBJ クックブック式を使い、各バンドの
// マグニチュード応答を計算 → dB で合算。
//
// HP/LP については slope (dB/oct) に応じて biquad + 1st-order をカスケードする:
//    6  → 0 biquad + 1 first-order
//    12 → 1 biquad
//    18 → 1 biquad + 1 first-order
//    24 → 2 biquad
//    36 → 3 biquad
//    48 → 4 biquad
// また HP/LP の Q は gainDb から導出される（= 10^(gainDb/20)）。
// ============================================================================

import type { BandType } from './BandDefs';
import { resonanceScaleFromGainDb, slopeStagesFor } from './BandDefs';

export interface BandCurveState {
  on: boolean;
  type: BandType;
  freqHz: number;
  gainDb: number;
  q: number;
  slopeDbPerOct?: number; // HP/LP でのみ参照。未指定なら 12 相当。
}

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a0: number; a1: number; a2: number;
}

// ----------------------------------------------------------------------------
// RBJ biquad 係数（Bell / Shelf / Notch / HP / LP 共通）
// ----------------------------------------------------------------------------
export function coeffsFor(band: BandCurveState, sampleRate: number): BiquadCoeffs {
  const f0 = Math.max(10, Math.min(sampleRate * 0.49, band.freqHz));
  const Q  = Math.max(0.1, band.q);
  const A  = Math.pow(10, band.gainDb / 40);

  const w0    = (2 * Math.PI * f0) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  switch (band.type) {
    case 'Bell':
      return {
        b0: 1 + alpha * A, b1: -2 * cosw0, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cosw0, a2: 1 - alpha / A,
      };
    case 'LowShelf': {
      const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * ((A + 1) - (A - 1) * cosw0 + sqrtA2alpha),
        b1: 2 * A * ((A - 1) - (A + 1) * cosw0),
        b2: A * ((A + 1) - (A - 1) * cosw0 - sqrtA2alpha),
        a0: (A + 1) + (A - 1) * cosw0 + sqrtA2alpha,
        a1: -2 * ((A - 1) + (A + 1) * cosw0),
        a2: (A + 1) + (A - 1) * cosw0 - sqrtA2alpha,
      };
    }
    case 'HighShelf': {
      const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * ((A + 1) + (A - 1) * cosw0 + sqrtA2alpha),
        b1: -2 * A * ((A - 1) + (A + 1) * cosw0),
        b2: A * ((A + 1) + (A - 1) * cosw0 - sqrtA2alpha),
        a0: (A + 1) - (A - 1) * cosw0 + sqrtA2alpha,
        a1: 2 * ((A - 1) - (A + 1) * cosw0),
        a2: (A + 1) - (A - 1) * cosw0 - sqrtA2alpha,
      };
    }
    case 'HighPass':
      return {
        b0: (1 + cosw0) / 2, b1: -(1 + cosw0), b2: (1 + cosw0) / 2,
        a0: 1 + alpha,       a1: -2 * cosw0,    a2: 1 - alpha,
      };
    case 'LowPass':
      return {
        b0: (1 - cosw0) / 2, b1: 1 - cosw0, b2: (1 - cosw0) / 2,
        a0: 1 + alpha,       a1: -2 * cosw0, a2: 1 - alpha,
      };
  }
}

// ----------------------------------------------------------------------------
// 1st-order HP/LP（bilinear transform 由来の biquad 形式で b2=a2=0）
// ----------------------------------------------------------------------------
function firstOrderCoeffs(type: 'HighPass' | 'LowPass', freqHz: number, sampleRate: number): BiquadCoeffs {
  const f = Math.max(10, Math.min(sampleRate * 0.49, freqHz));
  const K = Math.tan((Math.PI * f) / sampleRate);
  const a1 = (K - 1) / (K + 1);

  if (type === 'LowPass') {
    const factor = K / (K + 1);
    return { b0: factor, b1: factor, b2: 0, a0: 1, a1, a2: 0 };
  }
  const factor = 1 / (K + 1);
  return { b0: factor, b1: -factor, b2: 0, a0: 1, a1, a2: 0 };
}

// ----------------------------------------------------------------------------
// 1 biquad の dB マグニチュード応答を周波数 f で評価。
// ----------------------------------------------------------------------------
export function magnitudeDb(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const bRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const bIm = -c.b1 * sin1 - c.b2 * sin2;
  const bMag2 = bRe * bRe + bIm * bIm;

  const aRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
  const aIm = -c.a1 * sin1 - c.a2 * sin2;
  const aMag2 = aRe * aRe + aIm * aIm;

  if (aMag2 < 1e-30) return -120;
  return 10 * Math.log10(bMag2 / aMag2);
}

// ----------------------------------------------------------------------------
// 1 バンドを何段のフィルタに分解するか。
//   - Bell/Shelf/Notch: 1 biquad
//   - HP/LP: slope に応じて biquad ×N + 1st-order ×0〜1
// ----------------------------------------------------------------------------
function buildStagesFor(band: BandCurveState, sampleRate: number): BiquadCoeffs[] {
  if (band.type === 'Bell' || band.type === 'LowShelf' || band.type === 'HighShelf') {
    return [coeffsFor(band, sampleRate)];
  }
  // HighPass / LowPass
  //  各 biquad 段に Butterworth の段別 Q を割り当て (= gainDb=0 で maximally flat)。
  //  ユーザの gainDb は各段 Q の乗算係数として機能し、0 dB 基準で上下に共振を増減する。
  const slope = band.slopeDbPerOct ?? 12;
  const { biquadQs, has1stOrder } = slopeStagesFor(slope);
  const scale = resonanceScaleFromGainDb(band.gainDb);

  const stages: BiquadCoeffs[] = [];
  for (const q of biquadQs) {
    const stageQ = Math.max(0.1, Math.min(18, q * scale));
    stages.push(coeffsFor({ ...band, q: stageQ }, sampleRate));
  }
  if (has1stOrder) {
    stages.push(firstOrderCoeffs(band.type, band.freqHz, sampleRate));
  }
  return stages;
}

// ----------------------------------------------------------------------------
// 1 バンド単体の dB 応答（他バンドを含めない）。ノード色のフィル描画で使う。
// ----------------------------------------------------------------------------
export function sampleSingleBandDb(
  band: BandCurveState,
  freqAxis: number[],
  sampleRate: number,
): Float32Array {
  const out = new Float32Array(freqAxis.length);
  if (!band.on) return out; // 全て 0（描画側で「0 dB 基準線」扱い = 非表示相当）
  const stages = buildStagesFor(band, sampleRate);
  for (let i = 0; i < freqAxis.length; i++) {
    let sum = 0;
    for (const c of stages) sum += magnitudeDb(c, freqAxis[i], sampleRate);
    out[i] = sum;
  }
  return out;
}

// ----------------------------------------------------------------------------
// 全バンドを合成した dB 応答。カスケードは積 = dB 和。
// ----------------------------------------------------------------------------
export function sampleCurveDb(
  bands: BandCurveState[],
  freqAxis: number[],
  sampleRate: number,
): Float32Array {
  // 各バンドの stage 集合を 1 度だけ計算して再利用
  const allStages: BiquadCoeffs[] = [];
  for (const band of bands) {
    if (!band.on) continue;
    const stages = buildStagesFor(band, sampleRate);
    for (const st of stages) allStages.push(st);
  }

  const out = new Float32Array(freqAxis.length);
  for (let i = 0; i < freqAxis.length; i++) {
    const f = freqAxis[i];
    let sum = 0;
    for (const c of allStages) {
      sum += magnitudeDb(c, f, sampleRate);
    }
    out[i] = sum;
  }
  return out;
}
