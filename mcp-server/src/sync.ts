import { createClient, type Client } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SyncConfig {
  enabled: boolean;
  provider: "turso";
  url: string;
  token: string;
  syncInterval?: number;
}

let syncClient: Client | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Load sync config from .team11/config.json.
 * Returns null if sync is disabled or config is missing/invalid.
 */
export function loadSyncConfig(projectRoot: string): SyncConfig | null {
  const configPath = join(projectRoot, ".team11", "config.json");
  if (!existsSync(configPath)) return null;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config.sync || !config.sync.enabled) return null;
    const syncConfig = config.sync as SyncConfig;
    // Allow env var override for token (more secure than config file)
    if (!syncConfig.token && process.env.TURSO_AUTH_TOKEN) {
      syncConfig.token = process.env.TURSO_AUTH_TOKEN;
    }
    return syncConfig;
  } catch {
    return null;
  }
}

/**
 * Initialize Turso embedded replica.
 *
 * Uses @libsql/client in embedded replica mode: a local SQLite file that
 * syncs to a Turso cloud primary. better-sqlite3 continues to handle all
 * reads/writes against the same file; this client only drives sync().
 *
 * Returns the Client on success, null on failure (local-only fallback).
 */
export async function initSync(
  dbPath: string,
  syncConfig: SyncConfig,
): Promise<Client | null> {
  if (!syncConfig.enabled || !syncConfig.url || !syncConfig.token) {
    console.error(
      "[team11-memory] Sync disabled or incomplete config. Running local-only.",
    );
    return null;
  }

  try {
    syncClient = createClient({
      url: `file:${dbPath}`,
      syncUrl: syncConfig.url,
      authToken: syncConfig.token,
    });

    // Initial sync -- pull remote state
    await syncClient.sync();
    console.error(`[team11-memory] Turso sync connected: ${syncConfig.url}`);
    console.error(
      `[team11-memory] Sync interval: ${syncConfig.syncInterval || 60}s`,
    );

    // Periodic background sync
    const intervalMs = (syncConfig.syncInterval || 60) * 1000;
    syncTimer = setInterval(async () => {
      try {
        await syncClient?.sync();
      } catch (err) {
        console.error("[team11-memory] Sync error (will retry):", err);
      }
    }, intervalMs);

    return syncClient;
  } catch (err) {
    console.error(
      "[team11-memory] Failed to initialize Turso sync. Running local-only.",
      err,
    );
    syncClient = null;
    return null;
  }
}

/**
 * Force an immediate sync (call after writes to push changes promptly).
 */
export async function forceSync(): Promise<void> {
  if (!syncClient) return;
  try {
    await syncClient.sync();
  } catch (err) {
    console.error("[team11-memory] Force sync failed:", err);
  }
}

/**
 * Shut down sync cleanly -- clear the timer and close the client.
 */
export function shutdownSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (syncClient) {
    syncClient.close();
    syncClient = null;
  }
}

/**
 * Check whether Turso sync is currently active.
 */
export function isSyncActive(): boolean {
  return syncClient !== null;
}
