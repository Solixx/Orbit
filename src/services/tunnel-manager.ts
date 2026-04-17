import ngrok from "@ngrok/ngrok";
import { config } from "../config.js";

interface ActiveTunnel {
  url: string;
  port: number;
  listener: ngrok.Listener;
}

let activeTunnel: ActiveTunnel | null = null;

export function getTunnel(): ActiveTunnel | null {
  return activeTunnel;
}

export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel) {
    await stopTunnel();
  }

  const listener = await ngrok.forward({
    addr: port,
    authtoken: config.ngrok.authtoken || undefined,
    authtoken_from_env: !config.ngrok.authtoken,
  });

  const url = listener.url();
  if (!url) throw new Error("ngrok returned no URL");

  activeTunnel = { url, port, listener };
  return url;
}

export async function stopTunnel(): Promise<boolean> {
  if (!activeTunnel) return false;
  try {
    await activeTunnel.listener.close();
  } catch {
    // already closed
  }
  activeTunnel = null;
  return true;
}
