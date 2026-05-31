// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
//
// EQ バンドの数値入力用 パーサ / フォーマッタ（Hz / Gain / Q 用）。
//  コンポーネントファイル（InlineNumberInput.tsx）から分離して react-refresh の
//  only-export-components 制約を満たす（HMR 境界を壊さない）。

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
