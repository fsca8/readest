import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The metadata deadline must settle the caller even when the underlying fetch
// ignores the abort — on desktop the fetch is tauri-plugin-http (native
// reqwest), which cannot reliably be cancelled mid-flight. A half-open server
// connection used to leave these promises pending forever and pin the sync
// pass; the deadline is raced, not just aborted.
import { headFile, type WebDAVConfig } from '@/services/sync/providers/webdav/client';

const CONFIG: WebDAVConfig = {
  serverUrl: 'https://dav.example.com',
  username: 'u',
  password: 'p',
};

describe('WebDAV client — hard request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('a request that never settles (abort ignored) still fails at the 5s metadata deadline', async () => {
    // fetch accepts the request and NEVER settles — not even when its
    // AbortSignal fires (plugin-http behaviour on desktop).
    const neverSettles = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', neverSettles);

    let err: unknown;
    headFile(CONFIG, '/Readest/library.json').catch((e) => {
      err = e;
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(err).toBeUndefined(); // still in flight before the deadline

    await vi.advanceTimersByTimeAsync(2_000);
    expect(err).toBeDefined();
    expect(err).toMatchObject({ code: 'NETWORK' });
    expect((err as Error).message).toMatch(/timed out/i);
    // The abort was still signalled as a best-effort cancel of the orphan.
    expect(neverSettles.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  test('an early failure still surfaces with its own error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom'))),
    );
    await expect(headFile(CONFIG, '/Readest/library.json')).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  test('a fast success is unaffected by the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { 'content-length': '42', etag: '"abc"' },
          }),
        ),
      ),
    );
    await expect(headFile(CONFIG, '/Readest/library.json')).resolves.toEqual({
      size: 42,
      etag: '"abc"',
    });
  });
});
