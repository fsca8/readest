import { WebDAVSettings } from '@/types/settings';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriDownload, tauriUpload } from '@/utils/transfer';
import {
  FileEntry,
  FileHead,
  FileSyncError,
  FileSyncErrorCode,
  FileSyncProvider,
} from '@/services/sync/file/provider';
import {
  WebDAVConfig,
  WebDAVRequestError,
  buildBasicAuthHeader,
  buildRequestUrl,
  deleteDirectory,
  ensureDirectory,
  getFile,
  getFileBinary,
  headFile,
  listDirectory,
  normalizeRootPath,
  putFile,
  putFileBinary,
} from './client';

/**
 * WebDAV implementation of {@link FileSyncProvider} — the first concrete
 * backend for the provider-agnostic file-sync engine.
 *
 * Responsibilities unique to this layer:
 *   - own the WebDAV transport config (serverUrl + Basic-auth credentials);
 *   - translate the transport client's {@link WebDAVRequestError} into the
 *     engine's neutral {@link FileSyncError} so nothing above this file
 *     knows the backend is WebDAV;
 *   - own streaming upload/download (URL + auth + the Tauri-side
 *     `tauriUpload`/`tauriDownload`), keeping gigabyte-scale book payloads out
 *     of the JS heap. Streaming is exposed only on Tauri; on web the engine
 *     falls back to buffered {@link FileSyncProvider.writeBinary}/`readBinary`.
 */

const mapError = (e: unknown): FileSyncError => {
  if (e instanceof FileSyncError) return e;
  if (e instanceof WebDAVRequestError) {
    const code: FileSyncErrorCode =
      e.code === 'AUTH_FAILED'
        ? 'AUTH_FAILED'
        : e.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : e.code === 'NETWORK'
            ? 'NETWORK'
            : e.status === 409
              ? 'CONFLICT'
              : 'UNKNOWN';
    return new FileSyncError(e.message, code, e.status);
  }
  return new FileSyncError(e instanceof Error ? e.message : String(e), 'UNKNOWN');
};

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw mapError(e);
  }
};

/**
 * Streaming transfers (tauriUpload/tauriDownload) shell through a native
 * reqwest call that the JS side cannot abort and that historically had NO
 * timeout of its own: when the remote half-opens a connection and then stalls
 * (a flaky proxy/frp link accepting the request but never finishing it), the
 * bridge promise never settles — which pinned `isSyncing` true and the whole
 * sync pass forever (the engine pool awaits every worker).
 *
 * The native side now also carries its own timeouts as a backstop; this guard
 * is what frees the UI quickly:
 *   - an inactivity timer that resets on every progress byte, so a stalled
 *     transfer fails ~60s after the last byte instead of hanging;
 *   - a hard total deadline so a trickle that never ends cannot pin the pass.
 *
 * When a guard fires, the awaited promise REJECTS and the engine moves on
 * (the orphaned native request keeps running in the background and either
 * finishes — next run's HEAD probe then matches and skips it — or dies on the
 * native-side timeout). Failing a transfer is always safe: re-running the
 * pass is idempotent.
 */
const TRANSFER_INACTIVITY_TIMEOUT_MS = 60_000;
const TRANSFER_TOTAL_TIMEOUT_MS = 55 * 60_000;

const withStallGuard = <T>(label: string, run: (ping: () => void) => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (fn: () => void) => () => {
      if (settled) return;
      settled = true;
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      clearTimeout(totalTimer);
      fn();
    };

    const ping = () => {
      if (settled) return;
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        console.warn(
          `WebDAVProvider.${label} stalled (no progress for ${TRANSFER_INACTIVITY_TIMEOUT_MS / 1000}s); abandoning transfer`,
        );
        reject(new FileSyncError('Transfer stalled', 'NETWORK'));
      }, TRANSFER_INACTIVITY_TIMEOUT_MS);
    };

    const totalTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      console.warn(
        `WebDAVProvider.${label} exceeded ${TRANSFER_TOTAL_TIMEOUT_MS / 60_000}min hard deadline; abandoning transfer`,
      );
      reject(new FileSyncError('Transfer deadline exceeded', 'NETWORK'));
    }, TRANSFER_TOTAL_TIMEOUT_MS);

    ping(); // arm the inactivity timer before the first byte
    run(ping).then(
      (value) => settle(() => resolve(value))(),
      (e: unknown) => settle(() => reject(e))(),
    );
  });

export const createWebDAVProvider = (settings: WebDAVSettings): FileSyncProvider => {
  const config: WebDAVConfig = {
    serverUrl: settings.serverUrl,
    username: settings.username,
    password: settings.password,
  };

  const provider: FileSyncProvider = {
    rootPath: normalizeRootPath(settings.rootPath),
    readText: (path) => wrap(() => getFile(config, path)),
    readBinary: (path) => wrap(() => getFileBinary(config, path)),
    head: (path): Promise<FileHead | null> => wrap(() => headFile(config, path)),
    list: (path): Promise<FileEntry[]> => wrap(() => listDirectory(config, path)),
    writeText: (path, body, contentType) => wrap(() => putFile(config, path, body, contentType)),
    writeBinary: (path, body, contentType) =>
      wrap(() => putFileBinary(config, path, body, contentType)),
    ensureDir: (paths) => wrap(() => ensureDirectory(config, paths)),
    deleteDir: (path) => wrap(() => deleteDirectory(config, path)),
  };

  if (isTauriAppPlatform()) {
    const authHeaders = (): Record<string, string> => ({
      Authorization: buildBasicAuthHeader(settings.username, settings.password),
    });
    provider.uploadStream = async (remotePath, localPath) => {
      const url = buildRequestUrl(settings.serverUrl, remotePath);
      try {
        // tauriUpload's TS type says Map, but the Rust command accepts a JSON
        // object → HashMap<String, String>; pass the headers object directly.
        // The internal progress handler feeds the stall guard — the sync pass
        // must not hang forever on a half-open connection (see withStallGuard).
        await withStallGuard('uploadStream', (ping) =>
          tauriUpload(
            url,
            localPath,
            'PUT',
            () => ping(),
            authHeaders() as unknown as Map<string, string>,
          ),
        );
        return true;
      } catch (e) {
        console.warn('WebDAVProvider.uploadStream failed', remotePath, e);
        return false;
      }
    };
    provider.downloadStream = async (remotePath, localPath, onProgress) => {
      const url = buildRequestUrl(settings.serverUrl, remotePath);
      try {
        await withStallGuard('downloadStream', (ping) =>
          tauriDownload(
            url,
            localPath,
            onProgress
              ? (p) => {
                  ping();
                  onProgress(p);
                }
              : () => ping(),
            authHeaders(),
          ),
        );
        return true;
      } catch (e) {
        console.warn('WebDAVProvider.downloadStream failed', remotePath, e);
        return false;
      }
    };
  }

  return provider;
};
