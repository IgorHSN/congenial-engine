import { useState } from 'react';
import type { DeepPartial, Effort, PublicSettings, SecretName, Settings } from '@shared/types';
import { api } from '../api';
import { McpSettings } from './McpPanel';

type Tab = 'comfy' | 'claude' | 'mcp' | 'llm' | 'sources' | 'generation';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recomendado)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (mais barato)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (o mais barato)' },
];

export function SettingsDialog({ settings, onClose }: { settings: PublicSettings; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('comfy');
  const [draft, setDraft] = useState<Settings>(() => structuredClone(stripSecrets(settings)));
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [detect, setDetect] = useState<string>('');
  const [llmTest, setLlmTest] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (p: DeepPartial<Settings>) =>
    setDraft((d) => {
      const next = structuredClone(d) as unknown as Record<string, Record<string, unknown>>;
      for (const [section, values] of Object.entries(p)) Object.assign(next[section], values);
      return next as unknown as Settings;
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.settings.update(draft);
      for (const [name, value] of Object.entries(secrets)) {
        if (value !== undefined) await api.settings.setSecret(name as SecretName, value);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const pickComfy = async () => {
    const dir = await api.settings.pickDirectory('Pasta do ComfyUI (a que contém main.py)');
    if (!dir) return;
    await applyComfyPath(dir);
  };

  const applyComfyPath = async (dir: string) => {
    const layout = await api.settings.detectComfy(dir);
    if (!layout) {
      setDetect('Pasta não encontrada.');
      patch({ comfy: { rootPath: dir } });
      return;
    }
    patch({ comfy: { rootPath: layout.root } });
    const kind = { portable: 'pacote portátil (Windows)', venv: 'instalação com venv', system: 'Python do sistema', unknown: '?' }[
      layout.kind as 'portable' | 'venv' | 'system' | 'unknown'
    ];
    setDetect(
      layout.hasMainPy
        ? `ComfyUI encontrado: ${kind}${layout.python ? ` · python: ${layout.python}` : ''}${layout.hasModels ? '' : ' · (pasta models/ ainda não existe)'}`
        : 'Não achei main.py nessa pasta. Se for o ComfyUI Desktop, informe só a URL e a pasta base (com models/).',
    );
  };

  const autoDetect = async () => {
    setDetect('Procurando…');
    const found = await api.settings.autoDetect();
    if (found.url) patch({ comfy: { url: found.url } });
    if (found.rootPath) {
      await applyComfyPath(found.rootPath);
      if (found.via === 'running-server') setDetect((d) => `Encontrado pelo ComfyUI em execução (${found.url}). ${d}`);
      else if (found.candidates.length > 1) setDetect((d) => `${d}\nOutras instalações: ${found.candidates.slice(1).join(' · ')}`);
    } else {
      setDetect(
        found.url
          ? `ComfyUI em execução em ${found.url}, mas não consegui descobrir a pasta. Escolha-a manualmente.`
          : 'Não encontrei o ComfyUI. Abra o ComfyUI e tente de novo, ou escolha a pasta manualmente.',
      );
    }
  };

  const testLlm = async () => {
    await api.settings.update({ localLlm: draft.localLlm });
    setLlmTest(await api.llm.test());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configurações</h2>
        </div>
        <nav className="tabs">
          {(
            [
              ['comfy', 'ComfyUI'],
              ['claude', 'Claude (API)'],
              ['mcp', 'Claude Desktop/Code'],
              ['llm', 'LLM local'],
              ['sources', 'Civitai / HF'],
              ['generation', 'Geração'],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="modal-body">
          {tab === 'comfy' && (
            <>
              <div className="row detect-row">
                <button className="btn" onClick={() => void autoDetect()}>
                  Detectar automaticamente
                </button>
                <span className="hint">Com o ComfyUI aberto, a detecção também acha pastas extras (extra_model_paths.yaml) e o ComfyUI Desktop.</span>
              </div>
              <Field label="URL do servidor" hint="Padrão do ComfyUI: http://127.0.0.1:8188 (ComfyUI Desktop usa :8000)">
                <input value={draft.comfy.url} onChange={(e) => patch({ comfy: { url: e.target.value } })} />
              </Field>
              <Field label="Pasta do ComfyUI" hint="A pasta com main.py, models/ e custom_nodes/. Os downloads vão para models/.">
                <div className="row">
                  <input
                    value={draft.comfy.rootPath}
                    onChange={(e) => patch({ comfy: { rootPath: e.target.value } })}
                    onBlur={(e) => e.target.value && void applyComfyPath(e.target.value)}
                  />
                  <button className="btn" onClick={() => void pickComfy()}>
                    Escolher…
                  </button>
                </div>
                {detect && <div className="small muted pre-line">{detect}</div>}
              </Field>
              <Field label="Python do ComfyUI" hint="Vazio = detectar automaticamente (python_embeded, .venv, venv). Usado para pip e para iniciar.">
                <input value={draft.comfy.pythonPath} onChange={(e) => patch({ comfy: { pythonPath: e.target.value } })} />
              </Field>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={draft.comfy.manageProcess}
                  onChange={(e) => patch({ comfy: { manageProcess: e.target.checked } })}
                />
                O app inicia/para o ComfyUI (permite reiniciar após instalar custom nodes)
              </label>
              {draft.comfy.manageProcess && (
                <>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={draft.comfy.autoStart}
                      onChange={(e) => patch({ comfy: { autoStart: e.target.checked } })}
                    />
                    Iniciar o ComfyUI quando o app abrir
                  </label>
                  <Field label="Argumentos extras" hint='Ex.: --lowvram, --use-sage-attention, --fast'>
                    <input value={draft.comfy.extraArgs} onChange={(e) => patch({ comfy: { extraArgs: e.target.value } })} />
                  </Field>
                </>
              )}
            </>
          )}

          {tab === 'claude' && (
            <>
              <p className="small muted">
                O chat de configuração deste app usa a API da Anthropic (pago por uso, separado da assinatura do claude.ai). Para usar a sua
                assinatura em vez disso, veja a aba <strong>Claude Desktop/Code</strong>.
              </p>
              <SecretField
                label="API key da Anthropic"
                hint="Crie em console.anthropic.com. Fica criptografada no seu computador. Usada só no chat de configuração."
                configured={settings.secrets.anthropicApiKey}
                value={secrets.anthropicApiKey}
                onChange={(v) => setSecrets((s) => ({ ...s, anthropicApiKey: v }))}
              />
              <Field label="Modelo">
                <select className="select" value={draft.claude.model} onChange={(e) => patch({ claude: { model: e.target.value } })}>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {!CLAUDE_MODELS.some((m) => m.id === draft.claude.model) && <option value={draft.claude.model}>{draft.claude.model}</option>}
                </select>
              </Field>
              <Field label="Esforço" hint="Mais esforço = respostas mais cuidadosas, mais lentas e mais caras.">
                <select
                  className="select"
                  value={draft.claude.effort}
                  onChange={(e) => patch({ claude: { effort: e.target.value as Effort } })}
                >
                  {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={draft.claude.autoApproveDownloads}
                  onChange={(e) => patch({ claude: { autoApproveDownloads: e.target.checked } })}
                />
                Aprovar downloads automaticamente (apagar arquivos, instalar nós e rodar comandos sempre pedem confirmação)
              </label>
            </>
          )}

          {tab === 'mcp' && (
            <McpSettings
              enabled={draft.mcp.enabled}
              onToggle={(v) => {
                patch({ mcp: { enabled: v } });
                void api.settings.update({ mcp: { enabled: v } });
              }}
            />
          )}

          {tab === 'llm' && (
            <>
              <p className="small muted">
                O chat de geração usa um LLM rodando no seu computador. Os pedidos de imagem não passam pela Anthropic. Recomendação: um modelo
                instruct sem censura de 3–12B (ex.: variantes "abliterated" ou Dolphin/Hermes) que caiba na VRAM junto com o ComfyUI.
              </p>
              <Field label="Servidor">
                <select
                  className="select"
                  value={draft.localLlm.provider}
                  onChange={(e) =>
                    patch({
                      localLlm: {
                        provider: e.target.value as 'ollama' | 'openai',
                        baseUrl: e.target.value === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1',
                      },
                    })
                  }
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai">Compatível com OpenAI (LM Studio, llama.cpp, KoboldCpp, vLLM…)</option>
                </select>
              </Field>
              <Field label="URL">
                <input value={draft.localLlm.baseUrl} onChange={(e) => patch({ localLlm: { baseUrl: e.target.value } })} />
              </Field>
              <Field label="Modelo">
                <div className="row">
                  {llmTest?.ok && llmTest.models.length > 0 ? (
                    <select className="select" value={draft.localLlm.model} onChange={(e) => patch({ localLlm: { model: e.target.value } })}>
                      <option value="">Escolha…</option>
                      {llmTest.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={draft.localLlm.model}
                      placeholder="ex.: llama3.1:8b"
                      onChange={(e) => patch({ localLlm: { model: e.target.value } })}
                    />
                  )}
                  <button className="btn" onClick={() => void testLlm()}>
                    Testar / listar
                  </button>
                </div>
                {llmTest && (
                  <div className={`small ${llmTest.ok ? 'muted' : 'error'}`}>
                    {llmTest.ok ? `Conectado · ${llmTest.models.length} modelo(s)` : llmTest.error}
                  </div>
                )}
              </Field>
              <Field label={`Temperatura: ${draft.localLlm.temperature.toFixed(2)}`}>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={draft.localLlm.temperature}
                  onChange={(e) => patch({ localLlm: { temperature: Number(e.target.value) } })}
                />
              </Field>
              {draft.localLlm.provider === 'ollama' && (
                <Field label="keep_alive" hint='"0" descarrega o LLM logo após refinar, liberando VRAM para o ComfyUI. Use "5m" se tiver VRAM sobrando.'>
                  <input value={draft.localLlm.keepAlive} onChange={(e) => patch({ localLlm: { keepAlive: e.target.value } })} />
                </Field>
              )}
            </>
          )}

          {tab === 'sources' && (
            <>
              <SecretField
                label="Token da Civitai"
                hint="civitai.com → Account settings → API Keys. Necessário para muitos downloads e para modelos com restrição de idade."
                configured={settings.secrets.civitaiToken}
                value={secrets.civitaiToken}
                onChange={(v) => setSecrets((s) => ({ ...s, civitaiToken: v }))}
              />
              <SecretField
                label="Token do Hugging Face"
                hint="huggingface.co → Settings → Access Tokens (leitura). Necessário para repositórios restritos, como o Flux dev."
                configured={settings.secrets.huggingfaceToken}
                value={secrets.huggingfaceToken}
                onChange={(v) => setSecrets((s) => ({ ...s, huggingfaceToken: v }))}
              />
            </>
          )}

          {tab === 'generation' && (
            <>
              <Field label="Pasta das imagens geradas">
                <div className="row">
                  <input value={draft.generation.outputDir} onChange={(e) => patch({ generation: { outputDir: e.target.value } })} />
                  <button
                    className="btn"
                    onClick={async () => {
                      const dir = await api.settings.pickDirectory('Pasta das imagens');
                      if (dir) patch({ generation: { outputDir: dir } });
                    }}
                  >
                    Escolher…
                  </button>
                </div>
              </Field>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={draft.generation.showRefinedPrompt}
                  onChange={(e) => patch({ generation: { showRefinedPrompt: e.target.checked } })}
                />
                Mostrar o prompt enviado em cada resultado
              </label>
            </>
          )}
        </div>

        <div className="modal-footer">
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

function stripSecrets(s: PublicSettings): Settings {
  const { secrets: _secrets, ...rest } = s;
  return rest;
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

function SecretField(props: {
  label: string;
  hint: string;
  configured: boolean;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      <div className="row">
        <input
          type="password"
          value={props.value ?? ''}
          placeholder={props.configured ? '•••••••• (configurado — digite para trocar)' : 'Cole aqui'}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete="off"
        />
        {props.configured && (
          <button className="btn ghost" onClick={() => props.onChange('')} title="Remover ao salvar">
            Remover
          </button>
        )}
      </div>
    </Field>
  );
}
