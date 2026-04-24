import type { BandType } from './BandDefs';

// バンドスイッチ上に載せる、フィルタタイプを表す小さなアイコン。
//  SVG 20×20、currentColor で描画されるのでボタン側の color プロパティで色が決まる。

interface Props {
  type: BandType;
  size?: number;
}

export function FilterIcon({ type, size = 18 }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (type) {
    case 'HighPass':
      // passband フラット (右上) → 左下で画面外へ落ちて消える。シェルフのプラトー形と区別しやすい形。
      return (
        <svg {...common}>
          <path d="M 18 5 L 11 5 L 2 22" />
        </svg>
      );
    case 'LowShelf':
      // low-left lifted, step-down to flat right: bass shelf
      return (
        <svg {...common}>
          <path d="M 2 6 L 7 6 L 11 12 L 18 12" />
        </svg>
      );
    case 'Bell':
      // 対称アーチ。視覚中心を viewBox 中央（y=10）に合わせるため 1 単位上に寄せている。
      return (
        <svg {...common}>
          <path d="M 2 13 Q 10 1 18 13" />
        </svg>
      );
    case 'HighShelf':
      // flat low, step-up to high: treble shelf
      return (
        <svg {...common}>
          <path d="M 2 12 L 9 12 L 13 6 L 18 6" />
        </svg>
      );
    case 'LowPass':
      // passband フラット (左上) → 右下で画面外へ落ちて消える。HP の対称形。
      return (
        <svg {...common}>
          <path d="M 2 5 L 9 5 L 18 22" />
        </svg>
      );
  }
}
