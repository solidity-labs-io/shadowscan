const $ = function (sel) { return document.querySelector(sel); };

let activeChainId = null;
let activeView = null;
let knownChains = [];
let lastHealth = null;
let refreshRequestSeq = 0;

// UI state that survives the 30 s auto-refresh re-render.
const expandedLists = new Set();
let operatorDetailsOpen = false;

const DEFAULT_CHAIN_ID = 8453;
const LIST_PREVIEW = 10;

const HEALTH_LABELS = { live: 'Live', degraded: 'Degraded', offline: 'Offline' };

function setHealth(state, detail) {
  const pill = $('#health');
  pill.className = 'pill pill-' + state;
  pill.textContent = HEALTH_LABELS[state];
  if (detail) pill.title = detail;
  else pill.removeAttribute('title');
}

function healthDetail(health) {
  if (!health) return '';
  const parts = [];
  if (health.lag_blocks != null) parts.push('Indexer lag ' + fmtNum(health.lag_blocks) + ' blocks');
  if (health.last_indexed_at) parts.push('last indexed ' + relTime(health.last_indexed_at));
  return parts.join(' · ');
}

function readChainFromUrl() {
  const params = new URLSearchParams(location.search);
  const v = params.get('chain');
  if (!v || !/^\d+$/.test(v)) return null;
  const id = Number(v);
  return Number.isSafeInteger(id) ? id : null;
}

function setChainInUrl(id, opts) {
  const params = new URLSearchParams(location.search);
  params.set('chain', id);
  const method = opts && opts.replace ? 'replaceState' : 'pushState';
  history[method]({}, '', location.pathname + '?' + params.toString() + location.hash);
}

function resolveChainSelection(chains) {
  const urlChain = readChainFromUrl();
  if (urlChain != null && chains.some(function (c) { return c.chain_id === urlChain; })) {
    return { chainId: urlChain, shouldReplace: false };
  }
  const base = chains.find(function (c) { return c.chain_id === DEFAULT_CHAIN_ID; });
  return {
    chainId: base ? base.chain_id : chains[0].chain_id,
    shouldReplace: true,
  };
}

function isCurrentRefresh(requestId, chainId) {
  return requestId === refreshRequestSeq && chainId === activeChainId;
}

function safeDetailHref(addr, chainId) {
  const params = new URLSearchParams();
  params.set('addr', addr);
  if (chainId != null) params.set('chain', chainId);
  return 'safe.html?' + params.toString();
}

function bindSearch() {
  const form = $('#search');
  const input = $('#safe-search');
  const errSpan = $('#search-err');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!isAddress(input.value)) {
      errSpan.textContent = ADDR_ERROR;
      return;
    }
    errSpan.textContent = '';
    location.href = safeDetailHref(input.value.trim().toLowerCase());
  });
}

// Before chains load the tabs are placeholder chips; afterwards the real tabs
// stay visible while the panel below shows a loading skeleton.
function renderSkeleton(chainId) {
  preserveFocus(function () { renderSkeletonNow(chainId); });
}

function renderSkeletonNow(chainId) {
  const root = $('#dashboard');
  root.innerHTML = '';
  root.appendChild(knownChains.length
    ? renderTabs()
    : el('div', { class: 'tabs skeleton-tabs' }, [
        el('div', { class: 'skeleton-chip' }),
        el('div', { class: 'skeleton-chip' }),
      ]));
  root.appendChild(el('div', { id: 'chain-content', 'aria-busy': 'true' }, [
    el('section', { class: 'card progress skeleton-card' }, [
      el('div', { class: 'loading-row' }, [
        el('span', { class: 'spinner', 'aria-hidden': 'true' }),
        el('span', null, chainId != null ? 'Loading ' + chainName(chainId) : 'Loading scanner data'),
      ]),
      el('div', { class: 'skeleton-line skeleton-title' }),
      el('div', { class: 'skeleton-line' }),
      el('div', { class: 'skeleton-line short' }),
    ]),
    el('section', { class: 'tiles' }, [
      skeletonTile(),
      skeletonTile(),
      skeletonTile(),
      skeletonTile(),
    ]),
  ]));
}

function skeletonTile() {
  return el('div', { class: 'tile skeleton-tile' }, [
    el('div', { class: 'skeleton-line short' }),
    el('div', { class: 'skeleton-line value-line' }),
  ]);
}

async function loadHealth() {
  try {
    lastHealth = await api('/healthz');
  } catch (_) {
    lastHealth = null;
  }
}

async function loadHealthBestEffort() {
  await Promise.race([
    loadHealth(),
    new Promise(function (resolve) { setTimeout(resolve, 1200); }),
  ]);
}

function healthFor(chainId) {
  if (!lastHealth || !Array.isArray(lastHealth.chains)) return null;
  return lastHealth.chains.find(function (row) { return row.chain_id === chainId; }) || null;
}

async function fetchDashboardData(chainId) {
  const [status, scanCursor, eliminatorQueue, flagged, uninitialized, recent] =
    await Promise.all([
      settled(fetchDashboardStatus(chainId)),
      settled(api('/api/scan-cursor', chainId)),
      settled(api('/api/eliminator-status', chainId)),
      settled(api('/api/safes?status=shadow_detected&limit=25', chainId)),
      settled(api('/api/safes?status=uninitialized&limit=25', chainId)),
      settled(api('/api/safes?limit=10', chainId)),
    ]);
  return {
    chain_id: chainId,
    health: healthFor(chainId),
    status,
    scanCursor,
    eliminatorQueue,
    flagged,
    uninitialized,
    recent,
  };
}

function settled(promise) {
  return promise
    .then(function (value) { return { ok: true, value: value }; })
    .catch(function (error) { return { ok: false, error: error }; });
}

async function fetchDashboardStatus(chainId) {
  try {
    const s = await api('/api/chain-status', chainId);
    return normalizeChainStatus(s);
  } catch (_) {
    const s = await api('/api/stats', chainId);
    return normalizeStatsStatus(s);
  }
}

function normalizeChainStatus(s) {
  const safeVersions = normalizeSafeVersions(s.safe_versions);
  return {
    chain_id: s.chain_id,
    safe_versions: safeVersions,
    indexer: normalizeIndexer(s.indexer || {}, safeVersions),
    reviewer: s.reviewer || {},
    eliminator: s.eliminator || {},
  };
}

function normalizeStatsStatus(s) {
  const safeVersions = normalizeSafeVersions(s.safe_versions);
  return {
    chain_id: s.chain_id,
    safe_versions: safeVersions,
    indexer: normalizeIndexer({}, safeVersions),
    reviewer: {
      total_safes: s.total_safes,
      reviewed_safes: s.reviewed_safes,
      flagged_safes: s.flagged_safes,
      clean_safes: s.clean_safes,
      needs_investigation: s.needs_investigation,
      uninitialized_safes: s.uninitialized_safes,
      errored_safes: s.errored_safes,
    },
    eliminator: {
      pending: s.flagged_safes,
      retry_ready: 0,
      deferred: 0,
      cleared: 0,
      confirmed_shadow: 0,
      errored: 0,
      total_eliminated: 0,
    },
  };
}

function normalizeSafeVersions(versions) {
  if (!Array.isArray(versions)) return [];
  return versions.map(function (v) {
    return {
      version: v.version,
      factory_address: v.factory_address,
      factory_birth_block: v.factory_birth_block,
      last_scanned_block: v.last_scanned_block,
      cursor_updated_at: v.cursor_updated_at,
      head_block: v.head_block,
      blocks_remaining: v.blocks_remaining,
      percent_complete: v.percent_complete,
    };
  });
}

function normalizeIndexer(indexer, versions) {
  const out = Object.assign({}, indexer);
  if (out.last_scanned_block == null && versions.length) {
    out.last_scanned_block = Math.min.apply(null, versions.map(function (v) {
      return Number(v.last_scanned_block) || 0;
    }));
  }
  if (out.head_block == null && versions.length) {
    out.head_block = Math.max.apply(null, versions.map(function (v) {
      return Number(v.head_block) || 0;
    }));
  }
  if (out.blocks_remaining == null && versions.length) {
    out.blocks_remaining = versions.reduce(function (max, v) {
      return Math.max(max, Number(v.blocks_remaining) || 0);
    }, 0);
  }
  if (out.percent_complete == null && versions.length) {
    out.percent_complete = versions.reduce(function (min, v) {
      const pct = Number(v.percent_complete);
      return Number.isFinite(pct) ? Math.min(min, pct) : min;
    }, 100);
  }
  out.cursor_updated_at = latestTimestamp(versions, 'cursor_updated_at');
  return out;
}

// Latest value of `key` across rows, as the raw timestamp string.
function latestTimestamp(rows, key) {
  let latest = null;
  let latestMs = -1;
  for (const row of rows) {
    if (!row || !row[key]) continue;
    const ms = parseTs(row[key]);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = row[key];
    }
  }
  return latest;
}

function activeFindingsCount(s) {
  const e = s.eliminator || {};
  const hasEliminator = e.total_eliminated != null || e.pending != null;
  if (!hasEliminator) return Number(s.reviewer.flagged_safes) || 0;
  return (Number(e.pending) || 0) + (Number(e.retry_ready) || 0) + (Number(e.deferred) || 0)
    + (Number(e.confirmed_shadow) || 0) + (Number(e.errored) || 0);
}

function retryButton() {
  return el('button', {
    class: 'btn btn-sm',
    type: 'button',
    onclick: function () {
      renderSkeleton(activeChainId);
      refresh({ keepShell: true });
    },
  }, 'Retry now');
}

function errorBlock(error, what) {
  return el('div', { class: 'callout callout--danger inline-error', role: 'alert' }, [
    icon('alert'),
    el('span', null, 'Couldn’t load ' + (what || 'this section') + ' (' + describeError(error) + ').'),
  ]);
}

function renderTabs() {
  return el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Chains' },
    knownChains.map(function (chain) {
      const cid = chain.chain_id;
      return el('button', {
        class: 'tab' + (cid === activeChainId ? ' tab-active' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': cid === activeChainId ? 'true' : 'false',
        onclick: function () {
          if (cid === activeChainId) return;
          activeChainId = cid;
          setChainInUrl(cid);
          renderSkeleton(cid);
          refresh({ keepShell: true });
        },
      }, chainName(cid));
    })
  );
}

// Re-renders replace the whole subtree; keep keyboard focus on the matching
// control. Key = nearest id'd ancestor + data-focus-key, href or label text.
function focusKey(node) {
  const scope = node.parentElement && node.parentElement.closest('[id]');
  return (scope ? scope.id : '') + '|' + (node.getAttribute('data-focus-key')
    || node.getAttribute('href') || node.textContent.trim());
}

function preserveFocus(render) {
  const root = $('#dashboard');
  const active = document.activeElement;
  const key = active && active !== root && root.contains(active) ? focusKey(active) : null;
  render();
  if (key == null) return;
  for (const node of root.querySelectorAll('a, button, summary')) {
    if (focusKey(node) === key) {
      node.focus({ preventScroll: true });
      return;
    }
  }
}

function renderDashboard(data) {
  preserveFocus(function () { renderDashboardNow(data); });
}

function renderDashboardNow(data) {
  const root = $('#dashboard');
  root.innerHTML = '';
  root.appendChild(renderTabs());
  root.appendChild(el('div', { id: 'chain-content' }, [renderChainPanel(data)]));
}

function renderOffline(error) {
  const root = $('#dashboard');
  root.innerHTML = '';
  if (knownChains.length) root.appendChild(renderTabs());
  const title = error && error.status
    ? 'The scanner API returned an error'
    : 'Can’t reach the scanner API';
  root.appendChild(stateCallout(title,
    'The dashboard couldn’t load scanner data (' + describeError(error) + '). It retries every 30 seconds.',
    retryButton()));
}

function renderChainPanel(data) {
  const cid = data.chain_id;
  const panel = el('section', { class: 'chain-panel' });

  if (!data.status.ok) {
    panel.appendChild(stateCallout('Couldn’t load ' + chainName(cid) + ' status',
      'The scanner API failed to return status for this chain (' + describeError(data.status.error) + ').',
      retryButton()));
    setHealth('degraded', healthDetail(data.health));
    return panel;
  }

  const s = data.status.value;
  setHealth('live', healthDetail(data.health));
  panel.appendChild(renderProgressCard(s));
  panel.appendChild(renderTiles(s));
  panel.appendChild(renderPipeline(data, s));

  panel.appendChild(listSection('active-findings', 'Active findings',
    'Unresolved storage-root mismatches, most recently reviewed first.',
    listBody(data.flagged, 'active findings', function (items) {
      const active = items.filter(function (it) {
        return (it.effective_status || it.review_status) !== 'cleared';
      });
      return safeList('active-findings', FINDING_COLUMNS, active, function (it) {
        return findingRow(it, cid, false);
      }, 'No active findings.');
    })));
  panel.appendChild(listSection('uninitialized-safes', 'Uninitialized Safes',
    'Factory deployments where setup() was never called.',
    listBody(data.uninitialized, 'uninitialized Safes', function (items) {
      return safeList('uninitialized-safes', DEPLOY_COLUMNS_REVIEWED, items, function (it) {
        return safeRow(it, cid, {
          status: 'uninitialized',
          timeLabel: 'Reviewed',
          time: relTime(it.reviewed_at),
          extra: deployBlock(it),
        });
      }, 'No uninitialized Safes found.');
    })));
  panel.appendChild(listSection('recently-indexed', 'Recently indexed',
    'Newest Safe deployments picked up by the indexer.',
    listBody(data.recent, 'recent Safes', function (items) {
      return safeList('recently-indexed', DEPLOY_COLUMNS_DISCOVERED, items, function (it) {
        return safeRow(it, cid, {
          fallbackStatus: 'unreviewed',
          timeLabel: 'Discovered',
          time: relTime(it.discovered_at),
          extra: deployBlock(it),
        });
      }, 'No Safes indexed yet.');
    })));
  return panel;
}

function sectionTitle(text) {
  return el('h2', { class: 'section-title' }, text);
}

function renderProgressCard(s) {
  const total = Number(s.reviewer.total_safes) || 0;
  const reviewed = Number(s.reviewer.reviewed_safes) || 0;
  const pct = total > 0 ? (reviewed / total) * 100 : 0;
  const progress = bar(pct);
  progress.setAttribute('aria-label', 'Safes reviewed');

  return el('section', { class: 'card progress' }, [
    sectionTitle('Review progress'),
    el('div', { class: 'progress-head' }, [
      el('p', { class: 'progress-count' }, [
        el('strong', null, fmtNum(reviewed)),
        ' of ' + fmtNum(total) + ' Safes reviewed',
      ]),
      el('span', { class: 'progress-pct' }, fmtPct(pct)),
    ]),
    progress,
    renderSafeVersions(s.safe_versions),
  ]);
}

function renderSafeVersions(versions) {
  if (!versions.length) return null;
  return el('table', { class: 'data-table versions' }, [
    el('thead', null, el('tr', null, [
      el('th', { scope: 'col' }, 'Version'),
      el('th', { scope: 'col' }, 'Factory'),
      el('th', { scope: 'col', class: 'num' }, 'Indexed to'),
      el('th', { scope: 'col', class: 'num' }, 'Progress'),
    ])),
    el('tbody', null, versions.map(function (v) {
      const pct = v.percent_complete != null
        ? Math.max(0, Math.min(100, Number(v.percent_complete)))
        : 0;
      return el('tr', null, [
        el('td', null, 'v' + v.version),
        el('td', { class: 'mono', title: v.factory_address }, shortAddr(v.factory_address)),
        el('td', { class: 'num' }, fmtNum(v.last_scanned_block)),
        el('td', { class: 'num' }, el('span', { class: 'version-pct' }, [
          pct < 99.95 ? bar(pct) : null,
          fmtPct(pct),
        ])),
      ]);
    })),
  ]);
}

function renderTiles(s) {
  const r = s.reviewer;
  const e = s.eliminator;
  const retrying = (Number(e.retry_ready) || 0) + (Number(e.deferred) || 0);
  return el('div', { class: 'tile-groups' }, [
    el('section', { class: 'tiles', 'aria-label': 'Review results' }, [
      statTile({ label: 'Clean Safes', value: r.clean_safes }),
      statTile({ label: 'Active findings', value: activeFindingsCount(s), danger: true,
        href: '#active-findings' }),
      statTile({ label: 'Unexplained mismatch', title: 'Unexplained storage mismatch',
        value: e.confirmed_shadow, danger: true,
        href: '?view=confirmed_shadow&chain=' + activeChainId }),
      statTile({ label: 'Needs investigation', value: r.needs_investigation }),
    ]),
    el('section', { class: 'tiles tiles--secondary', 'aria-label': 'Elimination results' }, [
      statTile({ label: 'Cleared false positives', value: e.cleared }),
      statTile({ label: 'Uninitialized', value: r.uninitialized_safes, href: '#uninitialized-safes' }),
      statTile({ label: 'Retrying', value: retrying }),
      statTile({ label: 'Eliminator errors', value: e.errored, danger: true,
        href: '?view=eliminator_errors&chain=' + activeChainId }),
    ]),
  ]);
}

// t: { label, value, title?, danger?, href? }. Danger colour only when non-zero.
function statTile(t) {
  const n = Number(t.value) || 0;
  return el(t.href ? 'a' : 'div', {
    class: 'tile' + (t.href ? ' tile-link' : ''),
    href: t.href,
    title: t.title,
  }, [
    el('span', { class: 'tile-label' }, t.label),
    el('span', { class: 'tile-value' + (t.danger && n > 0 ? ' danger' : '') }, fmtNum(t.value)),
    t.href ? el('span', { class: 'tile-cta' }, ['View', icon('arrow-right')]) : null,
  ]);
}

// Service state from the age of its latest activity. A service with an empty
// queue is caught up even when it has been quiet for a while.
function serviceState(ts, queue, freshMs) {
  if (!ts) return { tone: 'unknown', label: 'No recent data' };
  const age = Date.now() - parseTs(ts);
  if (age < freshMs) return { tone: 'ok', label: 'Active' };
  if (queue === 0) return { tone: 'ok', label: 'Caught up' };
  return { tone: 'warn', label: 'Idle' };
}

function listItems(data) {
  const out = [];
  for (const result of [data.flagged, data.uninitialized, data.recent]) {
    if (result.ok && Array.isArray(result.value.items)) out.push.apply(out, result.value.items);
  }
  return out;
}

function renderPipeline(data, s) {
  const items = listItems(data);
  const r = s.reviewer;
  const e = s.eliminator;
  const lastIndexed = (data.health && data.health.last_indexed_at) || s.indexer.cursor_updated_at;
  const lastReview = latestTimestamp(items, 'reviewed_at');
  const lastEval = latestTimestamp(items, 'elimination_evaluated_at');
  const reviewQueue = r.total_safes != null && r.reviewed_safes != null
    ? Math.max(0, Number(r.total_safes) - Number(r.reviewed_safes))
    : null;
  const elimQueue = data.eliminatorQueue.ok
    ? Number(data.eliminatorQueue.value.pending_safes)
    : (Number(e.pending) || 0) + (Number(e.retry_ready) || 0) + (Number(e.deferred) || 0);
  const behind = s.indexer.blocks_remaining;

  return el('section', { class: 'card pipeline' }, [
    sectionTitle('Pipeline'),
    el('div', { class: 'pipeline-grid' }, [
      pipelineColumn('Indexer', serviceState(lastIndexed, Number(behind), 15 * 60e3), [
        ['Last indexed', lastIndexed ? relTime(lastIndexed) : null],
        ['Behind head', behind != null ? fmtNum(behind) + ' blocks' : null],
      ]),
      pipelineColumn('Reviewer', serviceState(lastReview, reviewQueue, 60 * 60e3), [
        ['Last review', lastReview ? relTime(lastReview) : null],
        ['Queue', reviewQueue != null ? fmtNum(reviewQueue) : null],
        r.errored_safes != null ? ['Errors', fmtNum(r.errored_safes)] : null,
      ]),
      pipelineColumn('Eliminator', serviceState(lastEval, elimQueue, 60 * 60e3), [
        ['Last evaluation', lastEval ? relTime(lastEval) : null],
        ['Queue', fmtNum(elimQueue)],
      ]),
    ]),
    renderOperatorDetails(data, s),
  ]);
}

function pipelineColumn(name, state, rows) {
  return el('div', { class: 'pipeline-col' }, [
    el('h3', { class: 'pipeline-name' }, [
      el('span', { class: 'status-dot status-dot--' + state.tone, 'aria-hidden': 'true' }),
      name,
      el('span', { class: 'pipeline-state' }, state.label),
    ]),
    kvList(rows, 'kv-facts'),
  ]);
}

// Every raw operator field the API returns, kept out of the public view.
function renderOperatorDetails(data, s) {
  const ix = s.indexer;
  const e = s.eliminator;
  const health = data.health;
  const queue = data.eliminatorQueue.ok ? (data.eliminatorQueue.value.queue || {}) : null;

  const details = el('details', { class: 'ops' }, [
    el('summary', null, 'Operator details'),
    el('div', { class: 'ops-grid' }, [
      opsGroup('Indexer', kvList([
        ['Last scanned block', fmtNum(ix.last_scanned_block)],
        ['Head block', fmtNum(ix.head_block)],
        ['Blocks remaining', fmtNum(ix.blocks_remaining)],
        ['Index complete', fmtPct(ix.percent_complete)],
        ['Page size', fmtNum(ix.current_page_size)],
        ['Cursor updated', ix.cursor_updated_at ? relTime(ix.cursor_updated_at) : null],
        health ? ['Health lag', fmtNum(health.lag_blocks) + ' blocks'] : null,
        health ? ['Health last indexed', health.last_indexed_at ? relTime(health.last_indexed_at) : null] : null,
      ], 'kv-facts')),
      opsGroup('Reviewer', kvList([
        ['Total Safes', fmtNum(s.reviewer.total_safes)],
        ['Reviewed', fmtNum(s.reviewer.reviewed_safes)],
        ['Flagged by reviewer', fmtNum(s.reviewer.flagged_safes)],
        ['Review errors', fmtNum(s.reviewer.errored_safes)],
      ], 'kv-facts')),
      opsGroup('Eliminator', data.eliminatorQueue.ok
        ? kvList([
            ['Never attempted', fmtNum(e.pending)],
            ['Retries ready', fmtNum(e.retry_ready)],
            ['Deferred retries', fmtNum(e.deferred)],
            ['Awaiting final verdict', fmtNum(data.eliminatorQueue.value.pending_safes)],
            ['Terminal errors', fmtNum(queue.terminal_errors)],
            ['Max attempts', fmtNum(queue.max_attempts)],
            ['Total eliminated', fmtNum(e.total_eliminated)],
          ], 'kv-facts')
        : el('div', null, [
            kvList([
              ['Never attempted', fmtNum(e.pending)],
              ['Retries ready', fmtNum(e.retry_ready)],
              ['Deferred retries', fmtNum(e.deferred)],
              ['Total eliminated', fmtNum(e.total_eliminated)],
            ], 'kv-facts'),
            errorBlock(data.eliminatorQueue.error, 'the eliminator queue'),
          ])),
    ]),
    renderScanCursors(data.scanCursor),
    renderVersionCursors(s.safe_versions),
  ]);
  if (operatorDetailsOpen) details.open = true;
  details.addEventListener('toggle', function () { operatorDetailsOpen = details.open; });
  return details;
}

function opsGroup(title, body) {
  return el('div', { class: 'ops-group' }, [el('h3', null, title), body]);
}

function renderScanCursors(scanCursor) {
  const group = el('div', { class: 'ops-group' }, [el('h3', null, 'Scan cursors')]);
  if (!scanCursor.ok) {
    group.appendChild(errorBlock(scanCursor.error, 'scan cursors'));
    return group;
  }
  const c = scanCursor.value;
  group.appendChild(kvList([
    ['Latest cursor', fmtNum(c.latest_cursor)],
    ['Latest update', c.latest_cursor_updated_at ? relTime(c.latest_cursor_updated_at) : null],
  ], 'kv-facts'));
  const cursors = Array.isArray(c.cursors) ? c.cursors : [];
  if (!cursors.length) {
    group.appendChild(el('p', { class: 'muted small' }, 'No scan cursors recorded.'));
    return group;
  }
  group.appendChild(el('table', { class: 'data-table' }, [
    el('thead', null, el('tr', null, [
      el('th', { scope: 'col' }, 'Factory'),
      el('th', { scope: 'col', class: 'num' }, 'Last block'),
      el('th', { scope: 'col', class: 'num' }, 'Updated'),
    ])),
    el('tbody', null, cursors.map(function (row) {
      return el('tr', null, [
        el('td', { class: 'mono', title: row.factory_address }, shortAddr(row.factory_address)),
        el('td', { class: 'num' }, fmtNum(row.last_block)),
        el('td', { class: 'num nowrap' }, row.updated_at ? relTime(row.updated_at) : '—'),
      ]);
    })),
  ]));
  return group;
}

function renderVersionCursors(versions) {
  if (!versions.length) return null;
  return el('div', { class: 'ops-group' }, [
    el('h3', null, 'Safe version cursors'),
    el('table', { class: 'data-table' }, [
      el('thead', null, el('tr', null, [
        el('th', { scope: 'col' }, 'Version'),
        el('th', { scope: 'col', class: 'num' }, 'Factory birth'),
        el('th', { scope: 'col', class: 'num' }, 'Head block'),
        el('th', { scope: 'col', class: 'num' }, 'Remaining'),
        el('th', { scope: 'col', class: 'num' }, 'Updated'),
      ])),
      el('tbody', null, versions.map(function (v) {
        return el('tr', null, [
          el('td', null, 'v' + v.version),
          el('td', { class: 'num' }, fmtNum(v.factory_birth_block)),
          el('td', { class: 'num' }, fmtNum(v.head_block)),
          el('td', { class: 'num' }, fmtNum(v.blocks_remaining)),
          el('td', { class: 'num nowrap' }, v.cursor_updated_at ? relTime(v.cursor_updated_at) : '—'),
        ]);
      })),
    ]),
  ]);
}

function listSection(id, title, caption, body) {
  return el('section', { class: 'list-section', id: id }, [
    sectionTitle(title),
    el('p', { class: 'caption' }, caption),
    body,
  ]);
}

function listBody(result, what, build) {
  if (!result.ok) return errorBlock(result.error, what);
  return build(result.value.items || []);
}

const FINDING_COLUMNS = ['Safe', 'Status', 'Reviewed', 'Storage root (expected ≠ actual)'];
const DEPLOY_COLUMNS_REVIEWED = ['Safe', 'Status', 'Reviewed', 'Deployed at block'];
const DEPLOY_COLUMNS_DISCOVERED = ['Safe', 'Status', 'Discovered', 'Deployed at block'];

// Dense Safe table. Lists longer than LIST_PREVIEW collapse behind a toggle
// whose state is kept in expandedLists across auto-refresh.
// The status column is dropped when every row has the same status (the
// section title already says it). Only the fetched page is known, so the
// footer counts "latest N", never a total.
function safeList(listId, columns, items, rowFn, emptyText) {
  if (!items.length) return el('p', { class: 'list-empty' }, emptyText);
  const collapsible = listId != null && items.length > LIST_PREVIEW;
  const expanded = !collapsible || expandedLists.has(listId);
  const rows = items.map(rowFn);
  const statuses = new Set(rows.map(function (r) {
    return r.querySelector('.cell-status').textContent;
  }));
  const uniform = items.length > 1 && statuses.size === 1;
  const table = el('div', { class: 'safe-table' + (uniform ? ' safe-table--uniform' : '') }, [
    el('div', { class: 'safe-table-head', 'aria-hidden': 'true' },
      columns.filter(function (c) { return !(uniform && c === 'Status'); })
        .map(function (c) { return el('span', null, c); })),
  ].concat(expanded ? rows : rows.slice(0, LIST_PREVIEW)));
  if (!collapsible) return table;
  table.appendChild(el('div', { class: 'safe-table-foot' }, [
    el('span', { class: 'muted' }, 'Latest ' + fmtNum(items.length)
      + (expanded ? '' : ' · showing ' + fmtNum(LIST_PREVIEW))),
    el('button', {
      class: 'btn btn-sm',
      type: 'button',
      'data-focus-key': 'list-toggle',
      'aria-expanded': expanded ? 'true' : 'false',
      onclick: function () {
        if (expanded) expandedLists.delete(listId);
        else expandedLists.add(listId);
        const next = safeList(listId, columns, items, rowFn, emptyText);
        table.replaceWith(next);
        next.querySelector('[data-focus-key="list-toggle"]').focus({ preventScroll: true });
      },
    }, expanded ? 'Show fewer' : 'Show all'),
  ]));
  return table;
}

// One row renderer for every Safe table. opts: status (forced badge),
// fallbackStatus, timeLabel + time, extra (last column), wideExtra, sub (full-width line).
function safeRow(it, chainId, opts) {
  return el('a', { class: 'safe-row', href: safeDetailHref(it.address, chainId) }, [
    el('span', { class: 'cell-addr addr-mono', title: it.address }, shortAddr(it.address)),
    el('span', { class: 'cell-status' },
      statusBadge(opts.status || it.effective_status || it.review_status || opts.fallbackStatus)),
    el('span', { class: 'cell-time' }, opts.time
      ? [el('span', { class: 'cell-label' }, opts.timeLabel + ' '), opts.time]
      : el('span', { class: 'muted' }, 'Not ' + opts.timeLabel.toLowerCase())),
    el('span', { class: 'cell-extra' + (opts.wideExtra ? ' cell-extra--wide' : '') }, opts.extra || null),
    opts.sub || null,
  ]);
}

function deployBlock(it) {
  return [el('span', { class: 'cell-label' }, 'Block '), fmtNum(it.deploy_block)];
}

function findingRow(it, chainId, showError) {
  return safeRow(it, chainId, {
    fallbackStatus: 'shadow_detected',
    timeLabel: 'Reviewed',
    time: relTime(it.reviewed_at),
    extra: (it.expected_root || it.actual_root) ? rootsDiff(it.expected_root, it.actual_root) : null,
    wideExtra: true,
    sub: findingSub(it, showError),
  });
}

// Compact eliminator facts. The verdict itself is already the status badge.
function findingSub(it, showError) {
  const error = showError && it.elimination_error_message;
  if (!it.elimination_verdict && !error) return null;
  const lines = [];
  if (it.elimination_verdict) {
    const parts = [
      fmtNum(it.approve_hash_count) + ' approveHash',
      fmtNum(it.sign_msg_count) + ' signMessage',
      fmtNum(it.on_chain_set_count) + ' on-chain slots',
    ];
    if (it.elimination_evaluated_at) parts.push('evaluated ' + relTime(it.elimination_evaluated_at));
    if (Number(it.elimination_retryable) === 1) {
      let retry = 'retry attempt ' + fmtNum(it.elimination_attempt_count);
      if (it.elimination_next_retry_at) retry += ', next ' + untilTime(it.elimination_next_retry_at);
      parts.push(retry);
    }
    lines.push(el('span', {
      class: 'row-sub-facts',
      title: it.eliminated_review_block != null
        ? 'Eliminator verdict ' + it.elimination_verdict + ' at review block ' + fmtNum(it.eliminated_review_block)
        : null,
    }, [el('span', { class: 'row-sub-label' }, 'Eliminator'), parts.join(' · ')]));
  }
  if (error) lines.push(el('span', { class: 'row-sub-error' }, it.elimination_error_message));
  return el('span', { class: 'row-sub' }, lines);
}

function readViewFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('view');
}

const VIEW_CONFIG = {
  confirmed_shadow: {
    title: 'Unexplained storage mismatch',
    caption: 'Storage-root mismatches that persist after every known false-positive source is ruled out.',
    verdict: 'confirmed_shadow',
    limit: 50,
    showError: false,
  },
  eliminator_errors: {
    title: 'Eliminator errors',
    caption: 'Safes the eliminator could not finish. Retryable and deferred failures are not shown.',
    verdict: 'error',
    retryable: 0,
    limit: 200,
    showError: true,
  },
};

function renderDrillDown(cfg, items, chainId) {
  preserveFocus(function () { renderDrillDownNow(cfg, items, chainId); });
}

function renderDrillDownNow(cfg, items, chainId) {
  const root = $('#dashboard');
  root.innerHTML = '';
  root.appendChild(renderTabs());
  const countText = items.length >= cfg.limit
    ? 'Showing the first ' + fmtNum(cfg.limit) + ' Safes'
    : fmtNum(items.length) + ' Safe' + (items.length !== 1 ? 's' : '');
  const panel = el('section', { class: 'chain-panel drilldown' }, [
    el('a', { class: 'back', href: '?chain=' + chainId }, [icon('arrow-left'), 'Dashboard']),
    el('div', { class: 'drilldown-head' }, [
      el('h1', { class: 'drilldown-title' }, cfg.title),
      el('span', { class: 'drilldown-count' }, countText),
    ]),
    el('p', { class: 'caption' }, cfg.caption),
    safeList(null, FINDING_COLUMNS, items, function (it) {
      return findingRow(it, chainId, cfg.showError);
    }, 'No matching Safes found.'),
  ]);
  root.appendChild(el('div', { id: 'chain-content' }, [panel]));
}

async function refresh(opts) {
  const auto = !!(opts && opts.autoRefresh);
  if (auto && readViewFromUrl()) return;

  const requestId = ++refreshRequestSeq;
  const errEl = $('#err');
  let targetChainId = activeChainId;

  try {
    let chains = knownChains;
    if (!chains.length) {
      if (!auto) renderSkeleton();
      chains = await getChains();
      if (requestId !== refreshRequestSeq) return;
      knownChains = chains;
      if (chains.length) {
        const selected = resolveChainSelection(chains);
        activeChainId = selected.chainId;
        targetChainId = selected.chainId;
        if (selected.shouldReplace) setChainInUrl(selected.chainId, { replace: true });
        renderSkeleton(selected.chainId);
      }
    }

    if (!knownChains.length) {
      $('#dashboard').innerHTML = '';
      $('#dashboard').appendChild(el('div', { class: 'card' }, [
        sectionTitle('No chains configured'),
        el('p', { class: 'muted' }, 'The API did not return any enabled chains.'),
      ]));
      setHealth('offline');
      return;
    }

    targetChainId = activeChainId;

    const viewKey = readViewFromUrl();
    const viewCfg = viewKey ? VIEW_CONFIG[viewKey] : null;
    activeView = viewKey;
    if (viewCfg) {
      const retryFilter = viewCfg.retryable == null ? '' : '&retryable=' + viewCfg.retryable;
      const result = await api('/api/safes?verdict=' + viewCfg.verdict + retryFilter + '&limit=' + viewCfg.limit, targetChainId);
      if (!isCurrentRefresh(requestId, targetChainId)) return;
      errEl.textContent = '';
      setHealth('live');
      renderDrillDown(viewCfg, result.items || [], targetChainId);
      return;
    }

    await loadHealthBestEffort();
    if (!isCurrentRefresh(requestId, targetChainId)) return;
    const data = await fetchDashboardData(targetChainId);
    if (!isCurrentRefresh(requestId, targetChainId)) return;
    if (!data.status.ok && auto && showingData()) {
      showStale(data.status.error);
      return;
    }
    errEl.textContent = '';
    renderDashboard(data);
  } catch (e) {
    if (requestId !== refreshRequestSeq || (targetChainId != null && targetChainId !== activeChainId)) return;
    if (opts && opts.keepShell && showingData()) {
      showStale(e);
      return;
    }
    setHealth('offline', describeError(e));
    errEl.textContent = '';
    renderOffline(e);
  }
}

// A loaded dashboard or drill-down (not a skeleton or error state) is on screen.
function showingData() {
  return !!$('#dashboard .pipeline, #dashboard .drilldown');
}

// Keep already-loaded data on screen when a background refresh fails.
function showStale(error) {
  setHealth('offline', describeError(error));
  $('#err').textContent = 'Lost contact with the scanner API (' + describeError(error)
    + '). Showing the last loaded data.';
}

async function init() {
  bindSearch();
  renderSkeleton();
  await refresh();
  setInterval(function () { refresh({ keepShell: true, autoRefresh: true }); }, 30000);

  window.addEventListener('popstate', function () {
    if (!knownChains.length) return;
    const selected = resolveChainSelection(knownChains);
    if (selected.shouldReplace) setChainInUrl(selected.chainId, { replace: true });
    const newView = readViewFromUrl();
    if (selected.chainId === activeChainId && newView === activeView) return;
    activeChainId = selected.chainId;
    renderSkeleton(activeChainId);
    refresh({ keepShell: true });
  });
}

init();
