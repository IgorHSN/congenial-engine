import { useEffect, useMemo, useState } from 'react';
import { BASE_MODEL_PROFILES, loraCompatible } from '@shared/presets';
import {
  BASE_MODELS,
  type BaseModel,
  type InstalledModel,
  type ModelFolder,
  type Pipeline,
  type SamplerDefaults,
  type SamplerOptions,
  type Workspace,
  type WorkspaceInput,
} from '@shared/types';
import { api } from '../api';
import { shortName } from './LoraChips';

interface LoraRow {
  file: string;
  strength: number;
  kind: 'fixed' | 'optional';
}

interface Form {
  name: string;
  description: string;
  baseModel: BaseModel;
  pipeline: Pipeline;
  checkpoint: string;
  unet: string;
  clip1: string;
  clip2: string;
  vae: string;
  loras: LoraRow[];
  defaults: SamplerDefaults;
  positivePrefix: string;
  negativePrompt: string;
  refinerNotes: string;
  customWorkflow: string;
}

function fromWorkspace(ws: Workspace): Form {
  return {
    name: ws.name,
    description: ws.description,
    baseModel: ws.baseModel,
    pipeline: ws.pipeline,
    checkpoint: ws.checkpoint ?? '',
    unet: ws.unet ?? '',
    clip1: ws.clip1 ?? '',
    clip2: ws.clip2 ?? '',
    vae: ws.vae ?? '',
    loras: [
      ...ws.loras.map((l) => ({ ...l, kind: 'fixed' as const })),
      ...ws.optionalLoras.filter((o) => !ws.loras.some((l) => l.file === o.file)).map((l) => ({ ...l, kind: 'optional' as const })),
    ],
    defaults: { ...ws.defaults },
    positivePrefix: ws.positivePrefix,
    negativePrompt: ws.negativePrompt,
    refinerNotes: ws.refinerNotes,
    customWorkflow: ws.customWorkflow ? JSON.stringify(ws.customWorkflow, null, 2) : '',
  };
}

function blank(base: BaseModel): Form {
  const p = BASE_MODEL_PROFILES[base];
  return {
    name: '',
    description: '',
    baseModel: base,
    pipeline: base === 'flux' ? 'flux' : 'checkpoint',
    checkpoint: '',
    unet: '',
    clip1: '',
    clip2: '',
    vae: '',
    loras: [],
    defaults: { ...p.defaults },
    positivePrefix: p.positivePrefix,
    negativePrompt: p.negativePrompt,
    refinerNotes: '',
    customWorkflow: '',
  };
}

interface Props {
  /** Workspace to edit; omit to create a new one. */
  workspace?: Workspace;
  onClose: () => void;
}

/** Create or edit a workspace by hand, from the files already installed. */
export function WorkspaceEditor({ workspace, onClose }: Props) {
  const [form, setForm] = useState<Form>(() => (workspace ? fromWorkspace(workspace) : blank('sdxl')));
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [opts, setOpts] = useState<SamplerOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = !workspace;

  useEffect(() => {
    void api.models.list().then(setModels);
    void api.comfy.samplerOptions().then(setOpts);
  }, []);

  const byFolder = useMemo(() => {
    const map = new Map<ModelFolder, InstalledModel[]>();
    for (const m of models) map.set(m.folder, [...(map.get(m.folder) ?? []), m]);
    return map;
  }, [models]);
  const filesIn = (...folders: ModelFolder[]) => folders.flatMap((f) => byFolder.get(f) ?? []);
  const loraMeta = (file: string) => byFolder.get('loras')?.find((m) => m.file === file);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setDefault = <K extends keyof SamplerDefaults>(key: K, value: SamplerDefaults[K]) =>
    setForm((f) => ({ ...f, defaults: { ...f.defaults, [key]: value } }));

  const applyFamilyDefaults = (base: BaseModel) => {
    const p = BASE_MODEL_PROFILES[base];
    setForm((f) => ({ ...f, baseModel: base, defaults: { ...p.defaults }, positivePrefix: p.positivePrefix, negativePrompt: p.negativePrompt }));
  };

  const changeBase = (base: BaseModel) => {
    // New workspaces follow the family's defaults; existing ones keep the user's values (button below applies them).
    if (isNew) applyFamilyDefaults(base);
    else set('baseModel', base);
  };

  const pickCheckpoint = (file: string) => {
    const meta = byFolder.get('checkpoints')?.find((m) => m.file === file)?.meta;
    setForm((f) => ({ ...f, checkpoint: file, name: f.name || shortName(file) }));
    if (isNew && meta?.baseModel && meta.baseModel !== form.baseModel) applyFamilyDefaults(meta.baseModel);
  };

  const save = async () => {
    setError(null);
    let customWorkflow: Record<string, unknown> | undefined;
    if (form.pipeline === 'custom') {
      try {
        customWorkflow = JSON.parse(form.customWorkflow) as Record<string, unknown>;
      } catch {
        setError('O workflow customizado não é um JSON válido.');
        return;
      }
    }
    const input: WorkspaceInput = {
      id: workspace?.id,
      name: form.name.trim() || 'Sem nome',
      description: form.description,
      baseModel: form.baseModel,
      pipeline: form.pipeline,
      // Empty string clears an optional file (e.g. back to the checkpoint's own VAE).
      checkpoint: form.pipeline === 'checkpoint' ? form.checkpoint : (workspace?.checkpoint ?? ''),
      unet: form.unet,
      clip1: form.clip1,
      clip2: form.clip2,
      vae: form.vae,
      loras: form.loras.filter((l) => l.file && l.kind === 'fixed').map(({ file, strength }) => ({ file, strength })),
      optionalLoras: form.loras.filter((l) => l.file && l.kind === 'optional').map(({ file, strength }) => ({ file, strength })),
      defaults: form.defaults,
      positivePrefix: form.positivePrefix,
      negativePrompt: form.negativePrompt,
      refinerNotes: form.refinerNotes,
      customWorkflow,
    };
    setSaving(true);
    try {
      await api.workspaces.save(input, isNew);
      onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!workspace || !confirm(`Apagar o workspace "${workspace.name}"? Os arquivos de modelo não são apagados.`)) return;
    await api.workspaces.remove(workspace.id);
    onClose();
  };

  const isFlux = form.baseModel === 'flux' || form.pipeline === 'flux';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isNew ? 'Novo workspace' : `Editar workspace · ${workspace.name}`}</h2>
        </div>
        <div className="modal-body">
          {models.length === 0 && (
            <div className="callout subtle small">
              Nenhum modelo encontrado. Confira a pasta do ComfyUI em Configurações → ComfyUI (ou peça ao Claude para instalar um checkpoint).
            </div>
          )}

          <div className="grid2">
            <Field label="Nome">
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="ex.: Realista SDXL" />
            </Field>
            <Field label="Modelo base" hint="Define o estilo de prompt do LLM local e os padrões de resolução/sampler.">
              <div className="row">
                <select className="select" value={form.baseModel} onChange={(e) => changeBase(e.target.value as BaseModel)}>
                  {BASE_MODELS.map((b) => (
                    <option key={b} value={b}>
                      {BASE_MODEL_PROFILES[b].label}
                    </option>
                  ))}
                </select>
                {!isNew && (
                  <button className="btn small" onClick={() => applyFamilyDefaults(form.baseModel)} title="Resolução, sampler, prefixo e negativo padrão desta família">
                    Usar padrões
                  </button>
                )}
              </div>
            </Field>
          </div>

          <Field label="Tipo">
            <div className="segmented">
              {(
                [
                  ['checkpoint', 'Checkpoint único'],
                  ['flux', 'Flux (arquivos separados)'],
                  ['custom', 'Workflow próprio (JSON)'],
                ] as Array<[Pipeline, string]>
              ).map(([p, label]) => (
                <button key={p} className={`seg ${form.pipeline === p ? 'active' : ''}`} onClick={() => set('pipeline', p)}>
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {form.pipeline === 'checkpoint' && (
            <div className="grid2">
              <Field label="Checkpoint">
                <FileSelect value={form.checkpoint} options={filesIn('checkpoints')} onChange={pickCheckpoint} required showBase />
              </Field>
              <Field label="VAE" hint="Opcional: a maioria dos checkpoints já traz o VAE.">
                <FileSelect value={form.vae} options={filesIn('vae')} onChange={(v) => set('vae', v)} emptyLabel="(do checkpoint)" />
              </Field>
            </div>
          )}

          {form.pipeline === 'flux' && (
            <div className="grid2">
              <Field label="Modelo de difusão (unet / diffusion_models)">
                <FileSelect value={form.unet} options={filesIn('unet', 'diffusion_models')} onChange={(v) => set('unet', v)} required />
              </Field>
              <Field label="VAE (ex.: ae.safetensors)">
                <FileSelect value={form.vae} options={filesIn('vae')} onChange={(v) => set('vae', v)} required />
              </Field>
              <Field label="Text encoder 1 (ex.: clip_l)">
                <FileSelect value={form.clip1} options={filesIn('clip', 'text_encoders')} onChange={(v) => set('clip1', v)} required />
              </Field>
              <Field label="Text encoder 2 (ex.: t5xxl)">
                <FileSelect value={form.clip2} options={filesIn('clip', 'text_encoders')} onChange={(v) => set('clip2', v)} required />
              </Field>
            </div>
          )}

          {form.pipeline === 'custom' && (
            <Field
              label="Workflow (formato API do ComfyUI)"
              hint="No ComfyUI: Workflow → Export (API). Troque os valores por {{positive}}, {{negative}}, {{seed}}, {{width}}, {{height}}, {{steps}}, {{cfg}}, {{batch_size}}, {{sampler}}, {{scheduler}}."
            >
              <textarea className="mono" rows={8} value={form.customWorkflow} onChange={(e) => set('customWorkflow', e.target.value)} />
            </Field>
          )}

          <Field label="LoRAs" hint="Fixa = entra em toda geração. Opcional = o LLM local usa quando o pedido combinar (e você pode forçar no chat).">
            <div className="lora-rows">
              {form.loras.map((row, i) => {
                const meta = loraMeta(row.file);
                const compat = loraCompatible(meta?.meta.baseModel, form.baseModel);
                const update = (patch: Partial<LoraRow>) =>
                  set(
                    'loras',
                    form.loras.map((r, j) => (j === i ? { ...r, ...patch } : r)),
                  );
                return (
                  <div key={i} className="lora-row">
                    <FileSelect
                      value={row.file}
                      options={filesIn('loras')}
                      onChange={(file) => update({ file, strength: loraMeta(file)?.meta.recommendedStrength ?? row.strength })}
                      showBase
                      wsBase={form.baseModel}
                    />
                    <input
                      type="number"
                      step={0.05}
                      min={-2}
                      max={2}
                      value={row.strength}
                      onChange={(e) => update({ strength: Number(e.target.value) })}
                      title="Força"
                      className="num"
                    />
                    <select className="select" value={row.kind} onChange={(e) => update({ kind: e.target.value as LoraRow['kind'] })}>
                      <option value="fixed">Fixa</option>
                      <option value="optional">Opcional</option>
                    </select>
                    <button className="btn ghost small" onClick={() => set('loras', form.loras.filter((_, j) => j !== i))} title="Remover">
                      ✕
                    </button>
                    {(meta?.meta.triggerWords?.length || compat === 'no') && (
                      <div className="lora-row-info small">
                        {compat === 'no' && <span className="error">⚠ feita para {BASE_MODEL_PROFILES[meta!.meta.baseModel!]?.label}. </span>}
                        {meta?.meta.triggerWords?.length ? <span className="muted">gatilhos: {meta.meta.triggerWords.slice(0, 6).join(', ')}</span> : null}
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                className="btn small"
                onClick={() => set('loras', [...form.loras, { file: '', strength: 0.8, kind: 'optional' }])}
                disabled={!filesIn('loras').length}
              >
                + Adicionar LoRA
              </button>
            </div>
          </Field>

          <Field label="Geração">
            <div className="grid-defaults">
              <Num label="Largura" value={form.defaults.width} step={64} onChange={(v) => setDefault('width', v)} />
              <Num label="Altura" value={form.defaults.height} step={64} onChange={(v) => setDefault('height', v)} />
              <Num label="Steps" value={form.defaults.steps} onChange={(v) => setDefault('steps', v)} />
              <Num label="CFG" value={form.defaults.cfg} step={0.5} onChange={(v) => setDefault('cfg', v)} />
              <label className="mini">
                Sampler
                <ListSelect value={form.defaults.sampler} options={opts?.samplers ?? []} onChange={(v) => setDefault('sampler', v)} />
              </label>
              <label className="mini">
                Scheduler
                <ListSelect value={form.defaults.scheduler} options={opts?.schedulers ?? []} onChange={(v) => setDefault('scheduler', v)} />
              </label>
              {!isFlux && <Num label="Clip skip" value={form.defaults.clipSkip} min={1} max={4} onChange={(v) => setDefault('clipSkip', v)} />}
              {isFlux && <Num label="Guidance" value={form.defaults.guidance} step={0.5} onChange={(v) => setDefault('guidance', v)} />}
              <Num label="Imagens" value={form.defaults.batchSize} min={1} max={8} onChange={(v) => setDefault('batchSize', v)} />
            </div>
          </Field>

          <Field label="Prefixo do prompt" hint="Sempre colocado no começo (ex.: tags de qualidade do Pony/Illustrious).">
            <input value={form.positivePrefix} onChange={(e) => set('positivePrefix', e.target.value)} />
          </Field>
          {BASE_MODEL_PROFILES[form.baseModel].usesNegative && (
            <Field label="Prompt negativo padrão">
              <textarea rows={2} value={form.negativePrompt} onChange={(e) => set('negativePrompt', e.target.value)} />
            </Field>
          )}
          <Field label="Notas de estilo para o LLM local" hint='Em inglês funciona melhor. Ex.: "photorealistic, 35mm film look, natural skin, soft light".'>
            <textarea rows={2} value={form.refinerNotes} onChange={(e) => set('refinerNotes', e.target.value)} />
          </Field>

          {error && <div className="notice error">{error}</div>}
        </div>
        <div className="modal-footer">
          {!isNew && (
            <button className="btn danger" onClick={() => void remove()} style={{ marginRight: 'auto' }}>
              Apagar
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Num(props: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="mini">
      {props.label}
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function ListSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const list = options.includes(value) || !value ? options : [value, ...options];
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function FileSelect(props: {
  value: string;
  options: InstalledModel[];
  onChange: (file: string) => void;
  required?: boolean;
  emptyLabel?: string;
  showBase?: boolean;
  wsBase?: BaseModel;
}) {
  const known = props.options.some((o) => o.file === props.value);
  return (
    <select className="select" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.emptyLabel ?? (props.required ? 'Escolha…' : '(nenhum)')}</option>
      {props.value && !known && <option value={props.value}>⚠ {props.value} (não encontrado)</option>}
      {props.options.map((o) => {
        const base = o.meta.baseModel;
        const warn = props.wsBase && loraCompatible(base, props.wsBase) === 'no' ? '⚠ ' : '';
        return (
          <option key={`${o.folder}/${o.file}`} value={o.file}>
            {warn}
            {o.file}
            {props.showBase && base ? ` · ${BASE_MODEL_PROFILES[base]?.label ?? base}` : ''}
          </option>
        );
      })}
    </select>
  );
}
