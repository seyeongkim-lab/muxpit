import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const useCliInstaller = () => {
  const [status, setStatus] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const install = useCallback(async () => {
    setInstalling(true);
    setStatus(null);
    try {
      const path = await invoke<string>("install_cli_symlink");
      setStatus(`Installed at ${path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  }, []);

  return { install, installing, status };
};
