// Failover JSON-RPC client. Reads endpoints from window.CHAIN_RPCS[chainId].
// Tries each URL in order; advances on HTTP error, JSON-RPC error, or timeout.
// Exposes window.rpcCall (single call) and window.rpcBatch (array of calls in
// one HTTP body). Both return { providerUrl, latencyMs, ... } so the UI can
// show which provider answered and how long it took.

(function () {
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  async function postJson(url, body, timeoutMs) {
    const start = nowMs();
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        mode: 'cors',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return { json: json, latencyMs: Math.round(nowMs() - start) };
    } finally {
      clearTimeout(timer);
    }
  }

  function urlsFor(chainId) {
    const map = window.CHAIN_RPCS || {};
    const list = map[chainId] || map[String(chainId)] || [];
    if (!list.length) throw new Error('no RPCs configured for chain ' + chainId);
    return list;
  }

  async function rpcCall(chainId, method, params, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 5000;
    const urls = urlsFor(chainId);
    const body = { jsonrpc: '2.0', id: 1, method: method, params: params || [] };
    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await postJson(url, body, timeoutMs);
        if (r.json && r.json.error) {
          throw new Error('rpc error: ' + (r.json.error.message || JSON.stringify(r.json.error)));
        }
        return { result: r.json.result, providerUrl: url, latencyMs: r.latencyMs };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('all RPCs failed: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
  }

  // Public providers cap batches at very different sizes (drpc free tier: 3,
  // mainnet.base.org: 10, 1rpc/llamarpc: 12+). Chunk to the lowest common
  // denominator so a single rpcBatch call works on any provider.
  const BATCH_CHUNK = 3;

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // Per-call JSON-RPC errors (e.g. `execution reverted`) are deterministic
  // chain state — every provider will return the same error. So we surface
  // them to the caller as `{ __rpcError }` markers in the results array
  // instead of advancing to the next provider. Only HTTP / network errors
  // (postJson throwing or non-array body) are fatal-for-this-provider.
  async function sendChunk(url, calls, baseId, timeoutMs) {
    const body = calls.map(function (c, i) {
      return { jsonrpc: '2.0', id: baseId + i, method: c.method, params: c.params || [] };
    });
    const r = await postJson(url, body, timeoutMs);
    if (!Array.isArray(r.json)) {
      // Top-level JSON-RPC error (e.g. malformed batch, auth) -> try next provider.
      if (r.json && r.json.error) {
        throw new Error('rpc top-level error: ' + (r.json.error.message || JSON.stringify(r.json.error)));
      }
      throw new Error('expected JSON-RPC batch response, got object');
    }
    const results = {};
    for (const item of r.json) {
      if (typeof item.id !== 'number') continue;
      if (item.error) {
        results[item.id] = { __rpcError: item.error };
      } else {
        results[item.id] = item.result;
      }
    }
    return { results: results, latencyMs: r.latencyMs };
  }

  async function rpcBatch(chainId, calls, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 8000;
    const chunkSize = opts.chunkSize || BATCH_CHUNK;
    const urls = urlsFor(chainId);
    const chunks = chunk(calls.map(function (c, i) { return { call: c, originalIdx: i }; }), chunkSize);

    let lastErr = null;
    for (const url of urls) {
      try {
        const out = new Array(calls.length);
        let totalLatency = 0;
        for (const ck of chunks) {
          const ckCalls = ck.map(function (x) { return x.call; });
          const baseId = ck[0].originalIdx;
          const r = await sendChunk(url, ckCalls, baseId, timeoutMs);
          totalLatency += r.latencyMs;
          for (const x of ck) {
            const v = r.results[x.originalIdx];
            if (v === undefined) throw new Error('missing result for batch index ' + x.originalIdx);
            out[x.originalIdx] = v;
          }
        }
        return { results: out, providerUrl: url, latencyMs: totalLatency };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('all RPCs failed for batch: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
  }

  window.rpcCall = rpcCall;
  window.rpcBatch = rpcBatch;
})();
