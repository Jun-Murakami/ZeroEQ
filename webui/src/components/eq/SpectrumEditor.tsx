// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BANDS, SLOPE_VALUES_DB, slopeDbToIdx, slopeIdxToDb, type SlopeDbPerOct } from './BandDefs';
import { sampleCurveDb, sampleSingleBandDb, type BandCurveState } from './eqCurve';
import { formatHz, formatGain, formatQ } from './InlineNumberInput';
import { juceBridge } from '../../bridge/juce';
import type { SpectrumUpdateData } from '../../types';
import { useJuceComboBoxIndex } from '../../hooks/useJuceParam';
import { useHoveredBandFromKnob } from '../../hooks/hoveredBandStore';

// ============================================================================
// スペアナ + EQ エディタ
//  - 背景グリッド（周波数 / dB）
//  - Pre / Post スペクトラム（Pre 青、Post 黄）
//  - 合成 EQ カーブ（白線、全 ON バンドのマグニチュード応答を dB 合成）
//  - バンドノード（各バンドの (freqHz, gainDb) に配置、色はバンド固有）
//  - ポインタ操作:
//      drag                → freq (X) / gain (Y)。HP/LP は Y ロック。
//      wheel on hover/drag → Q (log 増減)
//      修飾キー (Ctrl/Cmd/Shift) → fine adjust (0.2x)
// ============================================================================

// 独立 Y 軸:
//   EQ 編集域（ノード / カーブ）: ±eqDbMax が高さいっぱい、0 dB が中央
//   スペクトラム: -90 .. 0 dB が高さいっぱい、0 dB が上端
//  つまり同じ Y 位置でも EQ と spectrum の示す dB は一致しない。
const SPEC_DB_MIN = -90;

const HZ_MIN = 20;
const HZ_MAX = 22000;

const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS: Record<number, string> = {
  20: '20', 50: '50', 100: '100', 200: '200', 500: '500',
  1000: '1k', 2000: '2k', 5000: '5k', 10000: '10k', 20000: '20k',
};

const CURVE_SAMPLES = 512;
const HIT_RADIUS_PX = 14;

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// hex '#RRGGBB' を amount だけ暗くして返す（0..1）。alpha 連結用に末尾 'HH' は付けない。
function darkerHex(hex: string, amount: number): string {
  const f = Math.max(0, 1 - amount);
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * f);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * f);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * f);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ---------- 座標変換 ----------
const hzToX = (hz: number, w: number) => {
  const t = Math.log(hz / HZ_MIN) / Math.log(HZ_MAX / HZ_MIN);
  return clampN(t, 0, 1) * w;
};
const xToHz = (x: number, w: number) => {
  const t = clampN(x / w, 0, 1);
  return HZ_MIN * Math.pow(HZ_MAX / HZ_MIN, t);
};

// EQ 軸: ±eqDbMax を高さいっぱい、0 dB 中央
const makeEqDbToY = (eqDbMax: number) => (db: number, h: number) => {
  const c = clampN(db, -eqDbMax, eqDbMax);
  return (h * (eqDbMax - c)) / (eqDbMax * 2);
};
const makeYToEqDb = (eqDbMax: number) => (y: number, h: number) => {
  const t = clampN(y / h, 0, 1);
  return eqDbMax - 2 * eqDbMax * t;
};

// スペクトラム軸: 0 dB 上端、-90 dB 下端
const specDbToY = (db: number, h: number) => {
  const c = clampN(db, SPEC_DB_MIN, 0);
  return (h * -c) / -SPEC_DB_MIN;
};

// ---------- インタフェース ----------
export interface BandInteractive {
  on: boolean;
  freqHz: number;
  gainDb: number;
  q: number;
  slopeDb: number;       // HP/LP のみ参照される
  setOn: (v: boolean) => void;
  setFreqHz: (hz: number) => void;
  setGainDb: (db: number) => void;
  setQ: (q: number) => void;
  setSlopeDb: (db: SlopeDbPerOct) => void;
}

interface Props {
  width: number;
  height: number;
  bands: BandInteractive[];
  sampleRate?: number;
  eqDbMax?: number; // EQ 縦軸スケール（±eqDbMax）。既定 6。
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isFine = (e: PointerEvent | WheelEvent) => e.ctrlKey || e.metaKey || e.shiftKey;

export function SpectrumEditor({ width, height, bands, sampleRate = 48000, eqDbMax = 6 }: Props) {
  const eqDbToY = makeEqDbToY(eqDbMax);

  // スペアナ bins は本コンポーネント内で juceBridge を購読する（親 App に state を持たせると
  // 30Hz の spectrumUpdate 毎に App ツリー全体が再レンダする）。
  //
  // 防御: イベントに含まれる側だけ state を更新する（`undefined` で上書きしない）。
  //  バックエンドで pre/post は別インスタンスで、message thread の timer が audio thread の
  //  pushBlock の Pre/Post 間を横切ると、片方が drain 可能で他方がそうでない瞬間が発生する。
  //  その瞬間 emit される event は片方だけのデータを含む。常に `setXxx(s.xxx)` で書くと
  //  もう片方が `undefined` になり、1 フレームだけ塗り/線が消えてチラつく。
  const [preBins, setPreBins] = useState<number[] | undefined>(undefined);
  const [postBins, setPostBins] = useState<number[] | undefined>(undefined);
  useEffect(() => {
    const id = juceBridge.addEventListener('spectrumUpdate', (d: unknown) => {
      const s = d as SpectrumUpdateData;
      if (s.pre)  setPreBins(s.pre);
      if (s.post) setPostBins(s.post);
    });
    return () => juceBridge.removeEventListener(id);
  }, []);

  // ANALYZER_MODE: 0=Off / 1=Pre / 2=Post / 3=Pre+Post。0 の時はスペクトラムの塗り/線を描かない。
  const { index: analyzerMode } = useJuceComboBoxIndex('ANALYZER_MODE');
  const showPre  = analyzerMode === 1 || analyzerMode === 3;
  const showPost = analyzerMode === 2 || analyzerMode === 3;

  // mount-once の useEffect で setup されるポインタハンドラから最新 eqDbMax を参照するための ref。
  // ref を経由しないと、ハンドラは mount 時の eqDbMax を恒久的にキャプチャしてしまい、
  // スケール切替後のヒットテスト / ドラッグ値計算が視覚位置とズレる（＝ノードに当たらなくなる）。
  const eqDbMaxRef = useRef(eqDbMax);
  eqDbMaxRef.current = eqDbMax;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  // BandControlColumn 側 (knob 列の hover) からの強調指示。
  //  キャンバス上の hover とは独立で、両方が立つこともある。描画では highlight 扱いに統一する。
  const knobHoveredIdx = useHoveredBandFromKnob();

  // 最新値を保持する ref（mount-once useEffect 内のイベントハンドラから参照するため）
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  // drag 開始時のアンカー（fine adjust と freq/gain の相対計算に使う）
  const anchorRef = useRef<{
    idx: number;
    startX: number;
    startY: number;
    startFreq: number;
    startGain: number;
  } | null>(null);

  // hovered state を ref でも保持（mount-once useEffect 内のイベントハンドラから最新値を読む）
  const hoveredRef = useRef<number | null>(null);
  hoveredRef.current = hoveredIdx;

  // ---- 曲線サンプリング用の周波数軸（log 等分、再レンダで固定）----
  const freqAxis = useMemo(() => {
    const arr: number[] = new Array(CURVE_SAMPLES);
    const logMin = Math.log(HZ_MIN);
    const logMax = Math.log(HZ_MAX);
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      arr[i] = Math.exp(logMin + ((logMax - logMin) * i) / (CURVE_SAMPLES - 1));
    }
    return arr;
  }, []);

  // ---- 描画 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = '#15181b';
    ctx.fillRect(0, 0, width, height);

    // EQ 軸の dB グリッド。±eqDbMax を 4 分割した位置にラインを引く（0 中央除く 8 本）。
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    {
      const step = eqDbMax / 4;
      for (const n of [-4, -3, -2, -1, 1, 2, 3, 4]) {
        const y = eqDbToY(n * step, height);
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
    }
    ctx.stroke();

    // 0 dB (EQ 中央) 強調
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, eqDbToY(0, height));
    ctx.lineTo(width, eqDbToY(0, height));
    ctx.stroke();

    // 周波数グリッド + ラベル
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '12px "Red Hat Mono", monospace';
    ctx.textBaseline = 'bottom';
    for (const hz of FREQ_GRID) {
      const x = hzToX(hz, width);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height - 16);
      ctx.stroke();
      // 端のラベルはキャンバス内に収まるようアラインを切り替える
      if (hz === FREQ_GRID[0]) {
        ctx.textAlign = 'left';
        ctx.fillText(FREQ_LABELS[hz], 2, height - 2);
      } else if (hz === FREQ_GRID[FREQ_GRID.length - 1]) {
        ctx.textAlign = 'right';
        ctx.fillText(FREQ_LABELS[hz], width - 2, height - 2);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(FREQ_LABELS[hz], x, height - 2);
      }
    }

    // EQ dB ラベル（左端）。+eqDbMax / +eqDbMax/2 / 0 / -eqDbMax/2 の 4 ラベル。
    //  上端は textBaseline:top でキャンバス内に押し込み、それ以外は中央揃え。
    //  -eqDbMax は省略（下部に -半分が出ていれば読めるし、下端は freq ラベルと干渉するため）。
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'left';
    const fmtEqLabel = (db: number) => {
      const s = Number.isInteger(db) ? `${db}` : db.toFixed(1);
      return db > 0 ? `+${s}` : s;
    };
    const labelValues: Array<{ db: number; baseline: CanvasTextBaseline; y: number }> = [
      { db: eqDbMax,     baseline: 'top',    y: 2 },
      { db: eqDbMax / 2, baseline: 'middle', y: eqDbToY(eqDbMax / 2, height) },
      { db: 0,           baseline: 'middle', y: eqDbToY(0, height) },
      { db: -eqDbMax / 2,baseline: 'middle', y: eqDbToY(-eqDbMax / 2, height) },
    ];
    for (const { db, baseline, y } of labelValues) {
      ctx.textBaseline = baseline;
      ctx.fillText(fmtEqLabel(db), 2, y);
    }

    // スペクトラム（独立 Y 軸: 0..-90 dB が canvas 全高）
    //  Pre / Post を同色・半透明で重ねる。overlap 領域（両方がカバー）は alpha 合成で自然に濃くなり、
    //  差分領域（片方のみ）は薄く残る。結果、EQ 前後の差が視覚的に読める。
    //  アウトラインは Post（最終出力）のみ描画して形を強調。
    //  色はテーマ primary（#4fc3f7）を薄めたもの。fill は上→下で不透明度が上がる縦グラデーション。
    const specGrad = ctx.createLinearGradient(0, 0, 0, height);
    specGrad.addColorStop(0, 'rgba(79,195,247,0.28)'); // 上端は濃いめ
    specGrad.addColorStop(1, 'rgba(79,195,247,0.02)'); // 下端はほぼ透明
    const SPEC_OUTLINE = 'rgba(79,195,247,0.45)';

    const drawSpectrumFill = (bins: number[]) => {
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * width;
        const y = specDbToY(bins[i] ?? SPEC_DB_MIN, height);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = specGrad;
      ctx.fill();
    };
    // スペクトラムのアウトラインは底値 (SPEC_DB_MIN) に張り付く区間を途切れさせて、
    // 無音域に水平線が残らないようにする。ただし床へ落ちる直前の 1 点まで伸ばし、
    // 床から立ち上がる直前の床点からスタートする — こうしないと下降途中や立ち上がり
    // 途中で線が唐突に切れてしまう。
    const drawSpectrumOutline = (bins: number[]) => {
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < bins.length; i++) {
        const v = bins[i] ?? SPEC_DB_MIN;
        const atFloor = v <= SPEC_DB_MIN;
        const x = (i / (bins.length - 1)) * width;
        const y = specDbToY(v, height);
        if (atFloor) {
          if (penDown) {
            // 下降して床へ到達する最後の 1 点を描いて pen-up。
            ctx.lineTo(x, y);
            penDown = false;
          }
        } else {
          if (!penDown) {
            // 床から立ち上がる場合、1 つ前の床位置から開始して尾を残す。
            if (i > 0) {
              const prevX = ((i - 1) / (bins.length - 1)) * width;
              ctx.moveTo(prevX, height);
              ctx.lineTo(x, y);
            } else {
              ctx.moveTo(x, y);
            }
            penDown = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.strokeStyle = SPEC_OUTLINE;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    };
    if (showPre  && preBins)  drawSpectrumFill(preBins);
    if (showPost && postBins) drawSpectrumFill(postBins);
    if (showPost && postBins) drawSpectrumOutline(postBins);

    // 合成 EQ カーブの計算元になる curveStates
    const curveStates: BandCurveState[] = bands.map((s, i) => ({
      on: s.on,
      type: BANDS[i].type,
      freqHz: s.freqHz,
      gainDb: s.gainDb,
      q: s.q,
      slopeDbPerOct: s.slopeDb,
    }));

    // 各 ON バンドの寄与を薄いカラーフィル + 少し濃い境界線で描画。
    //  HP/LP は cut 側（フィルター外側）に、Bell/Shelf/Notch は peak/dip 周辺に自然に乗る。
    //  塗りはノード色 × alpha ~22%。境界は塗色より少し濃い（不透明度を上げ、RGB も ~25% ダーク化）。
    //
    //  可視範囲 (±eqDbMax) を大きく下回る区間は描画を切る（下端に張り付く線/塗りを残さない）。
    //  可視域内の "visible segments" を列挙し、各セグメント単独で塗り＆線を閉じる。
    const zeroY = eqDbToY(0, height);
    const FLOOR_DB = -eqDbMax;  // これを下回る dB 値は画面外扱い
    const collectSegments = (arr: Float32Array): Array<{ start: number; end: number }> => {
      const segs: Array<{ start: number; end: number }> = [];
      let segStart = -1;
      for (let j = 0; j < arr.length; j++) {
        const v = arr[j];
        const visible = v > FLOOR_DB;
        if (visible && segStart < 0) segStart = j;
        else if (!visible && segStart >= 0) {
          segs.push({ start: segStart, end: j - 1 });
          segStart = -1;
        }
      }
      if (segStart >= 0) segs.push({ start: segStart, end: arr.length - 1 });
      return segs;
    };
    for (let i = 0; i < BANDS.length; i++) {
      const def = BANDS[i];
      const st = curveStates[i];
      if (!st || !st.on) continue;

      const single = sampleSingleBandDb(st, freqAxis, sampleRate);

      // 塗り: 0 dB 基準線とカーブで閉じた全域領域。可視域外は eqDbToY でクランプされ
      // 下端に張り付く形で塗られるが、塗り色は半透明の色付きなので「フィルターが効いている
      // 範囲」の視覚情報として残すのが自然（線とは違い張り付いても視覚的ノイズにならない）。
      ctx.beginPath();
      ctx.moveTo(hzToX(freqAxis[0], width), zeroY);
      for (let j = 0; j < freqAxis.length; j++) {
        ctx.lineTo(hzToX(freqAxis[j], width), eqDbToY(single[j], height));
      }
      ctx.lineTo(hzToX(freqAxis[freqAxis.length - 1], width), zeroY);
      ctx.closePath();
      ctx.fillStyle = def.color + '38'; // ~22% alpha
      ctx.fill();

      // 境界線: 可視域を下回る区間は途切れさせ、底に張り付く水平線を残さない。
      ctx.strokeStyle = darkerHex(def.color, 0.25) + 'CC'; // ~80% alpha
      ctx.lineWidth = 1;
      const segments = collectSegments(single);
      for (const seg of segments) {
        ctx.beginPath();
        for (let j = seg.start; j <= seg.end; j++) {
          const x = hzToX(freqAxis[j], width);
          const y = eqDbToY(single[j], height);
          if (j === seg.start) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // 合成 EQ カーブ（白線）
    //  可視域を下回る点は描画を打ち切り、底に張り付く線を残さない。
    const curveDb = sampleCurveDb(curveStates, freqAxis, sampleRate);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    {
      let penDown = false;
      for (let i = 0; i < freqAxis.length; i++) {
        if (curveDb[i] <= FLOOR_DB) { penDown = false; continue; }
        const x = hzToX(freqAxis[i], width);
        const y = eqDbToY(curveDb[i], height);
        if (!penDown) { ctx.moveTo(x, y); penDown = true; }
        else           { ctx.lineTo(x, y); }
      }
    }
    ctx.stroke();

    // バンドノード
    //  OFF 時でも色を維持し、透明度だけ落とす（色でバンド識別しやすいように）。
    //  active / hover はリングを太くして強調。
    //  knob 列 hover 時は 1.5x に拡大して、操作対象が一目で判るようにする
    //  （キャンバス内 hover と独立して立つので OR で highlight 扱い）。
    const BASE_RADIUS = 7;
    const KNOB_HOVER_RADIUS = 9; // ~1.3x。1.5x は主張が強すぎたので一段控えめに。
    for (let i = 0; i < BANDS.length; i++) {
      const def = BANDS[i];
      const s = bands[i];
      if (!s) continue;
      const x = hzToX(s.freqHz, width);
      const nodeDb = s.gainDb;
      const y = eqDbToY(nodeDb, height);
      const isActive = i === activeIdx;
      const isHover = i === hoveredIdx;
      const isKnobHover = i === knobHoveredIdx;
      // active > knob-hover > canvas-hover > 通常 の優先で半径を決める。
      //  knob-hover が canvas-hover より大きいのは、列ホバーでバンドを特定する用途を強調するため。
      const radius = isActive ? 9 : isKnobHover ? KNOB_HOVER_RADIUS : isHover ? 8 : BASE_RADIUS;

      ctx.save();
      ctx.globalAlpha = s.on ? 1.0 : 0.4;

      // ホバー / ドラッグ中のハロ
      if (isActive || isHover || isKnobHover) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = def.color + '44';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = def.color;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = isActive ? 1.6 : 1;
      ctx.stroke();

      ctx.restore();
    }
  }, [width, height, preBins, postBins, bands, sampleRate, freqAxis, activeIdx, hoveredIdx, knobHoveredIdx, eqDbMax, showPre, showPost]);

  // ---- ポインタ / ホイールのインタラクション ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 実レンダーサイズも合わせて返す。
    //  flex 親の stretch / overflow:hidden の影響で prop 由来の width/height と実際の
    //  キャンバスサイズに僅差が出ることがある（ResizeObserver の反映タイミング、端数、
    //  スクロールバー分など）。prop 値を使うと p.y の基準と (w,h) の基準がズレ、
    //  キャンバス端までドラッグしても eqDbMax まで届かない症状が出る。
    //  ここで rect を真として findBandAt / drag の両方で同じ (w,h) を用いる。
    const getCanvasPoint = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      };
    };

    // 最近傍バンドのヒットテスト（HIT_RADIUS_PX 以内）
    //  eqDbMax は ref 経由で最新を参照（スケール切替後もヒットテストが視覚位置と一致する）。
    const findBandAt = (x: number, y: number, w: number, h: number): number | null => {
      const toY = makeEqDbToY(eqDbMaxRef.current);
      let best: { idx: number; dist: number } | null = null;
      for (let i = 0; i < bandsRef.current.length; i++) {
        const b = bandsRef.current[i];
        if (!b) continue;
        const bx = hzToX(b.freqHz, w);
        const by = toY(b.gainDb, h);
        const d = Math.hypot(x - bx, y - by);
        if (d < HIT_RADIUS_PX && (!best || d < best.dist)) best = { idx: i, dist: d };
      }
      return best ? best.idx : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      const p = getCanvasPoint(e);
      const idx = findBandAt(p.x, p.y, p.w, p.h);
      if (idx === null) return;

      // Ctrl/Cmd + click: デフォルト値へリセット（drag 開始しない）。
      //   Shift は fine-adjust 用なので除外し、純粋に Ctrl/Cmd のみで反応させる。
      if (e.ctrlKey || e.metaKey) {
        const setters = bandsRef.current[idx];
        const def = BANDS[idx];
        setters.setFreqHz(def.defaultHz);
        setters.setGainDb(def.defaultGainDb);
        setters.setQ(def.defaultQ);
        setters.setSlopeDb(def.defaultSlopeDb);
        e.preventDefault();
        return;
      }

      const b = bandsRef.current[idx];
      anchorRef.current = {
        idx,
        startX: p.x,
        startY: p.y,
        startFreq: b.freqHz,
        startGain: b.gainDb,
      };
      canvas.setPointerCapture(e.pointerId);
      setActiveIdx(idx);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = getCanvasPoint(e);
      const a = anchorRef.current;

      if (a) {
        const setters = bandsRef.current[a.idx];
        const fine = isFine(e) ? 0.2 : 1.0;
        // 最新 eqDbMax を ref から取得（スケール切替中のドラッグでも正しい値を算出）
        const toY = makeEqDbToY(eqDbMaxRef.current);
        const toDb = makeYToEqDb(eqDbMaxRef.current);

        // X: ピクセル空間でアンカーからの差分を fine でスケールして適用
        const targetX = hzToX(a.startFreq, p.w) + (p.x - a.startX) * fine;
        const newFreq = clamp(xToHz(targetX, p.w), HZ_MIN, HZ_MAX);
        setters.setFreqHz(newFreq);

        // Y: 全バンドで drag 可能。Bell/Shelf は gain、HP/LP は "peak height" (Q に換算される)。
        const targetY = toY(a.startGain, p.h) + (p.y - a.startY) * fine;
        const newGain = clamp(toDb(targetY, p.h), -32, 32);
        setters.setGainDb(newGain);
        return;
      }

      // drag 中でなければ hover 更新
      const idx = findBandAt(p.x, p.y, p.w, p.h);
      setHoveredIdx(idx);
    };

    const endDrag = (e: PointerEvent) => {
      if (!anchorRef.current) return;
      canvas.releasePointerCapture(e.pointerId);
      anchorRef.current = null;
      setActiveIdx(null);
    };

    const onPointerLeave = () => {
      if (!anchorRef.current) setHoveredIdx(null);
    };

    // ダブルクリック: ノード上で on/off をトグル（他の場所ならスルー）
    const onDblClick = (e: MouseEvent) => {
      const p = getCanvasPoint(e);
      const idx = findBandAt(p.x, p.y, p.w, p.h);
      if (idx === null) return;
      e.preventDefault();
      const b = bandsRef.current[idx];
      b.setOn(!b.on);
    };

    const onWheel = (e: WheelEvent) => {
      // active（drag 中）> hover の優先。どちらも無ければ素通し（ページスクロール）。
      const idx = anchorRef.current?.idx ?? hoveredRef.current;
      if (idx === null || idx === undefined) return;
      e.preventDefault();
      const setters = bandsRef.current[idx];
      const def = BANDS[idx];

      if (def.isSlopeType) {
        // HP/LP: SLOPE_VALUES_DB を 1 段ずつ上下。
        //  wheel 上 (deltaY < 0) = 1 段きつく（dB/oct 増）、下 = 1 段ゆるく。
        //  Q とは違い連続値ではないので fine modifier は無視（段飛ばし抑止のほうが自然）。
        const curIdx = slopeDbToIdx(setters.slopeDb);
        const delta = e.deltaY < 0 ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(SLOPE_VALUES_DB.length - 1, curIdx + delta));
        if (nextIdx !== curIdx) setters.setSlopeDb(slopeIdxToDb(nextIdx));
        return;
      }

      // Bell/Shelf/Notch: Q を連続的に調整。
      //  ホイール上 (deltaY < 0) = Q 減少（ベル広がる）。 市販 EQ 多数の慣例に合わせる。
      const cur = setters.q;
      const fine = isFine(e) ? 0.2 : 1.0;
      const step = 1.15;
      const factor = e.deltaY < 0 ? Math.pow(1 / step, fine) : Math.pow(step, fine);
      const next = clamp(cur * factor, 0.1, 18);
      setters.setQ(next);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
    };
    // mount-once: イベントハンドラは ref を介して最新値を参照するため依存配列なしで OK。
    // hoveredIdx のみ state のため以下のダミー参照で onWheel が最新値を拾う形にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ノード hover / drag 中のみ指差し (pointer) カーソルに切替。
  // grab/grabbing の手のひらアイコンはノードや数値を隠すため避ける。
  const cursor = (activeIdx !== null || hoveredIdx !== null) ? 'pointer' : 'default';

  // ---- ツールチップ（hover / drag 中のノードに対して gain / freq / q を表示）----
  //  Portal で document.body に逃がし position: fixed で表示。
  //  これによりキャンバス外に自由にはみ出せて、端でのフリップ（視点ガタつき）が起こらない。
  //  符号に応じた上下配置のみで、再反転しない一貫した挙動。
  const tipIdx = activeIdx !== null ? activeIdx : hoveredIdx;
  let tooltip: ReactNode = null;
  if (tipIdx !== null && canvasRef.current) {
    const def = BANDS[tipIdx];
    const s = bands[tipIdx];
    if (s) {
      const rect = canvasRef.current.getBoundingClientRect();
      const screenX = rect.left + hzToX(s.freqHz, width);
      const screenY = rect.top + eqDbToY(s.gainDb, height);
      const above = s.gainDb >= 0;

      const tooltipEl = (
        <div
          style={{
            position: 'fixed',
            left: screenX,
            top: screenY,
            transform: above
              ? 'translate(-50%, calc(-100% - 18px))'
              : 'translate(-50%, 18px)',
            pointerEvents: 'none',
            background: 'rgba(16,18,22,0.5)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: `1px solid ${def.color}`,
            borderRadius: 3,
            padding: '3px 6px',
            fontSize: 10,
            lineHeight: 1.3,
            color: '#e0e0e0',
            whiteSpace: 'nowrap',
            fontFamily: 'inherit',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            zIndex: 10000,
          }}
        >
          <div>Gain: <span style={{ fontWeight: 600 }}>{formatGain(s.gainDb)} dB</span></div>
          <div>Freq: <span style={{ fontWeight: 600 }}>{formatHz(s.freqHz)} Hz</span></div>
          {def.isSlopeType
            ? <div>Slope: <span style={{ fontWeight: 600 }}>{s.slopeDb} dB/oct</span></div>
            : <div>Q: <span style={{ fontWeight: 600 }}>{formatQ(s.q)}</span></div>
          }
        </div>
      );

      tooltip = createPortal(tooltipEl, document.body);
    }
  }

  return (
    <div style={{ position: 'relative', display: 'block', width, height }}>
      <canvas ref={canvasRef} style={{ display: 'block', borderRadius: 4, cursor, touchAction: 'none' }} />
      {tooltip}
    </div>
  );
}

// 外部で座標変換が必要な場合用（将来、数値入力欄などで再利用）
// 座標ヘルパ外部公開（eqDbToY / yToEqDb は eqDbMax に依存するので makeEqDbToY を使う）
export const spectrumCoords = { hzToX, xToHz, specDbToY, SPEC_DB_MIN, HZ_MIN, HZ_MAX, makeEqDbToY, makeYToEqDb };
