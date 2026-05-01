import { useEffect, useRef } from 'react';
import { Knob } from './Knob';

// ============================================================================
// 操作可能なノブ（ドラッグ / ホイール / Ctrl+Cmd クリックでリセット）。
//  - 縦ドラッグ: 200px で min→max を行ききする線形マッピング（skew='log' は値空間で log）
//  - ホイール: 1 tick あたり 2% の normalized 変化
//  - 修飾キー (Ctrl / Cmd / Shift): 0.2x fine adjust
//  - Ctrl/Cmd + クリック（ドラッグなし）: onReset（他の市販 EQ 同様の慣例）
//
//  プロパティは「スカラ値 min/max/skew/onChange」に統一し、Knob の内部正規化は
//  このコンポーネントが引き受ける。こうしておけば APVTS 側も UI 側も "scaled value"
//  レンジで考えればよく、保守しやすい。
// ============================================================================

export interface InteractiveKnobProps {
  value: number;
  min: number;
  max: number;
  skew?: 'linear' | 'log';
  onChange: (v: number) => void;
  onReset?: () => void;

  // 修飾キー（Ctrl/Cmd/Shift）押下時に「値そのものをこのステップ刻みで動かす」モード。
  //  指定があると fine 操作は normalized 比例ではなく、value 空間で絶対量だけ進む。
  //  Gain ノブで 0.1 dB 刻みのオートメ向けタッチアップを可能にするための引数。
  fineStep?: number;

  // 見た目は Knob にそのまま透過
  size?: number;
  thickness?: number;
  color?: string;
  disabled?: boolean;
  label?: string;
}

const PX_PER_FULL_RANGE = 200;
const WHEEL_NORM_STEP = 0.02;
const FINE_FACTOR = 0.2;
const MOVE_THRESHOLD_PX = 3;
// fineStep モードでのドラッグ感度: 1 ステップあたりの縦移動 px。
//  4 px だと 200 px ドラッグで 50 ステップ（=5 dB @ step 0.1）と、
//  既存 fine（200 px ≒ 12.8 dB）よりやや繊細だが操作可能なバランス。
const FINE_STEP_PX_PER_STEP = 4;
// 浮動小数点の累積誤差で 0.1 + 0.1 + 0.1 = 0.30000000000000004 になるのを抑える。
const snapToStep = (v: number, step: number) => Math.round(v / step) * step;

function valueToNorm(v: number, min: number, max: number, skew: 'linear' | 'log'): number {
  if (skew === 'log') return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}
function normToValue(n: number, min: number, max: number, skew: 'linear' | 'log'): number {
  const c = Math.max(0, Math.min(1, n));
  if (skew === 'log') return min * Math.pow(max / min, c);
  return min + c * (max - min);
}

export function InteractiveKnob({
  value,
  min,
  max,
  skew = 'linear',
  onChange,
  onReset,
  fineStep,
  size = 34,
  thickness,
  color,
  disabled = false,
  label,
}: InteractiveKnobProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ startY: number; startNorm: number; startValue: number; moved: boolean } | null>(null);

  // 最新値を参照する ref（ホイール/ドラッグ中の stale closure 回避）
  const valueRef = useRef(value);
  valueRef.current = value;
  const propsRef = useRef({ min, max, skew, onChange, disabled, fineStep });
  propsRef.current = { min, max, skew, onChange, disabled, fineStep };

  // ホイールは passive: false が必要。onWheel (React) は passive なので native で貼る。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const p = propsRef.current;
      if (p.disabled) return;
      e.preventDefault();
      const fine = e.ctrlKey || e.metaKey || e.shiftKey;
      const dir = e.deltaY < 0 ? 1 : -1;
      // fineStep が指定されているノブは fine 時に「値そのものを step 単位」で動かす。
      //  例: Gain ノブ (fineStep=0.1) なら Ctrl+ホイール 1 ノッチ = ±0.1 dB。
      if (fine && p.fineStep) {
        const next = snapToStep(valueRef.current + dir * p.fineStep, p.fineStep);
        p.onChange(Math.max(p.min, Math.min(p.max, next)));
        return;
      }
      const step = WHEEL_NORM_STEP * (fine ? FINE_FACTOR : 1) * dir;
      const curNorm = valueToNorm(valueRef.current, p.min, p.max, p.skew);
      const nextVal = normToValue(curNorm + step, p.min, p.max, p.skew);
      p.onChange(nextVal);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    wrapRef.current?.setPointerCapture(e.pointerId);
    anchorRef.current = {
      startY: e.clientY,
      startNorm: valueToNorm(value, min, max, skew),
      startValue: value,
      moved: false,
    };
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = anchorRef.current;
    if (!a) return;
    const dy = e.clientY - a.startY;
    // 閾値以下はクリック扱い（Ctrl/Cmd + クリックのリセットを邪魔しないため）
    if (!a.moved && Math.abs(dy) < MOVE_THRESHOLD_PX) return;
    a.moved = true;
    const fine = e.ctrlKey || e.metaKey || e.shiftKey;
    // fine + fineStep 指定時は "1 ステップ刻み" でスナップ。
    //  ドラッグ方向の累積 px から step 数を Math.round で離散化し、startValue に加算する。
    if (fine && fineStep) {
      const stepsFromStart = Math.round(-dy / FINE_STEP_PX_PER_STEP);
      const raw = a.startValue + stepsFromStart * fineStep;
      const next = Math.max(min, Math.min(max, snapToStep(raw, fineStep)));
      onChange(next);
      return;
    }
    const rate = fine ? FINE_FACTOR : 1.0;
    const normDelta = (-dy / PX_PER_FULL_RANGE) * rate;
    const next = normToValue(a.startNorm + normDelta, min, max, skew);
    onChange(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = anchorRef.current;
    if (!a) return;
    wrapRef.current?.releasePointerCapture(e.pointerId);
    const wasClick = !a.moved;
    anchorRef.current = null;
    // Ctrl/Cmd + クリック（移動なし）でリセット。Shift のみのクリックは誤爆回避で無視。
    if (wasClick && (e.ctrlKey || e.metaKey) && onReset) onReset();
  };

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        display: 'inline-block',
        // カーソル変更はしない（ns-resize 等のシェイプがノブ上の数値/境界を隠すため）。
        touchAction: 'none',
      }}
    >
      <Knob
        value={valueToNorm(value, min, max, skew)}
        size={size}
        thickness={thickness}
        color={color}
        disabled={disabled}
        label={label}
      />
    </div>
  );
}
