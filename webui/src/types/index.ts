// ZeroEQ: ゼロレイテンシー EQ 用の型定義

// I/O メーターレベル（dBFS / LKFS）。EQ ではモード切替せず Peak/RMS/Momentary を同時に送る。
export interface StereoMeter {
  peakLeft?: number;
  peakRight?: number;
  rmsLeft?: number;
  rmsRight?: number;
  momentary?: number; // LKFS
}

// JUCE → WebUI のメーター更新イベント
export interface MeterUpdateData {
  input?: StereoMeter;
  output?: StereoMeter;
}

// JUCE → WebUI のスペクトラム更新イベント（Pre/Post）
//  - numBins : log-freq リサンプル済みビン数（Analyzer::kNumDisplayBins と一致、通常 256）
//  - pre     : Pre FFT の dB 配列（存在しない場合は省略）
//  - post    : Post FFT の dB 配列（存在しない場合は省略）
//  周波数レンジは 20Hz 〜 sampleRate/2 を対数等分。
export interface SpectrumUpdateData {
  numBins: number;
  pre?: number[];
  post?: number[];
}

// JUCE Backend 型定義
declare class Backend {
  addEventListener(eventId: string, fn: (args: unknown) => unknown): [string, number];
  removeEventListener(param: [string, number]): void;
  emitEvent(eventId: string, object: unknown): void;
  emitByBackend(eventId: string, object: unknown): void;
}

declare global {
  interface Window {
    __JUCE__?: {
      backend: Backend;
      initialisationData: Record<string, unknown>;
      postMessage: () => void;
    };
    getNativeFunction?: (name: string) => (...args: unknown[]) => Promise<unknown>;
    getSliderState?: (name: string) => unknown;
    getToggleState?: (name: string) => unknown;
    getComboBoxState?: (name: string) => unknown;
    getBackendResourceAddress?: (path: string) => string;
    __resizeRAF?: number;
  }
}

export {};
