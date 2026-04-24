import { useCallback, useSyncExternalStore } from 'react';

// ============================================================================
// 共有 preview param ストア（browser-only モード専用）
//
// DAW ロード時は juce-framework-frontend-mirror が各 param ID に対し
// singleton の SliderState を返すため、複数の hook 呼び出しは勝手に同期する。
// ブラウザ単独プレビューでは mirror が機能しないので、同じ役割を module-level の
// Map で担い、useSyncExternalStore 経由でリアクティブ購読する。
//
// 本番 (DAW) コードには一切触れないため、将来削除するときは preview 関連だけを
// 取り除けばよい。
// ============================================================================

type PreviewValue = number | boolean;

const values = new Map<string, PreviewValue>();
const listeners = new Map<string, Set<() => void>>();

export function getPreview<T extends PreviewValue>(id: string, fallback: T): T {
  return values.has(id) ? (values.get(id) as T) : fallback;
}

export function setPreview(id: string, v: PreviewValue): void {
  if (values.get(id) === v) return;
  values.set(id, v);
  const s = listeners.get(id);
  if (s) s.forEach((fn) => fn());
}

function subscribe(id: string, cb: () => void): () => void {
  let s = listeners.get(id);
  if (!s) {
    s = new Set();
    listeners.set(id, s);
  }
  s.add(cb);
  return () => {
    s!.delete(cb);
    if (s!.size === 0) listeners.delete(id);
  };
}

export function usePreviewNumber(id: string, fallback: number): [number, (v: number) => void] {
  const value = useSyncExternalStore(
    useCallback((cb) => subscribe(id, cb), [id]),
    useCallback(() => getPreview(id, fallback), [id, fallback]),
  );
  const setter = useCallback((v: number) => setPreview(id, v), [id]);
  return [value, setter];
}

export function usePreviewBool(id: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    useCallback((cb) => subscribe(id, cb), [id]),
    useCallback(() => getPreview(id, fallback), [id, fallback]),
  );
  const setter = useCallback((v: boolean) => setPreview(id, v), [id]);
  return [value, setter];
}
