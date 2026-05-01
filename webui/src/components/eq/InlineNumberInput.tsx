// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import { useEffect, useRef, useState } from 'react';

// ============================================================================
// ノブ下の小さな数値入力。
//  - 通常は format() で整形した値を表示
//  - focus でフォーカス時に文字列バッファ（未整形）を編集
//  - Enter / blur で parse() → clamp → onChange
//  - Escape でバッファを破棄して元の表示に戻す
//  - 外部から value が変わった時は focus 中でなければ整形値に追従
//
// 表示枠は親から幅を制約される想定。DAW の WebView でも小さなフォントで読める形。
// ============================================================================

export interface InlineNumberInputProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  parse: (s: string) => number | null;
  width?: number;        // CSS px、未指定時は親 flex 幅いっぱい
  color?: string;
  className?: string;
  suffix?: string;       // 'dB', 'Hz' など。うすーく右寄せで描画。
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function InlineNumberInput({
  value,
  min,
  max,
  onChange,
  format,
  parse,
  width,
  color,
  className,
  suffix,
}: InlineNumberInputProps) {
  const [buffer, setBuffer] = useState<string>(() => format(value));
  const focusedRef = useRef(false);

  // 外部 value 変更への追従（フォーカス中は上書きしない）
  useEffect(() => {
    if (!focusedRef.current) setBuffer(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    const parsed = parse(buffer);
    if (parsed !== null && Number.isFinite(parsed)) {
      onChange(clamp(parsed, min, max));
    } else {
      // parse 失敗時は直近の外部 value に戻す
      setBuffer(format(value));
    }
  };

  // .block-host-shortcuts は useHostShortcutForwarding 側で「DAW に転送しない要素」
  // としてマーカーに使っている。これが無いと数値入力中のキーがプラグインを素通りして
  // DAW のショートカットに食われる（ParameterFader / HorizontalParameter と揃える）。
  const mergedClassName = className ? `block-host-shortcuts ${className}` : 'block-host-shortcuts';

  const inputEl = (
    <input
      className={mergedClassName}
      type='text'
      inputMode='decimal'
      value={buffer}
      onFocus={(e) => {
        focusedRef.current = true;
        setBuffer(format(value));
        e.target.select();
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onChange={(e) => setBuffer(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setBuffer(format(value));
          focusedRef.current = false;
          e.currentTarget.blur();
        }
      }}
      style={{
        width: '100%',
        minWidth: 0,
        fontSize: 13,
        fontFamily: 'inherit',
        textAlign: 'center',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid transparent',
        color: color ?? 'inherit',
        padding: 0,
        margin: 0,
        outline: 'none',
        lineHeight: 1.1,
      }}
      onMouseOver={(e) => { e.currentTarget.style.borderBottomColor = 'rgba(255,255,255,0.2)'; }}
      onMouseOut={(e) => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
    />
  );

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: width ?? '100%', minWidth: 28 }}>
      {inputEl}
      {/* サフィックスはインプット枠の外側（右）に絶対配置。
          インプット自身の幅・位置は変えず、右にラベルが伸びる形。 */}
      {suffix && (
        <span
          style={{
            position: 'absolute',
            left: '100%',
            top: '50%',
            transform: 'translateY(-50%)',
            marginLeft: -5,
            fontSize: 9,
            color: color ?? 'inherit',
            opacity: 0.38,
            pointerEvents: 'none',
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// パーサ / フォーマッタ（Hz / Gain / Q 用）
// ----------------------------------------------------------------------------
export const formatHz = (hz: number): string => `${Math.round(hz)}`;
export const parseHz = (s: string): number | null => {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k)?\s*(hz)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * 1000 : n;
};

export const formatGain = (db: number): string => {
  if (Math.abs(db) < 0.05) return '0.0';
  return (db >= 0 ? '+' : '') + db.toFixed(1);
};
export const parseGain = (s: string): number | null => {
  const cleaned = s.trim().replace(/\s*db\s*$/i, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

export const formatQ = (q: number): string => (q < 10 ? q.toFixed(2) : q.toFixed(1));
export const parseQ = (s: string): number | null => {
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
};
