// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import { useSyncExternalStore } from 'react';

// ============================================================================
// バンド列（BandControlColumn）に hover した時、SpectrumEditor 側の対応するノードを
// 強調表示するための共有 hover index。
//
// App.tsx に lift すると 11 列の hover 切替で App ツリー全体が再レンダする（spectrum
// canvas の再描画はそれで OK だが、他バンド列まで巻き込まれるのが無駄）。SpectrumEditor
// だけが購読すれば足りるので、preview store と同様 module-level の subscribe / notify
// で隔離する。
// ============================================================================

let hovered: number | null = null;
const listeners = new Set<() => void>();

export function setHoveredBandFromKnob(idx: number | null): void {
  if (hovered === idx) return;
  hovered = idx;
  listeners.forEach((fn) => fn());
}

export function useHoveredBandFromKnob(): number | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    () => hovered,
    () => hovered, // SSR は無いので server snapshot も同じで OK
  );
}
