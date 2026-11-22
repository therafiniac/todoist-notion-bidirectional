// Workers Free allows 50 subrequests (outbound fetches) per invocation.
// Every API call goes through this counter so a run stops cleanly before the cap
// and leaves remaining work for the next run.
export const DEFAULT_SUBREQUEST_LIMIT = 45;

export class SubrequestBudget {
  constructor(limit = DEFAULT_SUBREQUEST_LIMIT, fetchImpl = fetch) {
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
