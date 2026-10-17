// Sheets calls ride exponential backoff on transient upstream failures —
// Google's 503 "The service is currently unavailable" was killing movement
// firings on the first hiccup (prod report, 2026-07-06). 5xx/429/network
// errors retry with jitter; 4xx and success return immediately.

import { sheetsFetchWithRetry } from '../api_client';

const fetchMock = jest.fn();
global.fetch = fetchMock as never;

const response = (status: number, body = '{}') =>
  new Response(body, { status: status === 204 ? 204 : status });

beforeEach(() => fetchMock.mockReset());

const fast = { startingDelay: 1 };

describe('sheetsFetchWithRetry', () => {
  it('retries a 503 and returns the eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(response(503, '{"error":{"code":503}}'))
      .mockResolvedValueOnce(response(503, '{"error":{"code":503}}'))
      .mockResolvedValueOnce(response(200, '{"ok":true}'));
    const res = await sheetsFetchWithRetry('https://x/v4/spreadsheets/s', undefined, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 429 (quota) the same way', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, 'rate limited'))
      .mockResolvedValueOnce(response(200, '{}'));
    const res = await sheetsFetchWithRetry('https://x', undefined, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx — the caller owns that handling', async () => {
    fetchMock.mockResolvedValueOnce(response(404, 'not found'));
    const res = await sheetsFetchWithRetry('https://x', undefined, fast);
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the transient error with status + body once attempts are spent', async () => {
    // A fresh Response per attempt — a body can only be read once.
    fetchMock.mockImplementation(async () => response(503, '{"error":{"status":"UNAVAILABLE"}}'));
    await expect(
      sheetsFetchWithRetry('https://x', undefined, { ...fast, numOfAttempts: 3 }),
    ).rejects.toThrow(/Google Sheets 503 .*UNAVAILABLE/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries network-level failures (fetch TypeError)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response(200, '{}'));
    const res = await sheetsFetchWithRetry('https://x', undefined, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
