// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jun Murakami
import { memo } from 'react';
import { Box, IconButton, MenuItem, Select } from '@mui/material';
import { InteractiveKnob } from './InteractiveKnob';
import { FilterIcon } from './FilterIcon';
import type { BandDef } from './BandDefs';
import { SLOPE_VALUES_DB, slopeIdxToDb, slopeDbToIdx } from './BandDefs';
import {
  InlineNumberInput,
  formatHz, parseHz,
  formatGain, parseGain,
  formatQ, parseQ,
} from './InlineNumberInput';
import { useBandState } from '../../hooks/useBandParam';
import { setHoveredBandFromKnob } from '../../hooks/hoveredBandStore';

// 1 バンドの縦カラム。
//  上から順に:
//    1) on/off スイッチ（フィルタタイプアイコン付き）
//    2) Gain knob + 数値入力
//    3) Freq knob + 数値入力
//    4) Q knob (Bell/Shelf) / Slope セレクト (HP/LP) + 表示
//  ノブ/スライダは Ctrl/Cmd+クリックで既定値リセット。
//  数値入力欄はクリックで編集可能。Enter / Tab / 外側クリックで確定。Escape で破棄。

interface Props {
  def: BandDef;
  // 横幅が縮んだとき: dB/Hz サフィックスを非表示にし、列幅をノブと同じ KNOB_SIZE まで詰める。
  // App.tsx 側で max-width media query から決定して渡す。
  compact?: boolean;
}

const KNOB_SIZE = 34;
const INPUT_WIDTH = 44;
const COLUMN_WIDTH = 44;
const SWITCH_SIZE = 24;   // ノブより小さめに。中のアイコンを相対的に大きく見せる。
const SWITCH_ICON_SIZE = 20;
const SLOPE_SELECT_HEIGHT = 26;  // ノブ行よりやや低め。数値入力欄と同じ高さの気配で揃える。

// 1 本のバンド UI。内部で useBandState 購読するので、親 App の再レンダに連動させず、
// 自分が購読している APVTS 値が変わった時だけ再レンダするように React.memo で包む。
// `def` は BANDS 配列の定数参照なので shallow 比較で確実にスキップされる。
function BandControlColumnImpl({ def, compact = false }: Props) {
  const { on, setOn, gainDb, setGainDb, freqHz, setFreqHz, q, setQ, slopeDb, setSlopeDb } = useBandState(def.index);

  const color = def.color;
  const handleToggle = () => setOn(!on);

  // コンパクト時は入力欄をノブ幅に揃え、ディバイダーが詰まれる余地を作る。
  const inputWidth  = compact ? KNOB_SIZE : INPUT_WIDTH;
  const columnWidth = compact ? KNOB_SIZE : COLUMN_WIDTH;
  const gainSuffix  = compact ? undefined : 'dB';
  const freqSuffix  = compact ? undefined : 'Hz';

  // 列にホバーすると SpectrumEditor 側の対応ノードを 1.5x 拡大表示する。
  //  - 列のどこに pointer が乗っても発火（Gain/Freq/Q のどれを操作しに来ても OK）
  //  - knob ドラッグ中（pointer capture 中）は leave がブロックされるので、
  //    アクティブ時もドットの拡大状態が維持される（意図通り）
  const onPointerEnter = () => setHoveredBandFromKnob(def.index);
  const onPointerLeave = () => setHoveredBandFromKnob(null);

  return (
    <Box
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: columnWidth, gap: 1 }}
    >
      {/* on/off スイッチ */}
      <IconButton
        onClick={handleToggle}
        size='small'
        sx={{
          width: SWITCH_SIZE,
          height: SWITCH_SIZE,
          borderRadius: 1,
          border: '1px solid',
          borderColor: on ? color : 'rgba(255,255,255,0.15)',
          backgroundColor: on ? color : 'transparent',
          color: on ? '#fff' : color,
          // OFF 時は全体を半透明にして「効いていない」ことを視覚的に弱める。
          opacity: on ? 1 : 0.5,
          p: 0,
          '&:hover': {
            backgroundColor: on ? color : 'rgba(255,255,255,0.06)',
            opacity: 1,
          },
        }}
      >
        <FilterIcon type={def.type} size={SWITCH_ICON_SIZE} />
      </IconButton>

      {/* Gain — Bell/Shelf は通常ゲイン、HP/LP は peak 高さ dB（DSP 側で Q に換算）*/}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, opacity: on ? 1 : 0.5, '& > *:nth-of-type(2)': { mt: '-8px' } }}>
        <InteractiveKnob
          value={gainDb}
          min={-32}
          max={32}
          skew='linear'
          onChange={setGainDb}
          onReset={() => setGainDb(0)}
          fineStep={0.1}
          size={KNOB_SIZE}
          color={color}
        />
        <InlineNumberInput
          value={gainDb}
          min={-32}
          max={32}
          onChange={setGainDb}
          format={formatGain}
          parse={parseGain}
          width={inputWidth}
          suffix={gainSuffix}
        />
      </Box>

      {/* Freq */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, opacity: on ? 1 : 0.5, '& > *:nth-of-type(2)': { mt: '-8px' } }}>
        <InteractiveKnob
          value={freqHz}
          min={20}
          max={20000}
          skew='log'
          onChange={setFreqHz}
          onReset={() => setFreqHz(def.defaultHz)}
          size={KNOB_SIZE}
          color={color}
        />
        <InlineNumberInput
          value={freqHz}
          min={20}
          max={20000}
          onChange={setFreqHz}
          format={formatHz}
          parse={parseHz}
          width={inputWidth}
          suffix={freqSuffix}
        />
      </Box>

      {/* Q (Bell/Shelf) or Slope (HP/LP) */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, opacity: on ? 1 : 0.5, '& > *:nth-of-type(2)': { mt: '-8px' } }}>
        {def.isSlopeType ? (
          <>
            <Select
              value={slopeDbToIdx(slopeDb)}
              onChange={(e) => setSlopeDb(slopeIdxToDb(Number(e.target.value)))}
              size='small'
              variant='outlined'
              MenuProps={{ slotProps: { paper: { sx: { '& .MuiMenuItem-root': { fontSize: 13, minHeight: 26, py: 0.3 } } } } }}
              sx={{
                width: KNOB_SIZE,
                height: SLOPE_SELECT_HEIGHT,
                // ノブ行（KNOB_SIZE 高さ）の中央に置いて、他バンドの Q ノブと縦位置を揃える。
                mt: `${(KNOB_SIZE - SLOPE_SELECT_HEIGHT) / 2}px`,
                fontSize: 12,
                color: 'text.primary',
                '& .MuiSelect-select': {
                  padding: '0 14px 0 0 !important',
                  textAlign: 'center',
                  lineHeight: `${SLOPE_SELECT_HEIGHT - 2}px`,
                },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: color },
                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: color },
                '& .MuiSelect-icon': { color, right: 0, fontSize: 18 },
              }}
            >
              {SLOPE_VALUES_DB.map((db) => (
                <MenuItem key={db} value={slopeDbToIdx(db)}>{db}p</MenuItem>
              ))}
            </Select>
          </>
        ) : (
          <>
            <InteractiveKnob
              value={q}
              min={0.1}
              max={18}
              skew='log'
              onChange={setQ}
              onReset={() => setQ(def.defaultQ)}
              size={KNOB_SIZE}
              color={color}
            />
            <InlineNumberInput
              value={q}
              min={0.1}
              max={18}
              onChange={setQ}
              format={formatQ}
              parse={parseQ}
              width={inputWidth}
            />
          </>
        )}
      </Box>
    </Box>
  );
}

export const BandControlColumn = memo(BandControlColumnImpl);
