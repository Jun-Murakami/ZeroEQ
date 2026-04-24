// 円形ノブ（MUI CircularProgress 風、8時→4時の 240°スイープ）。
//  - determinate 固定。value は 0..1 で 240° の扇を塗る。
//  - 色はプロパティで切替可能（バンドごとの色に合わせる）。
//  - インタラクションはまだ無し（見栄え優先）。将来ドラッグ/ホイールを追加する。

interface Props {
  value: number;         // 0..1
  size?: number;
  thickness?: number;
  color?: string;
  trackColor?: string;
  disabled?: boolean;
  label?: string;        // 中央に重ねる小さな数値表示
}

function polar(cx: number, cy: number, r: number, clockDeg: number) {
  // clockDeg: 0 = 12 時、時計回り
  const a = ((clockDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, startClock: number, sweepDeg: number) {
  const endClock = startClock + sweepDeg;
  const start = polar(cx, cy, r, startClock);
  const end = polar(cx, cy, r, endClock);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  const sweepFlag = 1; // 時計回り
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function Knob({
  value,
  size = 36,
  thickness = 5,
  color = '#4FC3F7',
  trackColor = 'rgba(255,255,255,0.10)',
  disabled = false,
  label,
}: Props) {
  const v = Math.max(0, Math.min(1, value));
  // r はストロークの中心線半径。`r + thickness/2` が外縁になるので、
  // (size - thickness)/2 - 1 を保てば thickness を増やしても外径は変わらず、
  // 中心方向にリングが太くなる。
  const r = (size - thickness) / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;

  // 8 時 = 240°、スイープ 240°（下 120°をカット）
  const START_CLOCK = 240;
  const TOTAL_SWEEP = 240;

  const trackD = arcPath(cx, cy, r, START_CLOCK, TOTAL_SWEEP);
  const valueD = v > 0.001 ? arcPath(cx, cy, r, START_CLOCK, TOTAL_SWEEP * v) : null;

  const opacity = disabled ? 0.35 : 1;
  const strokeColor = disabled ? '#777' : color;

  return (
    <svg width={size} height={size} style={{ opacity, display: 'block' }}>
      <path
        d={trackD}
        stroke={trackColor}
        strokeWidth={thickness}
        fill="none"
        strokeLinecap="round"
      />
      {valueD && (
        <path
          d={valueD}
          stroke={strokeColor}
          strokeWidth={thickness}
          fill="none"
          strokeLinecap="butt"
        />
      )}
      {label && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fill: disabled ? '#777' : '#ddd', fontSize: size * 0.28, fontFamily: 'inherit', fontWeight: 500 }}
        >
          {label}
        </text>
      )}
    </svg>
  );
}
