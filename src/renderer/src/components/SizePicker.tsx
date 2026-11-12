import { useEffect, useState } from 'react';
import { RATIO_PRESETS, planSize } from '@shared/presets';
import type { SizeRequest, Workspace } from '@shared/types';

function sizeLabel(ws: Workspace, req: SizeRequest): string {
  const plan = planSize(ws.baseModel, ws.defaults, req, ws.pipeline !== 'custom');
  return `${plan.width}×${plan.height}${plan.hires ? ' · hires' : ''}`;
}

function valueOf(req: SizeRequest): string {
  if (req.kind === 'ratio') return `${req.w}:${req.h}`;
  if (req.kind === 'exact') return 'custom';
  if (req.kind === 'aspect') return `aspect:${req.aspect}`;
  return 'auto';
}

interface Props {
  workspace: Workspace;
  value: SizeRequest;
  onChange: (req: SizeRequest) => void;
}

/** Size for the next generations. "Auto" lets the message / local LLM decide. */
export function SizePicker({ workspace: ws, value, onChange }: Props) {
  const [w, setW] = useState(value.kind === 'exact' ? value.width : ws.defaults.width);
  const [h, setH] = useState(value.kind === 'exact' ? value.height : ws.defaults.height);
  useEffect(() => {
    if (value.kind === 'exact') {
      setW(value.width);
      setH(value.height);
    }
  }, [value]);

  const commitCustom = () => {
    if (w >= 64 && h >= 64) onChange({ kind: 'exact', width: Math.round(w), height: Math.round(h) });
  };

  return (
    <span className="size-picker" title="Tamanho das próximas imagens. Em Auto, vale o que você escrever na mensagem (ex.: 16:9, 1920x1080, formato vertical) ou o que o LLM escolher.">
      <span aria-hidden>📐</span>
      <select
        className="select small"
        value={valueOf(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'auto') onChange({ kind: 'auto' });
          else if (v === 'custom') onChange({ kind: 'exact', width: w, height: h });
          else {
            const [rw, rh] = v.split(':').map(Number);
            onChange({ kind: 'ratio', w: rw, h: rh });
          }
        }}
      >
        <option value="auto">Auto · {ws.defaults.width}×{ws.defaults.height}</option>
        {RATIO_PRESETS.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label} {r.id} · {sizeLabel(ws, { kind: 'ratio', w: r.w, h: r.h })}
          </option>
        ))}
        <option value="custom">Personalizado…</option>
        {value.kind === 'aspect' && <option value={valueOf(value)}>{value.aspect}</option>}
      </select>
      {value.kind === 'exact' && (
        <span className="size-custom">
          <input
            type="number"
            min={256}
            max={2560}
            step={64}
            value={w}
            onChange={(e) => setW(Number(e.target.value))}
            onBlur={commitCustom}
            onKeyDown={(e) => e.key === 'Enter' && commitCustom()}
            aria-label="Largura"
          />
          ×
          <input
            type="number"
            min={256}
            max={2560}
            step={64}
            value={h}
            onChange={(e) => setH(Number(e.target.value))}
            onBlur={commitCustom}
            onKeyDown={(e) => e.key === 'Enter' && commitCustom()}
            aria-label="Altura"
          />
          <span className="muted small">{sizeLabel(ws, value).includes('hires') ? 'hires' : ''}</span>
        </span>
      )}
    </span>
  );
}

/** "Refazer em…" menu for a result: same seed, another format. */
export function RerunSizeMenu({ disabled, onPick }: { disabled: boolean; onPick: (req: SizeRequest) => void }) {
  return (
    <select
      className="select tiny-select"
      value=""
      disabled={disabled}
      title="Gerar de novo com a mesma seed em outro formato"
      onChange={(e) => {
        const [rw, rh] = e.target.value.split(':').map(Number);
        if (rw && rh) onPick({ kind: 'ratio', w: rw, h: rh });
      }}
    >
      <option value="">Outro formato…</option>
      {RATIO_PRESETS.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label} {r.id}
        </option>
      ))}
    </select>
  );
}
