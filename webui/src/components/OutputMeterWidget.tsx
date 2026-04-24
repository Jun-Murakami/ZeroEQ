import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { juceBridge } from '../bridge/juce';
import { LevelMeterBar } from './VUMeter';
import type { MeterUpdateData } from '../types';

// ============================================================================
// OUT L/R ピークメーター + dB 目盛りを独立して描画する widget。
//  目的: App から 30Hz の meterUpdate 購読を切り出し、App ツリー全体の
//        再レンダ頻度を下げる。メーター値の state は本コンポーネントに閉じる。
//  props: height (= スペアナ縦に追従させるため親から渡す)
// ============================================================================

interface Props {
  height: number;
}

// dB → canvas Y。ZeroComp LevelMeterBar と同じ -30..0 線形マップ。
const MIN_DB = -30;

export function OutputMeterWidget({ height }: Props) {
  const [outPeakL, setOutPeakL] = useState(-60);
  const [outPeakR, setOutPeakR] = useState(-60);

  useEffect(() => {
    const id = juceBridge.addEventListener('meterUpdate', (d: unknown) => {
      const m = d as MeterUpdateData;
      setOutPeakL(m.output?.peakLeft ?? -60);
      setOutPeakR(m.output?.peakRight ?? -60);
    });
    return () => juceBridge.removeEventListener(id);
  }, []);

  const scaleRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = scaleRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = 22;
    const h = height;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dbToY = (db: number) => h - ((Math.max(MIN_DB, Math.min(0, db)) - MIN_DB) / (0 - MIN_DB)) * h;
    ctx.font = '10px "Red Hat Mono", monospace';
    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    [0, -3, -6, -9, -12, -18, -24].forEach((db) => {
      const y = dbToY(db);
      // 上/下端に張り付くラベルはキャンバス内へ押し込む
      const yClamped = db === 0 ? 6 : Math.min(h - 6, y);
      ctx.fillText(db === 0 ? '0' : `${db}`, 2, yClamped);
    });
  }, [height]);

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: 0.5, minHeight: 0 }}>
      <LevelMeterBar level={outPeakL} width={20} height={height} showLabel={false} />
      <LevelMeterBar level={outPeakR} width={20} height={height} showLabel={false} />
      <canvas ref={scaleRef} style={{ display: 'block' }} />
    </Box>
  );
}
