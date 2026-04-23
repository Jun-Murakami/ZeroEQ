import { useEffect, useRef, useState } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { juceBridge } from './bridge/juce';
import { darkTheme } from './theme';
import { useHostShortcutForwarding } from './hooks/useHostShortcutForwarding';
import { useGlobalZoomGuard } from './hooks/useGlobalZoomGuard';
import { GlobalDialog } from './components/GlobalDialog';
import LicenseDialog from './components/LicenseDialog';
import { WebTransportBar } from './components/WebTransportBar';
import { WebDemoMenu } from './components/WebDemoMenu';
import type { MeterUpdateData, SpectrumUpdateData } from './types';
import './App.css';

const IS_WEB_MODE = import.meta.env.VITE_RUNTIME === 'web';

// ===========================================================================
// ZeroEQ WebUI — プレースホルダ実装。
// 仮の中央スペクトラムキャンバスと I/O ピークメーターのみを表示する。
// 本番 UI（8 band の EQ カーブ + ノード drag、スペアナ統合）は別途実装。
// ===========================================================================

type SpectrumState = { pre?: number[]; post?: number[]; numBins: number };

function SpectrumView({ data, width, height }: { data: SpectrumState; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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

    // 背景グリッド
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let db = 0; db >= -60; db -= 12) {
      const y = ((db + 12) / 72) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const drawCurve = (bins: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * width;
        const db = Math.max(-60, Math.min(12, bins[i] ?? -60));
        const y = ((12 - db) / 72) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (data.pre)  drawCurve(data.pre,  'rgba(110,165,255,0.45)');
    if (data.post) drawCurve(data.post, 'rgba(255,210,110,0.85)');
  }, [data, width, height]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}

function App() {
  useHostShortcutForwarding();
  useGlobalZoomGuard();

  const [inPeakL, setInPeakL] = useState(-60);
  const [inPeakR, setInPeakR] = useState(-60);
  const [outPeakL, setOutPeakL] = useState(-60);
  const [outPeakR, setOutPeakR] = useState(-60);
  const [spectrum, setSpectrum] = useState<SpectrumState>({ numBins: 256 });

  useEffect(() => {
    const meterId = juceBridge.addEventListener('meterUpdate', (d: unknown) => {
      const m = d as MeterUpdateData;
      setInPeakL(m.input?.peakLeft ?? -60);
      setInPeakR(m.input?.peakRight ?? -60);
      setOutPeakL(m.output?.peakLeft ?? -60);
      setOutPeakR(m.output?.peakRight ?? -60);
    });
    const specId = juceBridge.addEventListener('spectrumUpdate', (d: unknown) => {
      const s = d as SpectrumUpdateData;
      setSpectrum({ numBins: s.numBins ?? 256, pre: s.pre, post: s.post });
    });
    return () => {
      juceBridge.removeEventListener(meterId);
      juceBridge.removeEventListener(specId);
    };
  }, []);

  useEffect(() => {
    juceBridge.whenReady(() => {
      juceBridge.callNative('system_action', 'ready');
    });
  }, []);

  const [licenseOpen, setLicenseOpen] = useState(false);

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', p: 1.5, gap: 1 }}>
        {IS_WEB_MODE && (
          <Box sx={{ width: '100%', maxWidth: 900 }}>
            <WebTransportBar />
          </Box>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1 }}>
          <Typography
            variant='body2'
            sx={{ color: 'primary.main', fontWeight: 600, cursor: 'pointer' }}
            onClick={() => setLicenseOpen(true)}
          >
            ZeroEQ
          </Typography>
          <Typography variant='caption' color='text.secondary'>by Jun Murakami</Typography>
        </Box>

        <Paper elevation={2} sx={{ flex: 1, display: 'flex', flexDirection: 'column', p: 1.5, gap: 1 }}>
          <Typography variant='caption' color='text.secondary'>
            Placeholder EQ view — アナライザとメーターの配線確認用。バンド UI は未実装。
          </Typography>

          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#15181b', borderRadius: 1, overflow: 'hidden' }}>
            <SpectrumView data={spectrum} width={820} height={320} />
          </Box>

          <Box sx={{ display: 'flex', gap: 2, fontSize: 12, color: 'text.secondary' }}>
            <span>IN L: {inPeakL.toFixed(1)} dB</span>
            <span>IN R: {inPeakR.toFixed(1)} dB</span>
            <span style={{ marginLeft: 'auto' }}>OUT L: {outPeakL.toFixed(1)} dB</span>
            <span>OUT R: {outPeakR.toFixed(1)} dB</span>
          </Box>
        </Paper>
      </Box>

      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
      <GlobalDialog />

      {IS_WEB_MODE && <WebDemoMenu />}
    </ThemeProvider>
  );
}

export default App;
