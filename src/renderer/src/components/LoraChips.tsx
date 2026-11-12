import type { AppliedLora, InstalledModel, LoraMode, LoraRef, Workspace } from '@shared/types';
import { BASE_MODEL_PROFILES, loraCompatible } from '@shared/presets';

export function shortName(file?: string): string {
  if (!file) return '';
  return file.split('/').pop()!.replace(/\.(safetensors|ckpt|pt|pth|sft|gguf|bin)$/i, '');
}

function describe(lora: LoraRef, meta: InstalledModel | undefined, ws: Workspace): { title: string; warn: string | null } {
  const lines = [lora.file, `força ${lora.strength}`];
  let warn: string | null = null;
  if (!meta) {
    warn = 'Arquivo não encontrado nas pastas de LoRA do ComfyUI.';
  } else {
    const m = meta.meta;
    if (m.baseModel) {
      lines.push(
        `modelo base: ${BASE_MODEL_PROFILES[m.baseModel]?.label ?? m.baseModel}${m.detectedFrom ? ` (detectado: ${m.detectedFrom})` : ''}`,
      );
      if (loraCompatible(m.baseModel, ws.baseModel) === 'no') {
        warn = `LoRA de ${BASE_MODEL_PROFILES[m.baseModel]?.label ?? m.baseModel} num workspace ${BASE_MODEL_PROFILES[ws.baseModel]?.label ?? ws.baseModel}: provavelmente não funciona.`;
      }
    }
    if (m.triggerWords?.length) lines.push(`gatilhos: ${m.triggerWords.slice(0, 6).join(', ')}`);
    else if (m.trainingTags?.length) lines.push(`tags de treino: ${m.trainingTags.join(', ')}`);
    if (m.description) lines.push(m.description);
  }
  if (warn) lines.push(`⚠ ${warn}`);
  return { title: lines.join('\n'), warn };
}

interface StripProps {
  workspace: Workspace;
  models: InstalledModel[];
  modes: Record<string, LoraMode>;
  onModeChange: (file: string, mode: LoraMode) => void;
}

/** Shows the active workspace's model and LoRAs; click a LoRA to change how it is used. */
export function WorkspaceStrip({ workspace: ws, models, modes, onModeChange }: StripProps) {
  const byFile = new Map(models.map((m) => [m.file, m]));
  const fixed = ws.loras;
  const optional = ws.optionalLoras.filter((o) => !fixed.some((f) => f.file === o.file));
  const model = ws.pipeline === 'flux' ? ws.unet : ws.pipeline === 'custom' ? 'workflow customizado' : ws.checkpoint;

  return (
    <div className="ws-strip">
      <span className="ws-model" title={`${BASE_MODEL_PROFILES[ws.baseModel]?.label ?? ws.baseModel}\n${model ?? ''}`}>
        <span className="ws-model-label">{BASE_MODEL_PROFILES[ws.baseModel]?.label ?? ws.baseModel}</span>
        {shortName(model)}
      </span>
      {fixed.length + optional.length === 0 && <span className="muted small">sem LoRAs neste workspace</span>}
      {fixed.map((l) => {
        const mode = modes[l.file] === 'off' ? 'off' : 'on';
        const { title, warn } = describe(l, byFile.get(l.file), ws);
        return (
          <button
            key={l.file}
            className={`lora-chip fixed ${mode} ${warn ? 'warn' : ''}`}
            title={`${title}\n\nFixa no workspace. Clique para ${mode === 'off' ? 'religar' : 'desligar nas próximas gerações'}.`}
            onClick={() => onModeChange(l.file, mode === 'off' ? 'on' : 'off')}
          >
            {warn && <span aria-hidden>⚠ </span>}
            {shortName(l.file)} <span className="lora-strength">{l.strength}</span>
            <span className="lora-mode">{mode === 'off' ? 'desligada' : 'fixa'}</span>
          </button>
        );
      })}
      {optional.map((l) => {
        const mode: LoraMode = modes[l.file] ?? 'auto';
        const next: LoraMode = mode === 'auto' ? 'on' : mode === 'on' ? 'off' : 'auto';
        const { title, warn } = describe(l, byFile.get(l.file), ws);
        const label = { auto: 'auto', on: 'sempre', off: 'nunca' }[mode];
        const help = {
          auto: 'O LLM local decide quando usar.',
          on: 'Você forçou: entra em toda geração.',
          off: 'Você desligou: nunca entra.',
        }[mode];
        return (
          <button
            key={l.file}
            className={`lora-chip optional ${mode} ${warn ? 'warn' : ''}`}
            title={`${title}\n\n${help} Clique para "${{ auto: 'auto', on: 'sempre', off: 'nunca' }[next]}".`}
            onClick={() => onModeChange(l.file, next)}
          >
            {warn && <span aria-hidden>⚠ </span>}
            {shortName(l.file)} <span className="lora-strength">{l.strength}</span>
            <span className="lora-mode">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

const SOURCE_LABEL: Record<AppliedLora['source'], string> = {
  workspace: 'fixa',
  forced: 'você',
  auto: 'LLM',
};

const SOURCE_HELP: Record<AppliedLora['source'], string> = {
  workspace: 'Fixa no workspace',
  forced: 'Você forçou esta LoRA',
  auto: 'Escolhida pelo LLM local para este pedido',
};

/** LoRAs actually applied to one generation. */
export function AppliedLoraChips({ loras }: { loras: AppliedLora[] }) {
  if (!loras.length) return <span className="muted small">sem LoRAs</span>;
  return (
    <span className="applied-loras">
      {loras.map((l) => (
        <span key={l.file} className={`lora-chip applied ${l.source}`} title={`${l.file}\nforça ${l.strength}\n${SOURCE_HELP[l.source]}`}>
          {shortName(l.file)} <span className="lora-strength">{l.strength}</span>
          <span className="lora-mode">{SOURCE_LABEL[l.source]}</span>
        </span>
      ))}
    </span>
  );
}
