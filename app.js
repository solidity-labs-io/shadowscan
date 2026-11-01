const API_BASE = (window.API_BASE && window.API_BASE.length)
  ? window.API_BASE.replace(/\/$/, '')
  : 'https://api.shadowscan.xyz';

const CHAIN_META = {
  1:     { name: 'Ethereum', explorerUrl: 'https://etherscan.io' },
  10:    { name: 'Optimism', explorerUrl: 'https://optimistic.etherscan.io' },
  137:   { name: 'Polygon',  explorerUrl: 'https://polygonscan.com' },
  8453:  { name: 'Base',     explorerUrl: 'https://basescan.org' },
  42161: { name: 'Arbitrum', explorerUrl: 'https://arbiscan.io' },
};

async function api(path, chainId) {
  let url = API_BASE + path;
  if (chainId != null) {
    url += (path.includes('?') ? '&' : '?') + 'chain_id=' + chainId;
  }
  const res = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getChains() {
  const body = await api('/api/chains');
  return body.chains || [];
}

function chainName(id) {
  return (CHAIN_META[id] && CHAIN_META[id].name) || ('Chain ' + id);
}

function explorerLink(chainId, kind, val) {
  const meta = CHAIN_META[chainId];
  return meta ? meta.explorerUrl + '/' + kind + '/' + val : null;
}

function shortAddr(a) {
  if (!a) return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function shortHash(h) {
  if (!h) return '—';
  return h.slice(0, 10) + '…' + h.slice(-6);
}

function fmtNum(n) {
  return (n == null) ? '–' : Number(n).toLocaleString();
}

// SQLite datetime('now') is UTC without a zone; don't let Date read it as
// local time. Full ISO strings (with Z or an offset) pass through unchanged.
function parseTs(ts) {
  const raw = String(ts);
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
  return new Date(zoneless ? raw.replace(' ', 'T') + 'Z' : raw).getTime();
}

function relTime(iso) {
  if (!iso) return '';
  const t = parseTs(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + ' sec ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' hr ago';
  const d = Math.round(h / 24);
  return d + ' days ago';
}

// Future timestamps ("next retry") as "in N min"; past ones fall back to relTime.
function untilTime(iso) {
  const t = parseTs(iso);
  if (Number.isNaN(t)) return '';
  if (t <= Date.now()) return relTime(iso);
  const m = Math.round((t - Date.now()) / 60000);
  if (m < 1) return 'in under a minute';
  if (m < 60) return 'in ' + m + ' min';
  const h = Math.round(m / 60);
  if (h < 48) return 'in ' + h + ' hr';
  return 'in ' + Math.round(h / 24) + ' days';
}

const ADDR_ERROR = 'Enter a 0x-prefixed, 40-character hex address.';

function isAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(v == null ? '' : v).trim());
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  return Number(n).toFixed(1) + '%';
}

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  const list = [].concat(children || []);
  for (const c of list) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function statusBadge(status) {
  const map = {
    clean:               ['Clean',                        'badge badge-ok'],
    cleared:             ['Cleared',                      'badge badge-ok'],
    shadow_detected:     ['Active finding',               'badge badge-danger'],
    confirmed_shadow:    ['Unexplained storage mismatch', 'badge badge-danger'],
    needs_investigation: ['Needs investigation',          'badge badge-warn'],
    error:               ['Error',                        'badge badge-danger'],
    uninitialized:       ['Uninitialized',                'badge badge-neutral'],
    unreviewed:          ['Unreviewed',                   'badge'],
    pending:             ['Pending',                      'badge'],
  };
  const entry = map[status];
  if (!entry) return el('span', { class: 'badge' }, status || 'Pending');
  return el('span', { class: entry[1] }, entry[0]);
}

const ICON_PATHS = {
  alert: ['M12 3.5 2.5 20h19L12 3.5z', 'M12 10v4.5', 'M12 17.5h.01'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon icon-' + name);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function rootsDiff(expected, actual) {
  return el('span', { class: 'roots-diff' }, [
    el('span', { class: 'mono' }, 'exp ' + shortHash(expected)),
    el('span', { class: 'roots-diff-sep', 'aria-label': 'does not equal' }, '≠'),
    el('span', { class: 'mono danger' }, shortHash(actual)),
  ]);
}

function externalLink(chainId, kind, val, label) {
  const href = explorerLink(chainId, kind, val);
  if (!href) return null;
  return el('a', { class: 'ext-link', href: href, target: '_blank', rel: 'noopener' }, [
    label == null ? 'Explorer' : label,
    icon('external'),
  ]);
}

// rows: [label, value, extra?]; null rows are skipped. String values that look
// like hex are rendered monospace.
function kvList(rows, cls) {
  const cells = [];
  for (const row of rows) {
    if (!row) continue;
    const value = row[1];
    const hex = typeof value === 'string' && value.startsWith('0x');
    cells.push(el('div', { class: 'k' }, row[0]));
    const children = [].concat(value == null ? '—' : value);
    if (row[2]) children.push(el('div', { class: 'kv-extra' }, row[2]));
    cells.push(el('div', { class: 'v' + (hex ? ' mono' : '') }, children));
  }
  return el('div', { class: 'kv' + (cls ? ' ' + cls : '') }, cells);
}

function bar(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const fill = el('div', { class: 'bar-fill' });
  fill.style.width = clamped.toFixed(1) + '%';
  return el('div', {
    class: 'bar',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': clamped.toFixed(1),
  }, fill);
}

// Short, user-facing reason for a failed api() call.
function describeError(error) {
  if (!error) return 'unknown error';
  if (error.status) return 'HTTP ' + error.status;
  if (error.name === 'TimeoutError') return 'request timed out';
  return 'network error';
}

// Full-panel error state (offline, failed load). action is an optional node.
function stateCallout(title, detail, action) {
  return el('div', { class: 'callout callout--danger state-callout', role: 'alert' }, [
    el('p', { class: 'state-callout-title' }, [icon('alert'), el('strong', null, title)]),
    el('p', null, detail),
    action || null,
  ]);
}

// Default: icon + "Copy" text button. opts.iconOnly renders a 32px icon
// button; opts.label names what is copied ("Copy address") for aria/title.
function copyButton(text, opts) {
  const iconOnly = !!(opts && opts.iconOnly);
  const name = (opts && opts.label) || (iconOnly ? 'Copy value' : 'Copy to clipboard');
  const label = iconOnly ? null : el('span', null, 'Copy');
  return el('button', {
    class: 'btn btn-sm' + (iconOnly ? ' btn-icon' : ''),
    type: 'button',
    title: iconOnly ? name : null,
    'aria-label': name,
    onclick: function (e) {
      const btn = e.currentTarget;
      try { navigator.clipboard.writeText(text); } catch (_) {}
      btn.replaceChild(icon('check'), btn.firstChild);
      if (label) label.textContent = 'Copied';
      else btn.title = 'Copied';
      setTimeout(function () {
        btn.replaceChild(icon('copy'), btn.firstChild);
        if (label) label.textContent = 'Copy';
        else btn.title = name;
      }, 1200);
    },
  }, [icon('copy'), label]);
}
