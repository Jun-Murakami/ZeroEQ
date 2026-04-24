import { useEffect, useRef, useState, type PointerEventHandler } from 'react';
import { Fragment } from 'react';
import { Box, Button, Divider, Paper, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { juceBridge } from './bridge/juce';
import { darkTheme } from './theme';
import { useHostShortcutForwarding } from './hooks/useHostShortcutForwarding';
import { useGlobalZoomGuard } from './hooks/useGlobalZoomGuard';
import { GlobalDialog } from './components/GlobalDialog';
import LicenseDialog from './components/LicenseDialog';
import { WebTransportBar } from './components/WebTransportBar';
import { WebDemoMenu } from './components/WebDemoMenu';
import { ParameterFader } from './components/ParameterFader';
import { OutputMeterWidget } from './components/OutputMeterWidget';
import { SpectrumEditor } from './components/eq/SpectrumEditor';
import { BandControlColumn } from './components/eq/BandControlColumn';
import { BANDS } from './components/eq/BandDefs';
import { useAllBandStates } from './hooks/useBandParam';
import { useJuceComboBoxIndex } from './hooks/useJuceParam';
import './App.css';

const IS_WEB_MODE = import.meta.env.VITE_RUNTIME === 'web';

// 下部のバンドコントロール行の固定高（スイッチ + 3 段ノブ + 余白）。
//  バンド列の実コンテンツ: switch(24) + gap(8) + 3×(knob 34 + input - mt8) + 2×gap(8) ≈ 190
//  はみ出しを避けつつ余白を抑える目安。
const BAND_GRID_HEIGHT = 200;
// 右列（メーター / OUT フェーダー）の幅。
const RIGHT_COL_WIDTH = 80;

function App() {
  useHostShortcutForwarding();
  useGlobalZoomGuard();

  // 全 11 バンドの APVTS 状態（SpectrumEditor で合成カーブ + ノード drag / ホイール操作）
  //  OUT メーターと spectrum bins の購読は各子コンポーネントに内包してあるため、
  //  App 自体は 30Hz のイベントで再レンダしない (band パラメータ変更時のみ)。
  const allBandStates = useAllBandStates();
  const bandsForSpectrum = allBandStates.map((s) => ({
    on: s.on,
    freqHz: s.freqHz,
    gainDb: s.gainDb,
    q: s.q,
    slopeDb: s.slopeDb,
    setOn: s.setOn,
    setFreqHz: s.setFreqHz,
    setGainDb: s.setGainDb,
    setQ: s.setQ,
    setSlopeDb: s.setSlopeDb,
  }));

  useEffect(() => {
    juceBridge.whenReady(() => {
      juceBridge.callNative('system_action', 'ready');
    });
  }, []);

  const [licenseOpen, setLicenseOpen] = useState(false);

  // スペクトラム描画サイズの測定（Grid セルのサイズに追従）
  const spectrumWrapRef = useRef<HTMLDivElement | null>(null);
  const [spectrumSize, setSpectrumSize] = useState({ width: 900, height: 260 });
  useEffect(() => {
    const el = spectrumWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        setSpectrumSize((prev) => (prev.width !== w || prev.height !== h ? { width: w, height: h } : prev));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // OUTPUT フェーダーの高さ = バンド列の底と揃える。
  //  ParameterFader 内訳: label(20) + slider + mb(4) + mt(2) + input area(~20) ≈ slider + 46
  //  スライダーを気持ち長めに。
  const faderHeight = BAND_GRID_HEIGHT - 50;

  // EQ 縦軸の dB レンジ切替。スペアナ内左上にコンパクトなトグル。
  const [eqDbMax, setEqDbMax] = useState<number>(12);

  // スペアナ表示モード: 0=Off / 1=Pre / 2=Post / 3=Pre+Post（既定 3）。
  //  右上のトグルボタンで 0 ⇔ 3 を切替。off にすると backend が spectrumUpdate を emit しない。
  const { index: analyzerMode, setIndex: setAnalyzerMode } = useJuceComboBoxIndex('ANALYZER_MODE');
  const spectrumOn = analyzerMode !== 0;
  const toggleSpectrum = () => setAnalyzerMode(spectrumOn ? 0 : 3);

  // オールリセット: 全 11 バンドを BANDS 定義のデフォルトに戻す（on/off も含む）。
  const resetAllBands = () => {
    allBandStates.forEach((s, i) => {
      const def = BANDS[i];
      s.setOn(def.defaultOn);
      s.setFreqHz(def.defaultHz);
      s.setGainDb(def.defaultGainDb);
      s.setQ(def.defaultQ);
      s.setSlopeDb(def.defaultSlopeDb);
    });
  };

  // リサイズハンドル用 drag 状態。
  //  onDragStart で現在サイズを記録 → onDrag で差分算出 → juceBridge 経由で
  //  window_action('resizeTo', w, h) を発行。requestAnimationFrame で間引きして
  //  連続イベントで resize を乱発しないようにする（ZeroComp 参考）。
  const dragState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const onDragStart: PointerEventHandler<HTMLDivElement> = (e) => {
    dragState.current = { startX: e.clientX, startY: e.clientY, startW: window.innerWidth, startH: window.innerHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag: PointerEventHandler<HTMLDivElement> = (e) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const w = Math.max(875, dragState.current.startW + dx);
    const h = Math.max(450, dragState.current.startH + dy);
    if (!window.__resizeRAF) {
      window.__resizeRAF = requestAnimationFrame(() => {
        window.__resizeRAF = 0;
        juceBridge.callNative('window_action', 'resizeTo', w, h);
      });
    }
  };
  const onDragEnd: PointerEventHandler<HTMLDivElement> = () => {
    dragState.current = null;
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <style>{`
        #resizeHandle::after {
          content: '';
          position: absolute;
          right: 4px;
          top: 8px;
          width: 2px;
          height: 2px;
          background: rgba(79, 195, 247, 1);
          border-radius: 1px;
          pointer-events: none;
          box-shadow:
            -4px 4px 0 0 rgba(79, 195, 247, 1),
            -8px 8px 0 0 rgba(79, 195, 247, 1),
            -1px 7px 0 0 rgba(79, 195, 247, 1);
        }

        html, body, #root {
          -webkit-user-select: none;
          -ms-user-select: none;
          user-select: none;
        }
        input, textarea, select, [contenteditable="true"], .allow-selection {
          -webkit-user-select: text !important;
          -ms-user-select: text !important;
          user-select: text !important;
          caret-color: auto;
        }
      `}</style>
      {/* 外枠は ZeroComp と同じ. p:2 + pt:0 でヘッダ行と Paper の間に僅差を取る。
          背景色は theme の background.default に委ねる（Paper との明暗差で段差が出る）。 */}
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', p: 2, pt: 0, overflow: 'hidden' }}>
        {IS_WEB_MODE && (
          <Box sx={{ width: '100%', maxWidth: 1200 }}>
            <WebTransportBar />
          </Box>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1, py: 0.5 }}>
          <Typography
            variant='body2'
            sx={{ color: 'primary.main', fontWeight: 600, cursor: 'pointer' }}
            onClick={() => setLicenseOpen(true)}
          >
            ZeroEQ
          </Typography>
          <Typography variant='caption' color='text.secondary'>by Jun Murakami</Typography>
        </Box>

        <Paper
          elevation={2}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: `1fr ${RIGHT_COL_WIDTH}px`,
            gridTemplateRows: `1fr ${BAND_GRID_HEIGHT}px`,
            gap: 1,
            // ZeroComp と揃えたパディング: pt:2 / px:2 / pb:1 / mb:1
            pt: 2,
            px: 2,
            pb: 1,
            mb: 1,
          }}
        >
          {/* 上左: スペアナ + エディタ */}
          <Box
            ref={spectrumWrapRef}
            sx={{
              gridColumn: '1 / 2',
              gridRow: '1 / 2',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'stretch',
              minHeight: 0,
              minWidth: 0,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <SpectrumEditor
              width={spectrumSize.width}
              height={spectrumSize.height}
              bands={bandsForSpectrum}
              eqDbMax={eqDbMax}
            />
            {/* EQ 縦軸スケール切替（左上、最大値ラベルの右） */}
            <Box
              sx={{
                position: 'absolute',
                left: 27,
                top: 1,
                zIndex: 2,
              }}
            >
              <ToggleButtonGroup
                value={eqDbMax}
                exclusive
                size='small'
                onChange={(_, v) => { if (v !== null) setEqDbMax(v); }}
                sx={{
                  '& .MuiToggleButton-root': {
                    padding: '2px 7px',
                    fontSize: '11px',
                    lineHeight: 1,
                    minWidth: 0,
                    color: 'rgba(255,255,255,0.4)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  },
                  '& .MuiToggleButton-root.Mui-selected': {
                    color: '#fff',
                    backgroundColor: 'rgba(79,195,247,0.22)',
                    borderColor: 'rgba(79,195,247,0.55)',
                  },
                }}
              >
                {[3, 6, 12, 24, 32].map((v) => (
                  <ToggleButton key={v} value={v}>±{v}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>

            {/* 右上: Reset All + Spectrum トグル。flex-row で右端揃え。 */}
            <Box
              sx={{
                position: 'absolute',
                right: 10,
                top: 5,
                zIndex: 2,
                display: 'flex',
                gap: 0.5,
              }}
            >
              <Button
                onClick={resetAllBands}
                size='small'
                variant='outlined'
                sx={{
                  padding: '2px 8px',
                  minWidth: 0,
                  fontSize: '11px',
                  lineHeight: 1,
                  textTransform: 'none',
                  color: 'rgba(255,255,255,0.4)',
                  borderColor: 'rgba(255,255,255,0.12)',
                  '&:hover': {
                    color: 'rgba(255,255,255,0.85)',
                    borderColor: 'rgba(255,255,255,0.35)',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                  },
                }}
              >
                Reset All
              </Button>
              <Button
                onClick={toggleSpectrum}
                size='small'
                variant='outlined'
                sx={{
                  padding: '2px 8px',
                  minWidth: 0,
                  fontSize: '11px',
                  lineHeight: 1,
                  textTransform: 'none',
                  color: spectrumOn ? '#fff' : 'rgba(255,255,255,0.4)',
                  borderColor: spectrumOn ? 'rgba(79,195,247,0.55)' : 'rgba(255,255,255,0.12)',
                  backgroundColor: spectrumOn ? 'rgba(79,195,247,0.22)' : 'transparent',
                  '&:hover': {
                    color: '#fff',
                    borderColor: 'rgba(79,195,247,0.55)',
                    backgroundColor: spectrumOn ? 'rgba(79,195,247,0.32)' : 'rgba(255,255,255,0.04)',
                  },
                }}
              >
                Spectrum
              </Button>
            </Box>
          </Box>

          {/* 上右: OUT L / R メーター + dB スケール（widget が内部で meterUpdate を購読） */}
          <Box
            sx={{
              gridColumn: '2 / 3',
              gridRow: '1 / 2',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
              minHeight: 0,
            }}
          >
            <OutputMeterWidget height={spectrumSize.height} />
          </Box>

          {/* 下左: バンドコントロール群（space-between で可変ギャップ） */}
          <Box
            sx={{
              gridColumn: '1 / 2',
              gridRow: '2 / 3',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              pl: 5,
            }}
          >
            {/* 左端の行ラベル。各ノブの縦中央に揃えるため、BandControlColumn と同じレイアウトを
                ダミー Box で再現した列を絶対配置する。 */}
            <Box sx={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 32,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 1, // BandControlColumn の gap:1 と一致
              fontSize: 12,
              color: 'text.secondary',
              lineHeight: 1,
              userSelect: 'none',
              pointerEvents: 'none',
              pr: 1, // ディバイダーとの隙間
            }}>
              {/* スイッチ行のプレースホルダー */}
              <Box sx={{ height: 24 }} />
              {/* Gain: knob + 数値入力のグループ。ラベルはノブと同じ高さ Box に中央揃え。 */}
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%' }}>
                <Box sx={{ height: 34, display: 'flex', alignItems: 'center' }}>Gain</Box>
                <Box sx={{ height: 16 }} />
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%' }}>
                <Box sx={{ height: 34, display: 'flex', alignItems: 'center' }}>Freq</Box>
                <Box sx={{ height: 16 }} />
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%' }}>
                <Box sx={{ height: 34, display: 'flex', alignItems: 'center' }}>Q</Box>
                <Box sx={{ height: 16 }} />
              </Box>
            </Box>

            <Box
              sx={{
                flex: 1,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Divider orientation='vertical' flexItem sx={{ borderLeft: '1px solid rgba(255,255,255,0.22)', alignSelf: 'stretch' }} />
              {BANDS.map((b) => (
                <Fragment key={b.index}>
                  <BandControlColumn def={b} />
                  <Divider orientation='vertical' flexItem sx={{ borderLeft: '1px solid rgba(255,255,255,0.22)', alignSelf: 'stretch' }} />
                </Fragment>
              ))}
            </Box>
          </Box>

          {/* 下右: OUT フェーダー（ZeroComp と同じ ParameterFader） */}
          <Box
            sx={{
              gridColumn: '2 / 3',
              gridRow: '2 / 3',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
            }}
          >
            <ParameterFader
              parameterId='OUTPUT_GAIN'
              label='OUTPUT'
              min={-24}
              max={24}
              defaultValue={0}
              sliderHeight={faderHeight}
              wheelStep={1}
              wheelStepFine={0.1}
              scaleMarks={[
                { value: 24, label: '+24' },
                { value: 12, label: '+12' },
                { value: 0, label: '0' },
                { value: -12, label: '-12' },
                { value: -24, label: '-24' },
              ]}
            />
          </Box>
        </Paper>
      </Box>

      {/* プラグイン (non-web) 時のみ右下コーナーに擬似リサイズハンドル。
          WebView overlay として window_action を叩いて本体サイズを追従させる。
          ZeroComp と同じ実装。 */}
      {!IS_WEB_MODE && <div
        id='resizeHandle'
        onPointerDown={onDragStart}
        onPointerMove={onDrag}
        onPointerUp={onDragEnd}
        style={{
          position: 'fixed',
          right: 0,
          bottom: 0,
          width: 24,
          height: 24,
          cursor: 'nwse-resize',
          zIndex: 2147483647,
          backgroundColor: 'transparent',
        }}
        title='Resize'
      />}

      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
      <GlobalDialog />

      {IS_WEB_MODE && <WebDemoMenu />}
    </ThemeProvider>
  );
}

export default App;
