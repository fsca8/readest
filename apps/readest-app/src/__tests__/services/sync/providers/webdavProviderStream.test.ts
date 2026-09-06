import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Streaming is Tauri-only: force the platform probe on so the provider attaches
// uploadStream/downloadStream, and stub the native transfer bridge so a test
// can make a transfer stall forever (the bridge never settling is exactly the
// failure mode that used to pin `isSyncing` indefinitely).
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

import { createWebDAVProvider } from '@/services/sync/providers/webdav/WebDAVProvider';
import * as transfer from '@/utils/transfer';

const SETTINGS = {
  enabled: true,
  serverUrl: 'https://dav.example.com',
  username: 'u',
  password: 'p',
  rootPath: '/webdav/readest',
};

describe('WebDAVProvider — transfer stall watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('uploadStream gives up when the native upload stalls (no bytes for the inactivity window)', async () => {
    vi.spyOn(transfer, 'tauriUpload').mockImplementation(
      () => new Promise<never>(() => {}), // bridge accepts the request, never settles
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = createWebDAVProvider(SETTINGS);
    let result: boolean | undefined;
    const run = provider.uploadStream!('/Readest/books/h/f.pdf', 'C:\\local\\f.pdf');
    run.then((r) => {
      result = r;
    });

    // Well before the watchdog fires the transfer is still considered in flight.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result).toBeUndefined();

    // Once the inactivity window elapses with zero bytes moved, the provider
    // must give up so the sync pass can end instead of hanging forever.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  test('downloadStream gives up when the native download stalls', async () => {
    vi.spyOn(transfer, 'tauriDownload').mockImplementation(() => new Promise<never>(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = createWebDAVProvider(SETTINGS);
    let result: boolean | undefined;
    const run = provider.downloadStream!('/Readest/books/h/f.pdf', 'C:\\local\\f.pdf', undefined);
    run.then((r) => {
      result = r;
    });

    await vi.advanceTimersByTimeAsync(100_000);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  test('uploadStream still succeeds when the bridge resolves inside the window', async () => {
    vi.spyOn(transfer, 'tauriUpload').mockResolvedValue('{"id":"NID"}');
    const provider = createWebDAVProvider(SETTINGS);
    await expect(
      provider.uploadStream!('/Readest/books/h/f.pdf', 'C:\\local\\f.pdf'),
    ).resolves.toBe(true);
  });

  test('a stalled transfer is eventually capped by the hard deadline even with progress', async () => {
    // A server that keeps a trickle of bytes alive forever must still not pin
    // the run past the hard cap.
    vi.spyOn(transfer, 'tauriUpload').mockImplementation(
      (_url, _path, _method, progressHandler?: transfer.ProgressHandler) =>
        new Promise<never>(() => {
          const tick = setInterval(() => {
            progressHandler?.({ progress: 1, total: 100, transferSpeed: 0 });
          }, 10_000);
          void tick;
        }),
    );
    const provider = createWebDAVProvider(SETTINGS);
    let result: boolean | undefined;
    const run = provider.uploadStream!('/Readest/books/h/f.pdf', 'C:\\local\\f.pdf');
    run.then((r) => {
      result = r;
    });

    // Trickle keeps the inactivity timer fed past the inactivity window…
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(result).toBeUndefined();

    // …but the hard deadline still applies.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(result).toBe(false);
  });
});
