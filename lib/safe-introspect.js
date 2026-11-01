// Live Safe state introspection from a public RPC.
//
// Exposes:
//   window.loadSafeIntrospection(chainId, safeAddr) -> Promise<IntrospectionResult>
//   window.probeCandidate(chainId, safeAddr, candidate, visibleOwners, visibleModules)
//
// Slot constants and `mappingSlot()` mirror scanner/src/lib/slots.ts.
// Function selectors are precomputed (4-byte hash of the canonical signature).
// Depends on js-sha3 (window.keccak_256) for mapping-slot derivation, and
// window.rpcCall / window.rpcBatch from lib/rpc.js.

(function () {
  const SENTINEL = '0x0000000000000000000000000000000000000001';
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  // Safe's passkey signers. Their configure() method is delegatecalled during
  // setup, so the public-key configuration intentionally lives in the Safe's
  // storage rather than in the signer contract's storage. The legacy
  // deployment emits no configuration event, so storage is the only place
  // its passkey shows up.
  const SAFE_WEBAUTHN_SHARED_SIGNERS = {
    '0x94a4f6affbd8975951142c3999aeab7ecee555c2': 'current',
    '0xfd90fad33ee8b58f32c00aceead1358e4afc23f9': 'legacy',
  };
  const SAFE_WEBAUTHN_SHARED_SIGNER_MAPPING_SLOT =
    0x2e0aed53485dc2290ceb5ce14725558ad3e3a09d38c69042410ad15c2b4ea4e8n;

  // Function selectors. Computed once: keccak256(signature)[:4].
  // getOwners()                          -> 0xa0e67e2b
  // getThreshold()                       -> 0xe75235b8
  // nonce()                              -> 0xaffed0e0
  // VERSION()                            -> 0xffa1ad74
  // getModulesPaginated(address,uint256) -> 0xcc2f8452
  const SEL_GET_OWNERS      = '0xa0e67e2b';
  const SEL_GET_THRESHOLD   = '0xe75235b8';
  const SEL_NONCE           = '0xaffed0e0';
  const SEL_VERSION         = '0xffa1ad74';
  const SEL_GET_MODULES_PAG = '0xcc2f8452';

  // Fixed slots (uint256 -> 32-byte hex).
  const SLOT_SINGLETON   = '0x' + '0'.repeat(63) + '0';
  const SLOT_OWNER_COUNT = '0x' + '0'.repeat(63) + '3';
  const SLOT_THRESHOLD   = '0x' + '0'.repeat(63) + '4';
  const SLOT_NONCE       = '0x' + '0'.repeat(63) + '5';
  // String-derived slots: keccak256("...") of the canonical Safe identifiers.
  const SLOT_FALLBACK_HANDLER = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
  const SLOT_GUARD            = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
  const SLOT_MODULE_GUARD     = '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947';

  function strip0x(h) {
    if (typeof h !== 'string') return '';
    return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
  }

  function pad32Hex(h) {
    return strip0x(h).toLowerCase().padStart(64, '0');
  }

  function pad32Uint(u) {
    return BigInt(u).toString(16).padStart(64, '0');
  }

  function hexToBytes(hex) {
    const h = strip0x(hex);
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(h.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function keccak() {
    // js-sha3 attaches `keccak_256` (and others) to the global scope when loaded
    // via <script>. Some bundlers expose `sha3.keccak_256`. Resolve once.
    const fn = (typeof keccak_256 !== 'undefined') ? keccak_256
      : (window.keccak_256 || (window.sha3 && window.sha3.keccak_256));
    if (!fn) throw new Error('keccak_256 not available; load js-sha3 before safe-introspect.js');
    return fn;
  }

  function mappingSlot(addr, slotIdx) {
    // keccak256(abi.encode(addr, slotIdx))
    const k = keccak();
    const concatHex = pad32Hex(addr) + pad32Uint(slotIdx);
    return '0x' + k(hexToBytes('0x' + concatHex));
  }

  function contiguousSlot(slot, offset) {
    return '0x' + (BigInt(slot) + BigInt(offset)).toString(16).padStart(64, '0');
  }

  function webAuthnSharedSignerSlot(sharedSigner) {
    return mappingSlot(sharedSigner, SAFE_WEBAUTHN_SHARED_SIGNER_MAPPING_SLOT);
  }

  function publicKeyHash(x, y) {
    const k = keccak();
    return '0x' + k(hexToBytes('0x' + pad32Uint(x) + pad32Uint(y)));
  }

  function decodeAddress(word) {
    // word is 32-byte hex; address is the low 20 bytes (last 40 chars).
    const h = strip0x(word).toLowerCase().padStart(64, '0');
    return '0x' + h.slice(24);
  }

  function decodeUint256(word) {
    if (!word || word === '0x') return 0n;
    return BigInt(word);
  }

  function decodeAddressArray(retData) {
    const h = strip0x(retData);
    if (h.length < 128) return [];
    // [offset(32) | length(32) | items...]
    const length = parseInt(h.slice(64, 128), 16);
    const out = [];
    for (let i = 0; i < length; i++) {
      const word = '0x' + h.slice(128 + i * 64, 128 + (i + 1) * 64);
      out.push(decodeAddress(word));
    }
    return out;
  }

  function decodeModulesPaginated(retData) {
    // ABI: returns (address[] array, address next)
    // Layout: head [offset_to_array(32) | next(32)], then at offset: [length(32) | items...]
    const h = strip0x(retData);
    if (h.length < 128) return { array: [], next: SENTINEL };
    const offset = parseInt(h.slice(0, 64), 16);
    const next = decodeAddress('0x' + h.slice(64, 128));
    const lenStart = offset * 2;
    if (h.length < lenStart + 64) return { array: [], next: next };
    const length = parseInt(h.slice(lenStart, lenStart + 64), 16);
    const out = [];
    for (let i = 0; i < length; i++) {
      const wordStart = lenStart + 64 + i * 64;
      out.push(decodeAddress('0x' + h.slice(wordStart, wordStart + 64)));
    }
    return { array: out, next: next };
  }

  function decodeString(retData) {
    const h = strip0x(retData);
    if (h.length < 128) return '';
    const length = parseInt(h.slice(64, 128), 16);
    const dataHex = h.slice(128, 128 + length * 2);
    let out = '';
    for (let i = 0; i < dataHex.length; i += 2) {
      out += String.fromCharCode(parseInt(dataHex.substr(i, 2), 16));
    }
    return out;
  }

  function ethCall(safeAddr, data, blockTag) {
    return { method: 'eth_call', params: [{ to: safeAddr, data: data }, blockTag] };
  }

  function ethGetStorageAt(safeAddr, slot, blockTag) {
    return { method: 'eth_getStorageAt', params: [safeAddr, slot, blockTag] };
  }

  function isZeroWord(word) {
    if (!word) return true;
    const h = strip0x(word).replace(/^0+/, '');
    return h === '';
  }

  function isErr(x) {
    return x && typeof x === 'object' && x.__rpcError;
  }

  function shortRpcErr(e) {
    if (!e) return 'unknown error';
    return (e.message || JSON.stringify(e)).slice(0, 120);
  }

  async function loadSafeIntrospection(chainId, safeAddr) {
    safeAddr = safeAddr.toLowerCase();

    // 1) Pin the block so all reads are consistent.
    const blockResp = await window.rpcCall(chainId, 'eth_blockNumber', []);
    const blockTag = blockResp.result;

    // 2) View methods + raw storage in one batched HTTP request.
    const baseCalls = [
      ethCall(safeAddr, SEL_VERSION, blockTag),
      ethCall(safeAddr, SEL_GET_THRESHOLD, blockTag),
      ethCall(safeAddr, SEL_NONCE, blockTag),
      ethCall(safeAddr, SEL_GET_OWNERS, blockTag),
      ethCall(safeAddr,
        SEL_GET_MODULES_PAG + pad32Hex(SENTINEL) + pad32Uint(100n),
        blockTag),
      ethGetStorageAt(safeAddr, SLOT_SINGLETON,        blockTag),
      ethGetStorageAt(safeAddr, SLOT_OWNER_COUNT,      blockTag),
      ethGetStorageAt(safeAddr, SLOT_THRESHOLD,        blockTag),
      ethGetStorageAt(safeAddr, SLOT_NONCE,            blockTag),
      ethGetStorageAt(safeAddr, SLOT_FALLBACK_HANDLER, blockTag),
      ethGetStorageAt(safeAddr, SLOT_GUARD,            blockTag),
      ethGetStorageAt(safeAddr, SLOT_MODULE_GUARD,     blockTag),
    ];
    const batch = await window.rpcBatch(chainId, baseCalls);
    const r = batch.results;

    // View-method calls can revert on uninitialized proxies (no setup() ever
    // called -> threshold=0, owners[SENTINEL]=0 -> getOwners walks an
    // unterminated list and OOGs). Handle each result independently so a
    // revert in one method doesn't blow up the whole card.
    function unwrapView(idx, decode) {
      const v = r[idx];
      if (isErr(v)) return { value: null, error: v.__rpcError };
      try { return { value: decode(v), error: null }; }
      catch (e) { return { value: null, error: { message: 'decode failed: ' + (e && e.message) } }; }
    }
    function unwrapStorage(idx, decode) {
      const v = r[idx];
      if (isErr(v)) return { value: null, error: v.__rpcError };
      try { return { value: decode(v), error: null }; }
      catch (e) { return { value: null, error: { message: 'decode failed: ' + (e && e.message) } }; }
    }

    const versionR = unwrapView(0, decodeString);
    const thresholdR = unwrapView(1, decodeUint256);
    const nonceR = unwrapView(2, decodeUint256);
    const ownersR = unwrapView(3, decodeAddressArray);
    const modulesR = unwrapView(4, decodeModulesPaginated);
    const singletonR = unwrapStorage(5, decodeAddress);
    const ownerCountR = unwrapStorage(6, decodeUint256);
    const thresholdStorageR = unwrapStorage(7, decodeUint256);
    const nonceStorageR = unwrapStorage(8, decodeUint256);
    const fallbackR = unwrapStorage(9, decodeAddress);
    const guardR = unwrapStorage(10, decodeAddress);
    const moduleGuardR = unwrapStorage(11, decodeAddress);

    const owners = ownersR.value || null;
    const modulesArr = (modulesR.value && modulesR.value.array) || null;
    const modulesNextPage = (modulesR.value && modulesR.value.next) || null;

    // 3) Linked-list walk: only feasible when owners + modules are enumerable.
    //    Also reads head pointers owners[SENTINEL] / modules[SENTINEL].
    let ownerLinks = null;
    let moduleLinks = null;
    if (owners && modulesArr) {
      const linkCalls = [];
      linkCalls.push(ethGetStorageAt(safeAddr, mappingSlot(SENTINEL, 2n), blockTag));
      linkCalls.push(ethGetStorageAt(safeAddr, mappingSlot(SENTINEL, 1n), blockTag));
      for (const o of owners) {
        linkCalls.push(ethGetStorageAt(safeAddr, mappingSlot(o, 2n), blockTag));
      }
      for (const m of modulesArr) {
        linkCalls.push(ethGetStorageAt(safeAddr, mappingSlot(m, 1n), blockTag));
      }

      try {
        const linkBatch = await window.rpcBatch(chainId, linkCalls);
        const lr = linkBatch.results;
        function safeAddr32(idx) {
          const v = lr[idx];
          return isErr(v) ? null : decodeAddress(v);
        }
        let idx = 0;
        const ownersHead = safeAddr32(idx++);
        const modulesHead = safeAddr32(idx++);
        ownerLinks = ownersHead != null ? [{ from: SENTINEL, next: ownersHead }] : null;
        if (ownerLinks) {
          for (let i = 0; i < owners.length; i++) {
            const next = safeAddr32(idx++);
            if (next == null) { ownerLinks = null; break; }
            ownerLinks.push({ from: owners[i], next: next });
          }
        }
        if (ownerLinks == null) {
          // skip the rest of the owner reads; advance idx accordingly to keep
          // module reads aligned.
          idx = 2 + owners.length;
        }
        moduleLinks = modulesHead != null ? [{ from: SENTINEL, next: modulesHead }] : null;
        if (moduleLinks) {
          for (let i = 0; i < modulesArr.length; i++) {
            const next = safeAddr32(idx++);
            if (next == null) { moduleLinks = null; break; }
            moduleLinks.push({ from: modulesArr[i], next: next });
          }
        }
      } catch (_e) {
        // Network failure on the link batch -> leave links null; the rest of
        // the card still renders.
        ownerLinks = null;
        moduleLinks = null;
      }
    }

    // Standard Safe getters cannot reveal this extension state. Probe each
    // known shared signer only when it is actually an owner, keeping this to
    // three pinned storage reads per passkey signer and zero reads otherwise.
    const webAuthnSharedSigners = [];
    const signerOwners = (owners || [])
      .map(function (owner) { return owner.toLowerCase(); })
      .filter(function (owner, i, all) {
        return Object.prototype.hasOwnProperty.call(SAFE_WEBAUTHN_SHARED_SIGNERS, owner) && all.indexOf(owner) === i;
      });
    for (const signer of signerOwners) {
      const baseSlot = webAuthnSharedSignerSlot(signer);
      try {
        const configBatch = await window.rpcBatch(chainId, [
          ethGetStorageAt(safeAddr, baseSlot, blockTag),
          ethGetStorageAt(safeAddr, contiguousSlot(baseSlot, 1n), blockTag),
          ethGetStorageAt(safeAddr, contiguousSlot(baseSlot, 2n), blockTag),
        ]);
        const values = configBatch.results;
        if (!isErr(values[0]) && !isErr(values[1]) && !isErr(values[2])) {
          const x = decodeUint256(values[0]);
          const y = decodeUint256(values[1]);
          const verifiers = decodeUint256(values[2]);
          webAuthnSharedSigners.push({
            owner: signer,
            generation: SAFE_WEBAUTHN_SHARED_SIGNERS[signer],
            baseSlot: baseSlot,
            x: x,
            y: y,
            verifiers: verifiers,
            configured: x !== 0n || y !== 0n || verifiers !== 0n,
            publicKeyHash: (x !== 0n || y !== 0n) ? publicKeyHash(x, y) : null,
          });
        }
      } catch (_e) {
        // The base Safe state remains useful if this optional extension probe
        // is unavailable from a public RPC.
      }
    }

    return {
      providerUrl: batch.providerUrl,
      latencyMs: batch.latencyMs,
      block: parseInt(blockTag, 16),
      blockHex: blockTag,
      version: versionR.value,
      versionError: versionR.error,
      thresholdView: thresholdR.value,
      thresholdViewError: thresholdR.error,
      nonceView: nonceR.value,
      nonceViewError: nonceR.error,
      owners: owners,
      ownersError: ownersR.error,
      modules: modulesArr,
      modulesError: modulesR.error,
      modulesNextPage: modulesNextPage,
      singletonStorage: singletonR.value,
      singletonStorageError: singletonR.error,
      ownerCountStorage: ownerCountR.value,
      ownerCountStorageError: ownerCountR.error,
      thresholdStorage: thresholdStorageR.value,
      thresholdStorageError: thresholdStorageR.error,
      nonceStorage: nonceStorageR.value,
      nonceStorageError: nonceStorageR.error,
      fallbackHandler: fallbackR.value,
      fallbackHandlerError: fallbackR.error,
      guard: guardR.value,
      guardError: guardR.error,
      moduleGuard: moduleGuardR.value,
      moduleGuardError: moduleGuardR.error,
      ownerLinks: ownerLinks,
      moduleLinks: moduleLinks,
      webAuthnSharedSigners: webAuthnSharedSigners,
    };
  }

  async function probeCandidate(chainId, safeAddr, candidate, visibleOwners, visibleModules) {
    safeAddr = safeAddr.toLowerCase();
    candidate = candidate.toLowerCase();
    const calls = [
      ethGetStorageAt(safeAddr, mappingSlot(candidate, 2n), 'latest'),
      ethGetStorageAt(safeAddr, mappingSlot(candidate, 1n), 'latest'),
    ];
    const batch = await window.rpcBatch(chainId, calls);
    const ownersSlotRaw = batch.results[0];
    const modulesSlotRaw = batch.results[1];
    if (isErr(ownersSlotRaw) || isErr(modulesSlotRaw)) {
      const e = isErr(ownersSlotRaw) ? ownersSlotRaw.__rpcError : modulesSlotRaw.__rpcError;
      throw new Error('storage read failed: ' + shortRpcErr(e));
    }
    const ownersSlot = ownersSlotRaw;
    const modulesSlot = modulesSlotRaw;

    const ownersZero = isZeroWord(ownersSlot);
    const modulesZero = isZeroWord(modulesSlot);

    function inList(list, addr) {
      if (!list) return false;
      const a = addr.toLowerCase();
      for (const x of list) if (x.toLowerCase() === a) return true;
      return false;
    }

    const isVisibleOwner = inList(visibleOwners, candidate);
    const isVisibleModule = inList(visibleModules, candidate);

    // A non-zero owners[X] for X NOT in getOwners() is a shadow owner. Same for modules.
    // For a visible owner, owners[X] is the next-pointer in the linked list (legitimate).
    // If the visible-list is unknown (getOwners reverted), we cannot disambiguate; mark
    // any non-zero slot as an indicator that the user should investigate.
    return {
      providerUrl: batch.providerUrl,
      latencyMs: batch.latencyMs,
      ownersSlot: ownersSlot,
      modulesSlot: modulesSlot,
      ownersZero: ownersZero,
      modulesZero: modulesZero,
      isVisibleOwner: isVisibleOwner,
      isVisibleModule: isVisibleModule,
      visibleOwnersKnown: visibleOwners != null,
      visibleModulesKnown: visibleModules != null,
      shadowOwner: !ownersZero && (visibleOwners == null || !isVisibleOwner),
      shadowModule: !modulesZero && (visibleModules == null || !isVisibleModule),
    };
  }

  // Re-export a small set of helpers in case the UI layer wants to render
  // raw slot values consistently.
  window.SAFE_INTROSPECT = {
    SENTINEL: SENTINEL,
    ZERO_ADDR: ZERO_ADDR,
    SLOT_SINGLETON: SLOT_SINGLETON,
    SLOT_OWNER_COUNT: SLOT_OWNER_COUNT,
    SLOT_THRESHOLD: SLOT_THRESHOLD,
    SLOT_NONCE: SLOT_NONCE,
    SLOT_FALLBACK_HANDLER: SLOT_FALLBACK_HANDLER,
    SLOT_GUARD: SLOT_GUARD,
    SLOT_MODULE_GUARD: SLOT_MODULE_GUARD,
    SAFE_WEBAUTHN_SHARED_SIGNERS: SAFE_WEBAUTHN_SHARED_SIGNERS,
    mappingSlot: mappingSlot,
    isZeroWord: isZeroWord,
  };
  window.loadSafeIntrospection = loadSafeIntrospection;
  window.probeCandidate = probeCandidate;
})();
