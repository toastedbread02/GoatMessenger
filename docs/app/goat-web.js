// Browser shim for the GoatMessenger renderer.
//
// The desktop app injects `window.goat` (Electron preload). Loaded before the
// app bundle on the website, this shim implements the same narrow bridge in
// plain browser APIs, so ui/app.mjs runs unmodified in a tab:
//   - relay config / health checks against any relay URL (ngrok-ready)
//   - session restore via localStorage, namespaced per browser "window" (?w=)
//   - file save via blob download; screen share via getDisplayMedia
// When `window.goat` already exists (packaged app) this script does nothing.
'use strict';

(() => {
  if (window.goat) return;
  if (!window.isSecureContext) {
    // crypto.subtle is required for the E2EE layer.
    console.error('[goat-web] GoatMessenger needs a secure context (https or localhost).');
  }

  const DEFAULT_RELAY = 'https://epilogue-exquisite-press.ngrok-free.dev';
  const params = new URLSearchParams(location.search);
  // Each browser-tab "window" gets its own stored session so two tabs can hold
  // two different accounts, like the desktop app's second window.
  const winTag = params.get('w') ? `:${params.get('w')}` : '';
  const LS = {
    session: `gmweb:session${winTag}`,
    relay: 'gmweb:relay',
    net: 'gmweb:net',
  };
  let relayUrl = params.get('relay')
    || localStorage.getItem(LS.relay)
    || DEFAULT_RELAY;

  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

  const healthCheck = async (url, timeout = 6000) => {
    try {
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'ngrok-skip-browser-warning': 'goatmessenger' },
      });
      if (!res.ok) return false;
      const body = await res.json();
      return body && body.name === 'goatmessenger';
    } catch {
      return false;
    }
  };

  async function relayCandidate(candidate) {
    let url = String(candidate || relayUrl || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) url = url ? `http://${url}` : '';
    return url;
  }

  window.goat = {
    // -- identity of this session -----------------------------------------
    partition: `persist:goatweb${winTag}`,
    platform: 'web',

    info: () => {
      const stored = readJson(LS.net, {});
      return {
        relayUrl,
        relayError: '',
        version: 'web',
        platform: 'web',
        userData: '',
        e2e: false,
        fakeMedia: false,
        net: {
          relayUrl: stored.relayUrl || relayUrl,
          turn: stored.turn || null,
          forceRelay: Boolean(stored.forceRelay),
          embedded: false,
        },
      };
    },

    retryRelay: async () => {
      const ok = await healthCheck(relayUrl);
      return ok ? { relayUrl, relayError: '' } : { relayUrl, relayError: `No relay answering at ${relayUrl}.` };
    },

    // -- relay configuration (Settings → Network) --------------------------
    net: {
      get: () => readJson(LS.net, { relayUrl, turn: null, forceRelay: false }),
      test: async (candidate) => {
        const url = await relayCandidate(candidate);
        if (!url) return { ok: false, error: 'Enter a relay address.' };
        const started = Date.now();
        const ok = await healthCheck(url);
        return ok
          ? { ok: true, url, ms: Date.now() - started }
          : { ok: false, error: `No relay answering at ${url}.` };
      },
      set: async (next) => {
        const current = readJson(LS.net, {});
        const merger = { ...current, ...next };
        const changedRelay = next && next.relayUrl !== undefined && next.relayUrl !== current.relayUrl;
        if (changedRelay) {
          const url = await relayCandidate(next.relayUrl);
          if (!url) return { ok: false, error: 'Enter a relay address.' };
          const ok = await healthCheck(url);
          if (!ok) return { ok: false, error: `No relay answering at ${url}.` };
          merger.relayUrl = url;
          localStorage.setItem(LS.relay, url);
          relayUrl = url;
        }
        writeJson(LS.net, merger);
        return { ok: true, relayUrl, restartNeeded: false, net: merger };
      },
    },

    // -- stored login (localStorage instead of the OS keychain) -------------
    session: {
      load: () => readJson(LS.session, null),
      save: (payload) => { writeJson(LS.session, payload); return true; },
      clear: () => { localStorage.removeItem(LS.session); return true; },
    },

    // -- plain-browser stand-ins -------------------------------------------
    newWindow: () => {
      const url = new URL(location.href);
      if (!url.searchParams.get('w')) url.searchParams.set('w', Math.random().toString(36).slice(2, 7));
      else url.searchParams.set('w2', Math.random().toString(36).slice(2, 7));
      window.open(url.toString(), '_blank');
      return true;
    },
    setBadge: async () => true,
    setTheme: async () => true,
    requestMedia: async () => true,
    openPath: async (target) => {
      if (typeof target === 'string' && target.startsWith('blob:')) { window.open(target); return true; }
      return 'refused';
    },
    revealPath: async () => true,

    screen: {
      sources: async () => {
        if (!navigator.mediaDevices?.getDisplayMedia) return [];
        // One synthetic card: the browser shows its own picker on share.
        return [{ id: 'browser-picker', name: 'Screen or window…', thumbnail: '' }];
      },
      pick: async () => true,
      clear: async () => true,
      openPrefs: async () => true,
    },
  };

  // Small browser-mode badge so users know they are not in the app.
  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'web-bar';
    bar.textContent = 'Browser mode — needs a running relay; give the full goat app a try for calls that need desktop capture.';
    document.body?.append(bar);
  });
})();
