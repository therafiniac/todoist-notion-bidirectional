// Workers Free allows 50 subrequests (outbound fetches) per invocation.
// Every API call goes through this counter so a run stops cleanly before the cap
// and leaves remaining work for the next run.
export const DEFAULT_SUBREQUEST_LIMIT = 45;

export class SubrequestBudget {
  // The default wraps the global fetch: calling it as `this.fetchImpl(...)` would
  // bind `this` to the budget, which Workers rejects with "Illegal invocation".
  constructor(limit = DEFAULT_SUBREQUEST_LIMIT, fetchImpl = (url, init) => fetch(url, init)) {
    this.limit = limit;
    this.used = 0;
    this.fetchImpl = fetchImpl;
  }

  has(count) {
    return this.used + count <= this.limit;
  }

  async fetch(url, init) {
    if (!this.has(1)) {
      throw new Error('Subrequest budget exhausted');
    }
    this.used += 1;
    return this.fetchImpl(url, init);
  }
}
