const MAX_RETRY_WAIT_MS = 5000;
const DEFAULT_RETRY_WAIT_MS = 1000;

// Overridable in tests.
export const timing = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function retryDelayMs(response) {
  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_WAIT_MS;
  return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
}

// Sends a request through the subrequest budget and throws on non-2xx responses.
// A 429 (rate limited) is retried once after Retry-After, if the budget allows.
export async function requestJson(budget, url, init, label) {
  let response = await budget.fetch(url, init);

  if (response.status === 429 && budget.has(1)) {
    await response.body?.cancel();
    await timing.sleep(retryDelayMs(response));
    response = await budget.fetch(url, init);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${label} ${init.method || 'GET'} ${new URL(url).pathname} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
