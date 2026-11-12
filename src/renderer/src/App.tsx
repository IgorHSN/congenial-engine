import { useEffect, useState } from 'react';
import { ConfigChat } from './components/ConfigChat';
import { GenerateChat } from './components/GenerateChat';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { useComfyStatus, useDownloads, useSettings, useWorkspaces } from './hooks/useAppState';

export default function App() {
  const [settings] = useSettings();
  const status = useComfyStatus();
  const workspaces = useWorkspaces();
  const downloads = useDownloads();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [firstRunChecked, setFirstRunChecked] = useState(false);

  // First run: open settings when nothing is configured yet.
  useEffect(() => {
    if (!settings || firstRunChecked) return;
    setFirstRunChecked(true);
    if (!settings.secrets.anthropicApiKey && !settings.comfy.rootPath) setSettingsOpen(true);
  }, [settings, firstRunChecked]);

  if (!settings) return <div className="loading">Carregando…</div>;

  return (
    <div className="app">
      <TopBar
        settings={settings}
        status={status}
        workspaces={workspaces}
        downloads={downloads}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="panes">
        <section className="pane">
          <ConfigChat settings={settings} onOpenSettings={() => setSettingsOpen(true)} />
        </section>
        <div className="divider" />
        <section className="pane">
          <GenerateChat settings={settings} workspaces={workspaces} onOpenSettings={() => setSettingsOpen(true)} />
        </section>
      </main>
      {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
