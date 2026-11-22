// Sends a request through the subrequest budget and throws on non-2xx responses.
export async function requestJson(budget, url, init, label) {
  const response = await budget.fetch(url, init);

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
