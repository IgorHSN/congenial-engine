import { useEffect, useState } from 'react';
import type { ComfyStatus, DownloadInfo, PublicSettings, Workspace } from '@shared/types';
import { api } from '../api';

export function useSettings(): [PublicSettings | null, (s: PublicSettings) => void] {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  useEffect(() => {
    void api.settings.get().then(setSettings);
    return api.settings.onChange(setSettings);
  }, []);
  return [settings, setSettings];
}

export function useComfyStatus(): ComfyStatus | null {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  useEffect(() => {
    void api.comfy.status().then(setStatus);
    return api.comfy.onStatus(setStatus);
  }, []);
  return status;
}

export function useWorkspaces(): Workspace[] {
  const [items, setItems] = useState<Workspace[]>([]);
  useEffect(() => {
    void api.workspaces.list().then(setItems);
    return api.workspaces.onChange(setItems);
  }, []);
  return items;
}

export function useDownloads(): DownloadInfo[] {
  const [items, setItems] = useState<DownloadInfo[]>([]);
  useEffect(() => {
    void api.downloads.list().then(setItems);
    return api.downloads.onChange(setItems);
  }, []);
  return items;
}
