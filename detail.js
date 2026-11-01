(function () {
  const params = new URLSearchParams(location.search);
  const rawAddr = (params.get('addr') || '').trim().toLowerCase();
  const rawChain = params.get('chain');
  const chainId = rawChain ? parseInt(rawChain, 10) : null;
  const root = document.getElementById('content');

  if (!isAddress(rawAddr)) {
    root.appendChild(el('div', { class: 'card state-card' }, [
      el('h1', { class: 'card-title' }, 'Missing or invalid address'),
      el('p', { class: 'muted' }, 'Open this page with ?addr=0x… (a 0x-prefixed, 40-character hex address).'),
    ]));
    return;
  }

  document.title = shortAddr(rawAddr) + ' · ShadowScan';

  // A review mismatch stays a finding unless the eliminator cleared it;
  // confirmed_shadow and terminal errors keep the guidance.
  function isFlagged(review, effectiveStatus) {
    return !!review
      && (review.status === 'shadow_detected' || review.status === 'needs_investigation')
      && effectiveStatus !== 'cleared';
  }

  if (chainId != null) {
    const back = document.querySelector('.site-header .back');
    if (back) back.setAttribute('href', './?chain=' + encodeURIComponent(chainId));
    loadSingleChain(chainId);
  } else {
    loadAllChains();
  }

  async function loadSingleChain(cid) {
    renderSkeleton();
    try {
      const data = await api('/api/safes/' + rawAddr, cid);
      renderSingle(data.safe, data.review, data.elimination, data.effective_status, cid);
    } catch (e) {
      if (e.status === 404) {
        renderNotFound(cid);
      } else {
        renderError(e);
      }
    }
  }

  async function loadAllChains() {
    renderSkeleton();
    let chains;
    try {
      chains = await getChains();
    } catch (e) {
      renderError(e, 'the chain list');
      return;
    }
    if (!chains.length) {
      root.innerHTML = '';
      root.appendChild(buildHeader(rawAddr, null, null));
      root.appendChild(stateCallout('No chains configured',
        'The scanner API reports no chains to search.', retryButton()));
      return;
    }

    const results = await Promise.all(chains.map(function (chain) {
      return api('/api/safes/' + rawAddr, chain.chain_id)
        .then(function (data) { return { chain: chain, data: data, err: null }; })
        .catch(function (e) { return { chain: chain, data: null, err: e }; });
    }));

    root.innerHTML = '';
    root.appendChild(buildHeader(rawAddr, null, null));

    const allMissing = results.every(function (r) {
      return r.err && r.err.status === 404;
    });

    if (allMissing) {
      root.appendChild(el('div', { class: 'card state-card' }, [
        el('h2', { class: 'card-title' }, 'Not indexed on any chain'),
        el('p', { class: 'muted' },
          'It may not be a Safe, or the indexer has not reached the block where it was deployed.'),
      ]));
      return;
    }

    for (const r of results) {
      root.appendChild(buildChainResultCard(r.chain, r.data, r.err));
    }
  }

  function buildChainResultCard(chain, data, err) {
    const cid = chain.chain_id;
    const label = el('h2', { class: 'chain-label' }, chainName(cid));

    if (err && err.status === 404) {
      return el('div', { class: 'card chain-card chain-card-missing' }, [
        el('div', { class: 'chain-card-header' }, [label, el('span', { class: 'badge' }, 'Not indexed')]),
      ]);
    }

    if (err) {
      return el('div', { class: 'card chain-card' }, [
        el('div', { class: 'chain-card-header' }, [label, el('span', { class: 'badge badge-danger' }, 'Failed to load')]),
        el('p', { class: 'muted small chain-card-note' },
          'Couldn’t load this chain (' + describeError(err) + ').'),
      ]);
    }

    const safe = data.safe;
    const review = data.review;
    const status = data.effective_status || (review ? review.status : null);
    const flagged = isFlagged(review, status);

    const rows = [
      el('div', { class: 'chain-card-header' }, [
        label,
        statusBadge(status || 'pending'),
        el('a', {
          href: 'safe.html?addr=' + encodeURIComponent(rawAddr) + '&chain=' + encodeURIComponent(cid),
          class: 'btn btn-sm chain-details-btn',
        }, ['View details', icon('arrow-right')]),
      ]),
      el('div', { class: 'chain-card-meta muted small num' },
        'Deployed at block ' + fmtNum(safe.deploy_block)
        + (review ? ' · reviewed ' + relTime(review.reviewed_at) : ' · not reviewed yet')),
    ];

    if (flagged) {
      rows.push(el('div', { class: 'chain-card-roots' }, rootsDiff(review.expected_root, review.actual_root)));
    }

    return el('div', { class: 'card chain-card' }, rows);
  }

  function renderSkeleton() {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'detail-header', 'aria-busy': 'true' }, [
      el('div', { class: 'skeleton-line short' }),
      el('div', { class: 'skeleton-line skeleton-title' }),
    ]));
    for (let i = 0; i < 2; i++) {
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'skeleton-line short' }),
        el('div', { class: 'skeleton-line' }),
        el('div', { class: 'skeleton-line' }),
        el('div', { class: 'skeleton-line short' }),
      ]));
    }
  }

  function renderNotFound(cid) {
    root.innerHTML = '';
    root.appendChild(buildHeader(rawAddr, null, cid));
    root.appendChild(el('div', { class: 'card state-card' }, [
      el('h2', { class: 'card-title' }, 'Safe not found'),
      el('p', { class: 'muted' },
        'The scanner has no record of this address on ' + chainName(cid) + '. '
        + 'It may not be a Safe, or the indexer has not reached the block where it was deployed.'),
      el('p', { class: 'small' }, el('a', {
        class: 'inline-link',
        href: 'safe.html?addr=' + encodeURIComponent(rawAddr),
      }, ['Check all chains', icon('arrow-right')])),
    ]));
  }

  function retryButton() {
    return el('button', {
      class: 'btn btn-sm',
      type: 'button',
      onclick: function () { location.reload(); },
    }, 'Retry now');
  }

  function renderError(error, what) {
    root.innerHTML = '';
    root.appendChild(buildHeader(rawAddr, null, chainId));
    const title = error && error.status
      ? 'The scanner API returned an error'
      : 'Can’t reach the scanner API';
    root.appendChild(stateCallout(title,
      'Couldn’t load ' + (what || 'this Safe') + ' (' + describeError(error) + ').',
      retryButton()));
  }

  function renderSingle(safe, review, elimination, effectiveStatus, cid) {
    root.innerHTML = '';
    const status = effectiveStatus || (review ? review.status : 'unreviewed');
    root.appendChild(buildHeader(safe.address, status, cid));
    root.appendChild(buildIdentityCard(safe, cid));
    if (review) root.appendChild(buildReviewCard(review, status));
    if (elimination) root.appendChild(buildEliminationCard(elimination, review));
    root.appendChild(buildIntrospectionCard(safe, review, elimination, cid, status));
  }

  // ────────────────────────────────────────────────────────────────────
  // Small local primitives
  // ────────────────────────────────────────────────────────────────────

  // Icon-only explorer link for inline use next to an address.
  function extIcon(cid, kind, val) {
    const a = externalLink(cid, kind, val, '');
    if (!a) return null;
    a.classList.add('ext-icon');
    a.setAttribute('aria-label', 'View on ' + chainName(cid) + ' explorer');
    a.setAttribute('title', 'View on ' + chainName(cid) + ' explorer');
    return a;
  }

  // Shortened hash/word with the full value on hover.
  function hashShort(hex) {
    if (!hex) return '—';
    return el('span', { class: 'mono', title: hex }, shortHash(hex));
  }

  function addrLink(cid, addr) {
    return el('span', { class: 'mono', title: addr },
      externalLink(cid, 'address', addr, shortAddr(addr)) || shortAddr(addr));
  }

  function whyDetails(summary, children) {
    return el('details', { class: 'why' }, [
      el('summary', null, summary),
      el('div', { class: 'why-body' }, children),
    ]);
  }

  // state: 'ok' | 'bad' | 'muted'
  function checkSpan(state, text) {
    return el('span', { class: 'check ' + state }, [
      state === 'ok' ? icon('check') : state === 'bad' ? icon('alert') : null,
      text,
    ]);
  }

  // ────────────────────────────────────────────────────────────────────
  // Header and scanner-record cards
  // ────────────────────────────────────────────────────────────────────

  function buildHeader(address, status, cid) {
    const ext = cid != null ? explorerLink(cid, 'address', address) : null;
    const extLabel = cid != null ? 'View on ' + chainName(cid) + ' explorer' : null;
    return el('div', { class: 'detail-header' }, [
      el('div', { class: 'detail-tags' }, [
        status ? statusBadge(status) : null,
        el('span', { class: 'chain-chip' }, cid != null ? chainName(cid) : 'All chains'),
      ]),
      el('div', { class: 'detail-addr-row' }, [
        el('h1', { class: 'full-addr' }, [
          el('span', { class: 'visually-hidden' }, 'Safe '),
          address,
        ]),
        el('div', { class: 'detail-actions' }, [
          copyButton(address, { iconOnly: true, label: 'Copy address' }),
          ext ? el('a', {
            class: 'btn btn-sm btn-icon',
            href: ext,
            target: '_blank',
            rel: 'noopener',
            title: extLabel,
            'aria-label': extLabel,
          }, icon('external')) : null,
        ]),
      ]),
    ]);
  }

  function buildIdentityCard(safe, cid) {
    const txText = shortHash(safe.deploy_tx);
    return el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, 'On-chain identity'),
      kvList([
        ['Deploy block', el('span', { class: 'num' }, fmtNum(safe.deploy_block))],
        ['Deploy tx', el('span', { class: 'mono', title: safe.deploy_tx },
          externalLink(cid, 'tx', safe.deploy_tx, txText) || txText)],
        ['Singleton', safe.singleton ? addrLink(cid, safe.singleton) : '—'],
        ['Initializer', safe.initializer_to
          ? el('span', null, [
              addrLink(cid, safe.initializer_to),
              el('span', { class: 'muted' }, ' · ' + fmtNum(safe.initializer_data_len) + ' bytes'),
            ])
          : '—'],
        ['Discovered', relTime(safe.discovered_at)],
      ]),
    ]);
  }

  // Common prefix/suffix diff: [start, end) of the differing middle, or null
  // when the strings are equal.
  function diffRange(a, b) {
    if (!a || !b || a === b) return null;
    const n = Math.min(a.length, b.length);
    let start = 0;
    while (start < n && a[start] === b[start]) start++;
    let tail = 0;
    while (tail < n - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return [start, Math.max(a.length, b.length) - tail];
  }

  // Hash in 8-char groups ("0x" rides with the first) that wrap at group
  // boundaries; <wbr> keeps copy/paste contiguous. With a range, characters
  // inside it get hiClass and the rest are dimmed.
  function hashBlock(hex, range, hiClass) {
    const out = el('span', { class: 'hash' });
    if (!hex) { out.textContent = '—'; return out; }
    function inRange(i) { return i >= range[0] && i < range[1]; }
    let start = 0;
    while (start < hex.length) {
      const end = Math.min(start === 0 ? 10 : start + 8, hex.length);
      if (start > 0) out.appendChild(el('wbr'));
      const group = el('span', { class: 'hash-group' });
      let i = start;
      while (i < end) {
        if (!range) { group.appendChild(document.createTextNode(hex.slice(i, end))); break; }
        const hit = inRange(i);
        let j = i;
        while (j < end && inRange(j) === hit) j++;
        group.appendChild(el('span', { class: hit ? hiClass : 'hash-same' }, hex.slice(i, j)));
        i = j;
      }
      out.appendChild(group);
      start = end;
    }
    return out;
  }

  function rootColumn(label, hex, range, hiClass) {
    return el('div', { class: 'root-col' }, [
      el('div', { class: 'root-label' }, [
        el('span', null, label),
        hex ? copyButton(hex, { iconOnly: true, label: 'Copy ' + label.toLowerCase() }) : null,
      ]),
      hashBlock(hex, range, hiClass),
    ]);
  }

  function buildReviewCard(review, effectiveStatus) {
    const flagged = review.status === 'shadow_detected' || review.status === 'needs_investigation';
    const cleared = effectiveStatus === 'cleared';
    const range = diffRange(review.expected_root, review.actual_root);

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title' }, 'Review'),
        el('span', { class: 'muted small num' },
          'Block ' + fmtNum(review.block_number) + ' · ' + relTime(review.reviewed_at)),
      ]),
      el('div', { class: 'roots' }, [
        rootColumn('Expected root', review.expected_root, range, 'hash-diff'),
        rootColumn('Actual root', review.actual_root, range, 'hash-diff hash-diff-actual'),
      ]),
      !range && review.expected_root && review.actual_root
        ? el('p', { class: 'roots-note' }, checkSpan('ok', 'Roots match'))
        : null,
    ]);

    if (flagged && cleared) {
      card.appendChild(el('div', { class: 'callout callout--ok' }, [
        el('p', null, [
          el('strong', null, 'Cleared by the eliminator. '),
          'Indexed approveHash / signMessage events explain the mismatch, so it is not treated as an active finding.',
        ]),
      ]));
    } else if (flagged) {
      card.appendChild(el('div', { class: 'callout' }, [
        el('p', null, [
          el('strong', null, 'Storage-root mismatch. '),
          "The on-chain storage hash does not match the root computed from this Safe's public state. ",
          'This is a signal, not proof of compromise.',
        ]),
        whyDetails('Why this can happen', [
          el('p', null, 'Any storage entry missing from the public state changes the root. Possible causes:'),
          el('ul', null, [
            el('li', null, 'a shadow owner or shadow module written directly to storage;'),
            el('li', null, 'approveHash / signMessage entries the eliminator has not cleared;'),
            el('li', null, 'unrelated storage entries the scanner does not model yet.'),
          ]),
          el('p', null, 'The live introspection below shows what to check next.'),
        ]),
      ]));
    }
    if (review.status === 'error' && review.error_message) {
      card.appendChild(el('div', { class: 'error-msg' }, review.error_message));
    }
    return card;
  }

  function buildEliminationCard(elimination, review) {
    const recomputed = elimination.recomputed_expected_root;
    const actual = elimination.actual_root;
    const recomputedVal = recomputed
      ? el('span', null, [
          hashShort(recomputed),
          actual
            ? (recomputed === actual
                ? checkSpan('ok', 'matches actual root')
                : checkSpan('bad', 'still differs from actual root'))
            : null,
        ])
      : '—';
    // Values already shown in the review card are not repeated.
    const sameActual = review && actual && actual === review.actual_root;
    const sameBlock = review && Number(elimination.review_block) === Number(review.block_number);

    const rows = [
      ['Verdict', statusBadge(elimination.verdict)],
      ['Evaluated', elimination.evaluated_at ? relTime(elimination.evaluated_at) : '—'],
      sameBlock ? null : ['Review block evaluated', el('span', { class: 'num' }, fmtNum(elimination.review_block))],
      ['Events found', el('span', { class: 'num' },
        fmtNum(elimination.approve_hash_count) + ' approveHash · '
        + fmtNum(elimination.sign_msg_count) + ' signMessage')],
      ['Confirmed on-chain slots', el('span', { class: 'num' }, fmtNum(elimination.on_chain_set_count))],
      ['Recomputed root', recomputedVal],
      sameActual ? null : ['Actual root', hashShort(actual)],
    ];
    if (Number(elimination.retryable) === 1) {
      rows.push(['Retry status', 'Retrying (attempt ' + fmtNum(elimination.attempt_count) + ')']);
      rows.push(['Next retry', elimination.next_retry_at ? untilTime(elimination.next_retry_at) : 'ready now']);
    } else if (elimination.verdict === 'error') {
      rows.push(['Retry status', 'Terminal']);
    }
    const card = el('div', { class: 'card elimination-card' }, [
      el('h2', { class: 'card-title' }, 'Elimination'),
      kvList(rows),
    ]);
    if (elimination.error_message) card.appendChild(el('p', { class: 'error-msg' }, elimination.error_message));
    return card;
  }

  // ────────────────────────────────────────────────────────────────────
  // Live chain introspection card
  // ────────────────────────────────────────────────────────────────────

  function buildIntrospectionCard(safe, review, elimination, cid, effectiveStatus) {
    const card = el('div', { class: 'card introspect' }, [
      el('h2', { class: 'card-title' }, 'Live chain introspection'),
    ]);

    const flagged = isFlagged(review, effectiveStatus);

    if (!window.CHAIN_RPCS || !window.CHAIN_RPCS[cid]) {
      card.appendChild(el('p', { class: 'muted' },
        'Live introspection is not available for ' + chainName(cid) + ': no public RPCs are configured.'));
      return card;
    }
    if (typeof window.loadSafeIntrospection !== 'function') {
      card.appendChild(el('p', { class: 'muted' },
        'Live introspection module not loaded. Check that lib/safe-introspect.js loaded before detail.js.'));
      return card;
    }

    const body = el('div', { class: 'introspect-body' }, [
      el('div', { class: 'loading-row' }, [el('span', { class: 'spinner' }), 'Reading state from a public RPC…']),
    ]);
    card.appendChild(body);

    window.loadSafeIntrospection(cid, safe.address)
      .then(function (res) {
        body.innerHTML = '';
        renderIntrospection(body, res, safe, cid, flagged, elimination);
      })
      .catch(function (err) {
        body.innerHTML = '';
        body.appendChild(el('p', { class: 'error-msg' },
          'Live introspection failed: ' + ((err && err.message) || String(err))));
      });

    return card;
  }

  function renderIntrospection(container, res, safe, cid, flagged, elimination) {
    const providerHost = (function () {
      try { return new URL(res.providerUrl).host; } catch (_) { return res.providerUrl; }
    })();
    container.appendChild(el('p', { class: 'introspect-source muted small num' },
      'Read from ' + providerHost + ' at block ' + fmtNum(res.block) + ' · ' + res.latencyMs + ' ms'));

    // Detect uninitialized Safe: threshold storage zero, ownerCount zero,
    // and getOwners reverted -> setup() was never called.
    const uninitialized =
      (res.thresholdStorage === 0n) &&
      (res.ownerCountStorage === 0n) &&
      (res.ownersError != null);
    if (uninitialized) {
      container.appendChild(el('div', { class: 'callout introspect-uninit' }, [
        el('p', null, [
          el('strong', null, 'This Safe appears uninitialized. '),
          'threshold and ownerCount are 0 and getOwners() reverts, so setup() was never called.',
        ]),
        whyDetails('Why this can happen', [
          el('p', null, "The proxy was deployed without setup(), so it has no owners and can't execute transactions."),
          el('p', null, 'A storage-root mismatch on an uninitialized proxy usually comes from direct storage writes by the deployer, the only way state reaches storage without setup(). Inspect the deploy tx and any delegatecalls inside it.'),
        ]),
      ]));
    }

    container.appendChild(section('Public view methods', buildViewMethodsBlock(res, cid)));
    container.appendChild(section('Direct storage reads', buildStorageBlock(res, cid)));

    if (res.webAuthnSharedSigners && res.webAuthnSharedSigners.length) {
      container.appendChild(section('Known extension storage', buildWebAuthnStorageBlock(res.webAuthnSharedSigners, cid)));
    }

    if (res.ownerLinks || res.moduleLinks) {
      container.appendChild(section('Linked-list integrity', buildLinkedListBlock(res)));
    }

    if (flagged && !uninitialized) {
      container.appendChild(section('What we can and cannot conclude', buildInterpretationBlock()));
    }

    container.appendChild(buildProbeBlock(res, safe, cid));
  }

  function section(title, content) {
    return el('section', { class: 'introspect-section' }, [
      el('h3', { class: 'introspect-h' }, title),
      content,
    ]);
  }

  function revertedSpan(err) {
    const msg = err && err.message ? String(err.message).slice(0, 80) : 'reverted';
    return checkSpan('bad', msg);
  }

  // The last characters and the explorer icon never wrap apart.
  function fullAddrCell(cid, addr) {
    return el('span', { class: 'addr-cell mono' }, [
      addr.slice(0, -6),
      el('span', { class: 'nowrap' }, [addr.slice(-6), extIcon(cid, 'address', addr)]),
    ]);
  }

  function buildViewMethodsBlock(res, cid) {
    function listOf(items) {
      if (!items.length) return el('span', { class: 'muted' }, 'None');
      return el('div', { class: 'introspect-list' }, items.map(function (a) {
        return fullAddrCell(cid, a);
      }));
    }

    const versionVal = res.versionError
      ? revertedSpan(res.versionError)
      : el('span', { class: 'mono' }, String(res.version));
    const thresholdVal = res.thresholdViewError
      ? revertedSpan(res.thresholdViewError)
      : el('span', { class: 'mono' }, res.thresholdView.toString());
    const nonceVal = res.nonceViewError
      ? revertedSpan(res.nonceViewError)
      : el('span', { class: 'mono' }, res.nonceView.toString());

    let ownersVal, ownersExtra;
    if (res.ownersError) {
      ownersVal = revertedSpan(res.ownersError);
      ownersExtra = 'getOwners() reverts when the linked list is unterminated, usually because setup() was never called.';
    } else {
      ownersVal = listOf(res.owners);
    }

    let modulesVal, modulesExtra;
    if (res.modulesError) {
      modulesVal = revertedSpan(res.modulesError);
      modulesExtra = 'getModulesPaginated() reverts when the modules list is unterminated, usually on an uninitialized proxy.';
    } else {
      modulesVal = listOf(res.modules);
    }

    return kvList([
      ['VERSION()',              versionVal],
      ['getThreshold()',         thresholdVal],
      ['nonce()',                nonceVal],
      ['getOwners()',            ownersVal, ownersExtra],
      ['getModulesPaginated()',  modulesVal, modulesExtra],
    ], 'kv-code');
  }

  // Storage key: fixed-width slot column, then the variable name.
  function slotKey(slot, name, title) {
    return el('span', { class: 'slot-key', title: title || null }, [
      el('span', { class: 'slot-no' }, slot),
      name,
    ]);
  }

  function buildStorageBlock(res, cid) {
    function annot(ok, okText, badText) {
      return ok ? checkSpan('ok', okText) : checkSpan('bad', badText);
    }

    function uintCell(value, error, annotation) {
      if (error) return revertedSpan(error);
      return el('span', null, [el('span', { class: 'mono' }, value.toString()), annotation]);
    }

    function addrCell(addr, error) {
      if (error) return revertedSpan(error);
      if (addr === window.SAFE_INTROSPECT.ZERO_ADDR) {
        return el('span', { class: 'muted' }, 'Not set');
      }
      return fullAddrCell(cid, addr);
    }

    let ownerCountAnnot = null;
    if (!res.ownerCountStorageError && res.owners != null) {
      const visibleOwnerCount = BigInt(res.owners.length);
      const match = res.ownerCountStorage === visibleOwnerCount;
      ownerCountAnnot = annot(match,
        'matches getOwners().length',
        'differs from getOwners().length (' + res.owners.length + ')');
    }
    let thresholdAnnot = null;
    if (!res.thresholdStorageError && res.thresholdView != null) {
      const match = res.thresholdStorage === res.thresholdView;
      thresholdAnnot = annot(match,
        'matches getThreshold()',
        'differs from getThreshold() (' + res.thresholdView.toString() + ')');
    }
    let nonceAnnot = null;
    if (!res.nonceStorageError && res.nonceView != null) {
      const match = res.nonceStorage === res.nonceView;
      nonceAnnot = annot(match,
        'matches nonce()',
        'differs from nonce() (' + res.nonceView.toString() + ')');
    }

    return kvList([
      [slotKey('0', 'singleton'),  addrCell(res.singletonStorage, res.singletonStorageError)],
      [slotKey('3', 'ownerCount'), uintCell(res.ownerCountStorage, res.ownerCountStorageError, ownerCountAnnot)],
      [slotKey('4', 'threshold'),  uintCell(res.thresholdStorage, res.thresholdStorageError, thresholdAnnot)],
      [slotKey('5', 'nonce'),      uintCell(res.nonceStorage, res.nonceStorageError, nonceAnnot)],
      [slotKey('keccak', 'fallbackHandler', 'keccak256("fallback_manager.handler.address")'), addrCell(res.fallbackHandler, res.fallbackHandlerError)],
      [slotKey('keccak', 'guard', 'keccak256("guard_manager.guard.address")'),               addrCell(res.guard, res.guardError)],
      [slotKey('keccak', 'moduleGuard', 'keccak256("module_manager.module_guard.address")'), addrCell(res.moduleGuard, res.moduleGuardError)],
    ], 'kv-code');
  }

  function buildWebAuthnStorageBlock(signers, cid) {
    const rows = [];
    for (const signer of signers) {
      const verifier = '0x' + signer.verifiers.toString(16).padStart(40, '0').slice(-40);
      const state = signer.configured
        ? checkSpan('ok', '3 configured storage words')
        : checkSpan('bad', 'owner is present but config storage is empty');
      rows.push(
        [signer.generation === 'legacy' ? 'passkey owner (legacy)' : 'passkey owner',
          fullAddrCell(cid, signer.owner), state],
        ['config +0 (P-256 x)', storageWordCell(signer.baseSlot, signer.x)],
        ['config +1 (P-256 y)', storageWordCell(contiguousHex(signer.baseSlot, 1n), signer.y)],
        ['config +2 (verifier)', storageWordCell(contiguousHex(signer.baseSlot, 2n), signer.verifiers),
          fullAddrCell(cid, verifier)],
        signer.publicKeyHash ? ['public-key hash', hashShort(signer.publicKeyHash)] : null,
      );
    }

    // Live RPC only — WebAuthn reconciliation is the reviewer's job, not elimination.
    const note = el('div', { class: 'callout' }, [
      el('p', null, [
        el('strong', null, 'Passkey configuration. '),
        'These storage words are absent from Safe view methods and can explain a storage-root mismatch.',
      ]),
      whyDetails('Why this can happen', [
        el('p', null, 'SafeWebAuthnSharedSigner stores the passkey configuration in the Safe through a setup delegatecall. The reviewer reconciles known shared signers; unconfigured ones surface as needs_investigation.'),
      ]),
    ]);

    return el('div', null, [kvList(rows, 'kv-code'), note]);
  }

  function contiguousHex(slot, offset) {
    return '0x' + (BigInt(slot) + BigInt(offset)).toString(16).padStart(64, '0');
  }

  function storageWordCell(slot, value) {
    const word = '0x' + BigInt(value).toString(16).padStart(64, '0');
    return el('span', { class: 'word-cell' }, [
      el('span', { class: 'muted' }, 'slot '), hashShort(slot),
      el('span', { class: 'muted' }, ' = '), hashShort(word),
    ]);
  }

  function buildLinkedListBlock(res) {
    const SENT = window.SAFE_INTROSPECT.SENTINEL;

    function renderChain(label, links) {
      const row = el('div', { class: 'll-row' }, [el('span', { class: 'll-label mono' }, label)]);
      if (!links) {
        row.appendChild(el('span', { class: 'muted small' }, 'Skipped: the list could not be enumerated.'));
        return row;
      }
      const chain = [SENT];
      const linkMap = new Map();
      for (const l of links) linkMap.set(l.from.toLowerCase(), l.next);
      let cur = SENT;
      let steps = 0;
      while (steps < 256) {
        const next = linkMap.get(cur.toLowerCase());
        if (!next) break;
        chain.push(next);
        if (next.toLowerCase() === SENT.toLowerCase()) break;
        cur = next;
        steps++;
      }
      const closes = chain[chain.length - 1].toLowerCase() === SENT.toLowerCase();

      const chips = el('span', { class: 'll-chain' });
      chain.forEach(function (a, i) {
        const isSent = a.toLowerCase() === SENT.toLowerCase();
        chips.appendChild(el('span', { class: 'll-node' }, [
          el('span', { class: 'll-chip mono' + (isSent ? ' ll-chip-sentinel' : ''), title: a },
            isSent ? 'SENTINEL' : shortAddr(a)),
          i < chain.length - 1 ? el('span', { class: 'll-sep' }, icon('arrow-right')) : null,
        ]));
      });
      chips.appendChild(closes
        ? checkSpan('ok', 'closes')
        : checkSpan('bad', 'does not close in SENTINEL'));
      row.appendChild(chips);
      return row;
    }

    return el('div', { class: 'll' }, [
      renderChain('owners', res.ownerLinks),
      renderChain('modules', res.moduleLinks),
    ]);
  }

  function buildInterpretationBlock() {
    return el('div', { class: 'callout' }, [
      el('p', null, [
        'The reads above cannot show which storage entries cause the mismatch. ',
        el('strong', null, 'Treat this Safe as potentially compromised'),
        ' until a shadow owner or module is ruled out.',
      ]),
      whyDetails('What to check next', [
        el('ul', null, [
          el('li', null, 'Inspect the deploy tx and any delegatecalls inside it.'),
          el('li', null, 'If the deployer is a contract, audit its source.'),
          el('li', null, 'Check suspect addresses below. A shadow owner passes isOwner() and can co-sign; a shadow module can call execTransactionFromModule.'),
          el('li', null, 'Check whether anyone called signMessage / approveHash on this Safe (rules out the slot 6/7 false positive).'),
          el('li', null, 'If you cannot clear it, rotate signers, redeploy or migrate assets, and coordinate with the Safe Security Council.'),
        ]),
      ]),
    ]);
  }

  // ────────────────────────────────────────────────────────────────────
  // Probe: check a candidate address
  // ────────────────────────────────────────────────────────────────────

  function buildProbeBlock(res, safe, cid) {
    const helpId = 'probe-help';
    const input = el('input', {
      type: 'text',
      class: 'input probe-input',
      placeholder: '0x…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Address to check',
      'aria-describedby': helpId,
      'data-probe-input': '',
    });
    const btn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Check');
    const errLine = el('div', { class: 'error-line', role: 'alert' });
    const result = el('div', { class: 'probe-result', 'aria-live': 'polite' });

    function runProbe() {
      const v = (input.value || '').trim().toLowerCase();
      errLine.textContent = '';
      result.innerHTML = '';
      if (!isAddress(v)) {
        errLine.textContent = ADDR_ERROR;
        return;
      }
      if (v === window.SAFE_INTROSPECT.SENTINEL) {
        errLine.textContent = 'This is the linked-list sentinel, not an owner or module.';
        return;
      }
      if (v === window.SAFE_INTROSPECT.ZERO_ADDR) {
        errLine.textContent = 'The zero address cannot be an owner or module.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Checking…';
      window.probeCandidate(cid, safe.address, v, res.owners, res.modules)
        .then(function (probe) {
          renderProbeResult(result, v, probe, cid);
        })
        .catch(function (err) {
          result.innerHTML = '';
          result.appendChild(el('p', { class: 'error-msg' },
            'Check failed: ' + ((err && err.message) || String(err))));
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Check';
        });
    }

    btn.addEventListener('click', runProbe);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runProbe(); }
    });

    return el('section', { class: 'introspect-section probe', 'data-probe': '' }, [
      el('h3', { class: 'introspect-h' }, 'Check an address'),
      el('p', { class: 'muted small', id: helpId },
        'Paste a suspected shadow owner or module address to check whether it is one.'),
      el('div', { class: 'probe-row' }, [input, btn]),
      errLine,
      result,
    ]);
  }

  // Per mapping: 'shadow' | 'visible' | 'unknown' (set, but the visible list
  // could not be read to tell) | 'unset'.
  function mappingKind(zero, isShadow, isVisible, listKnown) {
    if (zero) return 'unset';
    if (isVisible) return 'visible';
    if (isShadow) return listKnown ? 'shadow' : 'unknown';
    return 'unset';
  }

  function probeVerdict(candidate, ownerKind, moduleKind) {
    const who = el('span', { class: 'mono' }, shortAddr(candidate));
    const shadows = [];
    if (ownerKind === 'shadow') shadows.push('a shadow owner');
    if (moduleKind === 'shadow') shadows.push('a shadow module');
    const visibles = [];
    if (ownerKind === 'visible') visibles.push('a visible owner');
    if (moduleKind === 'visible') visibles.push('a visible module');

    if (shadows.length) {
      return el('p', { class: 'probe-verdict probe-verdict--danger' }, [
        icon('alert'),
        el('span', null, [
          el('strong', null, [who, ' is ' + shadows.join(' and ')]),
          ' of this Safe' + (visibles.length ? ', and also ' + visibles.join(' and ') : '') + '.',
        ]),
      ]);
    }
    if (ownerKind === 'unknown' || moduleKind === 'unknown') {
      return el('p', { class: 'probe-verdict probe-verdict--warn' }, [
        icon('alert'),
        el('span', null, [
          el('strong', null, [who, ' has a storage entry']),
          ' in this Safe, but the visible list could not be read to tell whether it is a shadow entry.',
        ]),
      ]);
    }
    if (visibles.length) {
      return el('p', { class: 'probe-verdict' }, [
        icon('check'),
        el('span', null, [
          el('strong', null, [who, ' is ' + visibles.join(' and ')]),
          ' of this Safe, with no shadow entry.',
        ]),
      ]);
    }
    return el('p', { class: 'probe-verdict' }, [
      icon('check'),
      el('span', null, [el('strong', null, who), ' is not an owner or module of this Safe.']),
    ]);
  }

  function probeBadge(kind, role) {
    if (kind === 'shadow') return el('span', { class: 'badge badge-danger' }, 'Shadow ' + role);
    if (kind === 'visible') return el('span', { class: 'badge badge-neutral' }, 'Visible ' + role);
    if (kind === 'unknown') return el('span', { class: 'badge badge-warn' }, 'Set, unverified');
    return el('span', { class: 'badge' }, 'Not set');
  }

  function renderProbeResult(container, candidate, probe, cid) {
    container.innerHTML = '';
    const ownerKind = mappingKind(probe.ownersZero, probe.shadowOwner, probe.isVisibleOwner, probe.visibleOwnersKnown);
    const moduleKind = mappingKind(probe.modulesZero, probe.shadowModule, probe.isVisibleModule, probe.visibleModulesKnown);

    function row(mapping, kind, role, word, zero) {
      return el('div', { class: 'probe-tr', role: 'row' }, [
        el('span', { class: 'probe-td mono', role: 'cell' }, mapping),
        el('span', { class: 'probe-td', role: 'cell' }, probeBadge(kind, role)),
        el('span', { class: 'probe-td probe-slot', role: 'cell' }, [
          el('span', { class: 'mono' + (zero ? ' muted' : ''), title: word },
            word.slice(0, 6) + '…' + word.slice(-4)),
          copyButton(word, { iconOnly: true, label: 'Copy ' + role + 's slot value' }),
        ]),
      ]);
    }

    container.appendChild(probeVerdict(candidate, ownerKind, moduleKind));
    container.appendChild(el('div', { class: 'probe-table', role: 'table', 'aria-label': 'Storage slots for ' + candidate }, [
      el('div', { class: 'probe-tr probe-thead', role: 'row' }, [
        el('span', { class: 'probe-th', role: 'columnheader' }, 'Mapping'),
        el('span', { class: 'probe-th', role: 'columnheader' }, 'Verdict'),
        el('span', { class: 'probe-th', role: 'columnheader' }, 'Slot value'),
      ]),
      row('owners', ownerKind, 'owner', probe.ownersSlot, probe.ownersZero),
      row('modules', moduleKind, 'module', probe.modulesSlot, probe.modulesZero),
    ]));

    container.appendChild(el('p', { class: 'probe-foot muted small' }, [
      el('span', null, 'Read directly from the owners[X] and modules[X] storage slots at the latest block.'),
      externalLink(cid, 'address', candidate, 'Explorer'),
    ]));
  }
})();
