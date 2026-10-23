/* ==========================================================================
   WhatTheHTTP
   What actually happens when you hit Enter.

   How this file is organised:
   1.  Station list (the single source of truth for the map)
   2.  App state and DOM references
   3.  Small helpers (escaping, formatting, fetch with timeout)
   4.  Input cleaning and validation
   5.  Live data: DNS over HTTPS lookup, with fallback
   6.  Live data: rough round trip timing
   7.  Starting a trip
   8.  Drawing the metro map (track, stations, train)
   9.  Playback (autoplay clock, play, pause, speed)
   10. Station panels (one render function per station)
   11. Error and loading states
   12. Summary card as a PNG (canvas)
   13. Theme, mode, keyboard and wiring it all up

   No frameworks, no build step. Everything runs in your browser.
   ========================================================================== */
(() => {
  'use strict';

  /* 1. Stations ------------------------------------------------------------
     Each station belongs to a "line" (a layer of the trip), which sets its
     colour on the map. duration is how long autoplay stays here at 1x.
     needsDns marks stations that can't be shown until the lookup is back. */
  const STATIONS = [
    { id: 'enter',   short: 'Hit Enter', title: 'You hit Enter',          line: 'browser', badge: 'live',      duration: 7000 },
    { id: 'cache',   short: 'Cache',     title: 'Checking the memory',    line: 'browser', badge: 'explained', duration: 8000 },
    { id: 'dns',     short: 'DNS',       title: 'DNS lookup',             line: 'dns',     badge: 'live',      duration: 12000, needsDns: true },
    { id: 'tcp',     short: 'TCP',       title: 'Knock knock (TCP)',      line: 'conn',    badge: 'explained', duration: 9000,  needsDns: true },
    { id: 'tls',     short: 'TLS',       title: 'Secret handshake (TLS)', line: 'conn',    badge: 'explained', duration: 10000, needsDns: true },
    { id: 'http',    short: 'HTTP',      title: 'The ask (HTTP)',         line: 'http',    badge: 'explained', duration: 10000, needsDns: true },
    { id: 'render',  short: 'Render',    title: 'The page appears',       line: 'browser', badge: 'explained', duration: 9000,  needsDns: true },
    { id: 'summary', short: 'Arrived',   title: 'You have arrived',       line: 'browser', badge: 'live',      duration: 0,     needsDns: true },
  ];
  const DNS_INDEX = 2;
  const LAST = STATIONS.length - 1;

  /* Public DNS over HTTPS resolvers. Both return the same JSON shape. */
  const RESOLVERS = [
    { name: 'Cloudflare', ip: '1.1.1.1', url: 'https://cloudflare-dns.com/dns-query', headers: { accept: 'application/dns-json' } },
    { name: 'Google',     ip: '8.8.8.8', url: 'https://dns.google/resolve',           headers: {} },
  ];
  const DNS_TIMEOUT_MS = 7000;
  const PING_TIMEOUT_MS = 8000;

  /* DNS record type numbers we care about, and status codes (RCODEs). */
  const RR_TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 28: 'AAAA' };
  const RCODE = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

  /* 2. State and DOM ------------------------------------------------------- */
  const state = {
    trip: null,      // everything about the current trip (see startTrip)
    index: -1,       // which station we're at, -1 when idle
    playing: false,
    speed: 1,
    // The autoplay clock remembers how far through the station we are
    // (fraction 0..1) so pause, resume and speed changes stay in sync.
    clock: { fraction: 0, startedAt: 0, total: 0, timer: null },
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    root: document.documentElement,
    body: document.body,
    hero: $('#hero'),
    form: $('#address-form'),
    input: $('#site-input'),
    help: $('#input-help'),
    journey: $('#journey'),
    tripBar: $('#trip-bar'),
    tripHost: $('#trip-host'),
    newTrip: $('#new-trip'),
    map: $('#map'),
    track: $('#map-track'),
    stations: $('#stations'),
    train: $('#train'),
    controls: $('#controls'),
    prev: $('#btn-prev'),
    play: $('#btn-play'),
    next: $('#btn-next'),
    replay: $('#btn-replay'),
    speed: $('#btn-speed'),
    nowLabel: $('#now-label'),
    nowText: $('#now-text'),
    progress: $('#progress-bar'),
    panel: $('#panel'),
    panelInner: $('#panel-inner'),
    announcer: $('#announcer'),
    themeToggle: $('#theme-toggle'),
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 759px)');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  /* 3. Helpers ------------------------------------------------------------- */

  /** Escape text before putting it into HTML. Anything from the network or
      the user goes through this. */
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** DNS names come back with a trailing dot ("google.com."). Drop it. */
  const stripDot = (name) => String(name || '').toLowerCase().replace(/\.$/, '');

  const ms = (n) => `${Math.round(n)} ms`;

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  /** 300 -> "300 seconds (5 minutes)" */
  function formatTtl(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return plural(s, 'second');
    if (s < 3600) return `${plural(s, 'second')} (about ${plural(Math.round(s / 60), 'minute')})`;
    if (s < 86400) return `${plural(s, 'second')} (about ${plural(Math.round(s / 3600), 'hour')})`;
    return `${plural(s, 'second')} (about ${plural(Math.round(s / 86400), 'day')})`;
  }

  /** fetch() that gives up after a while, so a slow network can't hang us. */
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn a fetch failure into words a human can read. */
  function describeFetchError(err) {
    if (err && err.name === 'AbortError') return 'no answer within a few seconds (timed out)';
    if (err && /^HTTP \d+/.test(err.message)) return `answered with ${err.message}`;
    if (err && err.message === 'Unexpected reply') return 'sent back something that was not a DNS answer';
    return 'could not be reached (offline, blocked, or refused)';
  }

  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const loadingDots = '<span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

  /** IPv6 addresses need brackets when a port is attached: [2001:db8::1]:443 */
  const withPort = (ip, port) => (ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`);

  /* 4. Input cleaning ------------------------------------------------------
     People type all sorts of things: "Google.com", "https://github.com/x",
     " wikipedia.org/wiki/DNS ". We keep the path for the story, but DNS only
     ever gets the bare hostname. */
  function parseInput(raw) {
    const text = String(raw || '').trim();
    const fail = (reason, extra) => ({ ok: false, reason, extra });

    if (!text) return fail('empty');
    if (/\s/.test(text)) return fail('spaces');

    // Did they type a scheme? Only web ones make sense here.
    const schemeMatch = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    const typedScheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
    if (typedScheme && typedScheme !== 'http' && typedScheme !== 'https') return fail('scheme', typedScheme);
    if (!typedScheme && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return fail('scheme', text.split(':')[0]);

    // Let the browser's own URL parser do the heavy lifting. It lowercases
    // the host, converts non ASCII names to punycode, and finds the path.
    let url;
    try {
      url = new URL(typedScheme ? text : `https://${text}`);
    } catch {
      return fail('invalid');
    }

    const host = stripDot(url.hostname);

    if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return fail('ip', host);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return fail('local', host);
    if (!host.includes('.')) return fail('nodot', host);
    if (host.length > 253) return fail('long');

    // Each label: letters, digits, hyphens, 1 to 63 characters, no hyphen at the ends.
    const labels = host.split('.');
    const labelOk = (l) => l.length > 0 && l.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l);
    if (!labels.every(labelOk)) return fail('invalid');

    const tld = labels[labels.length - 1];
    if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return fail('tld', tld);

    // What the person actually typed as the hostname, for display (keeps emoji/unicode domains readable).
    const typedHost = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^.*@/, '').replace(/:\d+$/, '');

    return {
      ok: true,
      raw: text,
      host,
      displayHost: /[^\x00-\x7f]/.test(typedHost) ? typedHost.toLowerCase() : host,
      tld,
      typedScheme,
      port: url.port,
      path: url.pathname || '/',
      search: url.search,
    };
  }

  /** Friendly messages for each kind of bad input. */
  function inputErrorMessage(result) {
    const x = esc(result.extra || '');
    switch (result.reason) {
      case 'empty':  return 'Type a website first. Something like <code>example.com</code> is perfect.';
      case 'spaces': return 'Web addresses can\'t have spaces in them. Try something like <code>example.com</code>.';
      case 'scheme': return `<code>${x}:</code> isn't a website address. Just type the site, like <code>example.com</code>.`;
      case 'ip':     return `<code>${x}</code> is already an IP address, so there's no name to look up. Try a name like <code>example.com</code>.`;
      case 'local':  return `<code>${x}</code> lives on your own machine or network, so public DNS can't find it. Try a public site.`;
      case 'nodot':  return `<code>${x}</code> needs an ending like <code>.com</code> or <code>.org</code>. Did you mean <code>${x}.com</code>?`;
      case 'long':   return 'That name is longer than DNS allows (253 characters). Try a shorter one.';
      case 'tld':    return `<code>.${x}</code> doesn't look like a real domain ending. Try <code>.com</code>, <code>.org</code> or a country one like <code>.in</code>.`;
      default:       return 'That doesn\'t look like a web address. The format is <code>name.ending</code>, like <code>example.com</code>.';
    }
  }

  /* 5. Live DNS ------------------------------------------------------------ */

  /** One DNS question to one resolver. Returns the parsed JSON answer. */
  async function dohQuery(resolver, name, type) {
    const url = `${resolver.url}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchWithTimeout(url, {
      headers: resolver.headers,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }, DNS_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!json || typeof json.Status !== 'number') throw new Error('Unexpected reply');
    return json;
  }

  /** A DNS level problem (a real answer that says "no"), as opposed to a network failure. */
  function dnsError(kind, details) {
    const err = new Error(kind);
    err.kind = kind;
    Object.assign(err, details);
    return err;
  }

  /**
   * Look up a hostname. Tries Cloudflare first and falls back to Google if
   * Cloudflare can't be reached. Asks for A, AAAA and CNAME in parallel.
   * A real "no such domain" answer is NOT retried: it's a valid answer.
   */
  async function resolveHost(host) {
    if (navigator.onLine === false) {
      throw dnsError('unreachable', { offline: true, failures: [] });
    }

    const failures = [];
    for (const resolver of RESOLVERS) {
      let replies;
      const t0 = performance.now();
      try {
        replies = await Promise.all(['A', 'AAAA', 'CNAME'].map((t) => dohQuery(resolver, host, t)));
      } catch (err) {
        failures.push({ name: resolver.name, reason: describeFetchError(err) });
        continue; // try the next resolver
      }
      const elapsed = performance.now() - t0;
      const result = interpretDns(host, resolver, replies, elapsed, failures); // may throw a DNS error
      // Bonus: find the real authoritative name servers. Nice to have, never fatal.
      result.zone = await findZone(resolver, host).catch(() => null);
      return result;
    }
    throw dnsError('unreachable', { failures });
  }

  /** Turn three raw JSON replies into the facts we show. */
  function interpretDns(host, resolver, [a, aaaa, cname], elapsed, failures) {
    const soa = (a.Authority || []).find((r) => r.type === 6);
    const base = { resolver, raw: a, status: a.Status, soaZone: soa ? stripDot(soa.name) : null, failures };

    if (a.Status === 3) throw dnsError('nxdomain', base);
    if (a.Status === 2) throw dnsError('servfail', base);
    if (a.Status !== 0) throw dnsError('refused', base);

    const answers = a.Answer || [];

    // A CNAME chain shows up inside the A answer, in order: name -> alias -> ... -> address.
    let chain = answers.filter((r) => r.type === 5).map((r) => ({ from: stripDot(r.name), to: stripDot(r.data), ttl: r.TTL }));
    if (!chain.length) {
      chain = (cname.Answer || []).filter((r) => r.type === 5).map((r) => ({ from: stripDot(r.name), to: stripDot(r.data), ttl: r.TTL }));
    }

    const v4 = answers.filter((r) => r.type === 1).map((r) => ({ ip: r.data, ttl: r.TTL, name: stripDot(r.name) }));
    const v6 = (aaaa.Answer || []).filter((r) => r.type === 28).map((r) => ({ ip: r.data, ttl: r.TTL, name: stripDot(r.name) }));

    if (!v4.length && !v6.length) throw dnsError('nodata', base);

    // The shortest TTL in the final answer decides how long it can be cached.
    const ttl = Math.min(...(v4.length ? v4 : v6).map((r) => r.ttl));

    return {
      resolver,
      elapsed,
      failures,
      dnssec: Boolean(a.AD),
      chain,
      v4,
      v6,
      ttl,
      ip: (v4[0] || v6[0]).ip,
      finalName: chain.length ? chain[chain.length - 1].to : host,
      records: [...answers, ...(aaaa.Answer || []).filter((r) => r.type === 28)],
    };
  }

  /**
   * Find which zone a host lives in and its authoritative name servers.
   * Ask for NS records; if the name has none (www.example.com usually
   * doesn't), walk up one label at a time. At most four questions.
   */
  async function findZone(resolver, host) {
    let name = host;
    for (let tries = 0; tries < 4; tries++) {
      const reply = await dohQuery(resolver, name, 'NS');
      const ns = (reply.Answer || []).filter((r) => r.type === 2 && stripDot(r.name) === name).map((r) => stripDot(r.data));
      if (ns.length) return { zone: name, ns: ns.sort() };

      const soa = (reply.Authority || []).find((r) => r.type === 6);
      const soaName = soa ? stripDot(soa.name) : '';
      if (soaName && soaName.includes('.') && name.endsWith(`.${soaName}`)) { name = soaName; continue; }

      const parts = name.split('.');
      if (parts.length <= 2) return null;
      name = parts.slice(1).join('.');
    }
    return null;
  }

  /* 6. Live timing ---------------------------------------------------------
     A page can't send raw packets, but it can time a request. We ask for
     /favicon.ico in "no-cors" mode: we can't read the reply, but we can see
     when it arrives. The first request pays for DNS + TCP + TLS + HTTP. The
     next ones reuse the open connection, so they're close to one round trip
     plus a little server time. All of it is approximate. */
  async function measureTiming(host) {
    const target = () => `https://${host}/favicon.ico?wthttp=${Math.random().toString(36).slice(2, 10)}`;
    const once = async () => {
      const t0 = performance.now();
      await fetchWithTimeout(target(), { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }, PING_TIMEOUT_MS);
      return performance.now() - t0;
    };
    try {
      const cold = await once();
      const warm = [];
      for (let i = 0; i < 3; i++) {
        try { warm.push(await once()); } catch { /* one slow sample is fine */ }
      }
      return { cold, warm: warm.length ? Math.min(...warm) : null };
    } catch {
      return null;
    }
  }

  /* 7. Starting a trip ----------------------------------------------------- */
  function startTrip(parsed, { startAt = 0 } = {}) {
    const trip = {
      ...parsed,
      dns: { status: 'pending', data: null, error: null },
      timing: { status: 'idle', data: null },
      // Illustrative TCP numbers, fixed per trip so they don't change on re-render.
      clientPort: randInt(49152, 65535),
      isnClient: randInt(1e8, 4e9),
      isnServer: randInt(1e8, 4e9),
      startedAt: new Date(),
    };
    state.trip = trip;

    // Swap the hero for the compact trip bar.
    el.hero.hidden = true;
    el.tripBar.hidden = false;
    el.tripHost.textContent = trip.displayHost;
    el.controls.hidden = false;
    el.journey.classList.remove('is-idle');
    document.title = `${trip.displayHost} | WhatTheHTTP`;
    try { history.replaceState(null, '', `?site=${encodeURIComponent(trip.host)}`); } catch { /* file:// can refuse */ }

    // Kick off the real lookup straight away. The first two stations
    // don't need it, which buys us time.
    resolveHost(trip.host)
      .then((data) => {
        if (state.trip !== trip) return; // a newer trip started meanwhile
        trip.dns = { status: 'ok', data, error: null };
        startTiming(trip);
      })
      .catch((error) => {
        if (state.trip !== trip) return;
        trip.dns = { status: 'error', data: null, error };
      })
      .finally(() => {
        if (state.trip === trip) onDnsSettled();
      });

    setPlaying(!reducedMotion.matches, { silent: true });
    goTo(startAt);
    if (reducedMotion.matches) announce('Autoplay is off because your system prefers reduced motion. Use the arrow keys or the Next button.');
  }

  function startTiming(trip) {
    trip.timing = { status: 'pending', data: null };
    measureTiming(trip.host).then((data) => {
      if (state.trip !== trip) return;
      trip.timing = { status: data ? 'ok' : 'failed', data };
      fillTimingSlots();
      if (STATIONS[state.index].id === 'summary') renderPanel();
    });
  }

  /** Called once the DNS lookup is done, whatever the result. */
  function onDnsSettled() {
    const trip = state.trip;
    if (trip.dns.status === 'error' && state.index > DNS_INDEX) state.index = DNS_INDEX;
    updateStations();
    drawTrack();
    if (state.index >= DNS_INDEX) {
      // The panel was showing "looking up..." so draw the real thing now.
      renderPanel();
      resetClock();
      startClock();
    }
    updateControls();
  }

  function endTrip() {
    stopClock();
    state.trip = null;
    state.index = -1;
    state.playing = false;
    el.journey.classList.add('is-idle');
    el.journey.classList.remove('is-paused');
    el.hero.hidden = false;
    el.tripBar.hidden = true;
    el.controls.hidden = true;
    document.title = 'WhatTheHTTP: what actually happens when you hit Enter';
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    updateStations();
    placePanel();
    renderIdle();
    drawTrack();
    el.input.focus();
    el.input.select();
  }

  /** Can the train go to station i? Not past DNS if DNS failed. */
  function canVisit(i) {
    const trip = state.trip;
    if (!trip) return false;
    return !(trip.dns.status === 'error' && i > DNS_INDEX);
  }

  /** Is station i waiting for the DNS answer? */
  function isWaiting(i) {
    return Boolean(STATIONS[i].needsDns && state.trip && state.trip.dns.status === 'pending');
  }

  /** Move the train to a station. The heart of the app. */
  function goTo(i, { fromUser = false } = {}) {
    if (!state.trip) return;
    const target = Math.max(0, Math.min(LAST, i));
    if (!canVisit(target)) return;

    state.index = target;
    resetClock();
    // A freshly drawn station should always animate, even while paused.
    el.journey.classList.remove('is-frozen');
    updateStations();
    placePanel();
    renderPanel();
    drawTrack();
    updateControls();
    announce(`Station ${target + 1} of ${STATIONS.length}: ${STATIONS[target].title}`);

    // On phones, keep the active station on screen.
    if (mobile.matches && (fromUser || state.playing)) {
      const item = el.stations.children[target];
      item.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    }
    startClock();
  }

  /* 8. The metro map -------------------------------------------------------- */

  /** Build the station buttons once, from the STATIONS list. */
  function buildStations() {
    el.stations.innerHTML = STATIONS.map((s, i) => `
      <li class="station-item" data-line="${s.line}">
        <button type="button" class="station" data-index="${i}" disabled aria-label="Station ${i + 1}: ${esc(s.title)}">
          <span class="station-dot"></span>
          <span class="station-text">
            <span class="station-num">${String(i + 1).padStart(2, '0')}</span>
            <span class="station-name">${esc(s.short)}</span>
          </span>
        </button>
      </li>`).join('');

    // One segment between each pair of stations. Coloured by the line it leads into.
    el.track.innerHTML = STATIONS.slice(1).map((s) => `<span class="seg" data-line="${s.line}"><span class="seg-fill"></span></span>`).join('');
  }

  /** Update visited, active and closed classes on every station. */
  function updateStations() {
    const trip = state.trip;
    [...el.stations.children].forEach((li, i) => {
      const closed = Boolean(trip && !canVisit(i));
      li.classList.toggle('is-visited', Boolean(trip) && i <= state.index);
      li.classList.toggle('is-active', i === state.index);
      li.classList.toggle('is-closed', closed);
      const btn = li.querySelector('.station');
      btn.disabled = !trip || closed;
      if (i === state.index) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
    });
  }

  /**
   * Draw the track by measuring where the station dots actually are.
   * This is why one function works for both the horizontal (desktop) and
   * vertical (phone) layouts: CSS decides where stations go, and we just
   * join the dots.
   */
  function drawTrack() {
    const mapBox = el.map.getBoundingClientRect();
    const centres = [...el.stations.children].map((li) => {
      const r = li.querySelector('.station-dot').getBoundingClientRect();
      return { x: r.left + r.width / 2 - mapBox.left, y: r.top + r.height / 2 - mapBox.top };
    });

    const thickness = 6;
    const trip = state.trip;
    [...el.track.children].forEach((seg, i) => {
      const a = centres[i];
      const b = centres[i + 1];
      const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
      seg.classList.toggle('is-vertical', vertical);
      seg.style.left = `${vertical ? a.x - thickness / 2 : a.x}px`;
      seg.style.top = `${vertical ? a.y : a.y - thickness / 2}px`;
      seg.style.width = `${vertical ? thickness : b.x - a.x}px`;
      seg.style.height = `${vertical ? b.y - a.y : thickness}px`;
      seg.classList.toggle('is-done', Boolean(trip) && i + 1 <= state.index);
      seg.classList.toggle('is-closed', Boolean(trip) && !canVisit(i + 1));
    });

    // The train sits on the active station.
    if (trip && state.index >= 0) {
      const c = centres[state.index];
      const firstAppearance = !el.train.classList.contains('is-on');
      if (firstAppearance) el.train.style.transition = 'none'; // don't glide in from the corner
      el.train.style.transform = `translate(${c.x}px, ${c.y}px)`;
      if (firstAppearance) { void el.train.offsetWidth; el.train.style.transition = ''; }
      el.train.classList.add('is-on');
      // Point the panel's notch at the active station (desktop only).
      const panelBox = el.panel.getBoundingClientRect();
      el.panel.style.setProperty('--notch-x', `${c.x + mapBox.left - panelBox.left}px`);
    } else {
      el.train.classList.remove('is-on');
    }
  }

  /**
   * Where does the detail panel live? Desktop: under the map. Phone: inside
   * the active station, so the line keeps running down beside it.
   */
  function placePanel() {
    if (mobile.matches && state.trip && state.index >= 0) {
      const item = el.stations.children[state.index];
      if (el.panel.parentElement !== item) item.appendChild(el.panel);
    } else if (el.panel.previousElementSibling !== el.controls) {
      el.controls.after(el.panel);
    }
  }

  /* 9. Playback -------------------------------------------------------------- */

  function setPlaying(playing, { silent = false } = {}) {
    state.playing = playing;
    el.journey.classList.toggle('is-paused', !playing);
    // Freeze whatever is mid animation when pausing; thaw when playing.
    el.journey.classList.toggle('is-frozen', !playing && !silent);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!silent) {
      if (playing) {
        // Pressing play on the last station starts over.
        if (state.index === LAST) { goTo(0); return; }
        startClock();
      } else {
        pauseClock();
      }
    }
  }

  /** Start (or resume) the countdown to the next station. */
  function startClock() {
    const clock = state.clock;
    clearTimeout(clock.timer);
    clock.timer = null;
    const st = STATIONS[state.index];
    const blocked = isWaiting(state.index) || !st.duration || !canVisit(state.index + 1);

    if (!state.playing || blocked) {
      el.progress.classList.remove('is-running');
      // Reaching the end, or a dead end at DNS, stops autoplay.
      if (state.playing && !isWaiting(state.index) && blocked) setPlaying(false, { silent: true });
      updateControls();
      return;
    }

    clock.total = st.duration / state.speed;
    clock.startedAt = performance.now();
    const remaining = (1 - clock.fraction) * clock.total;
    clock.timer = setTimeout(onClockDone, remaining);

    // Restart the progress bar animation from the right point.
    el.progress.classList.remove('is-running');
    void el.progress.offsetWidth; // forces the browser to restart the animation
    el.progress.style.animationDuration = `${clock.total}ms`;
    el.progress.style.animationDelay = `${-clock.fraction * clock.total}ms`;
    el.progress.classList.add('is-running');
  }

  function pauseClock() {
    const clock = state.clock;
    if (clock.timer) {
      clock.fraction = Math.min(1, clock.fraction + (performance.now() - clock.startedAt) / clock.total);
      clearTimeout(clock.timer);
      clock.timer = null;
    }
  }

  function resetClock() {
    clearTimeout(state.clock.timer);
    state.clock.timer = null;
    state.clock.fraction = 0;
    el.progress.classList.remove('is-running');
  }

  function stopClock() { resetClock(); }

  function onClockDone() {
    state.clock.timer = null;
    state.clock.fraction = 0;
    if (state.index < LAST && canVisit(state.index + 1)) goTo(state.index + 1);
    else setPlaying(false, { silent: true });
  }

  function toggleSpeed() {
    const wasRunning = Boolean(state.clock.timer);
    pauseClock();
    state.speed = state.speed === 1 ? 2 : 1;
    el.root.style.setProperty('--speed', state.speed);
    el.speed.textContent = `${state.speed}x`;
    el.speed.setAttribute('aria-label', `Speed: ${state.speed}x. Switch to ${state.speed === 1 ? 2 : 1}x`);
    if (wasRunning) startClock();
  }

  function updateControls() {
    const trip = state.trip;
    if (!trip) return;
    const i = state.index;
    el.prev.disabled = i <= 0;
    el.next.disabled = i >= LAST || !canVisit(i + 1);

    const now = STATIONS[i];
    let text = esc(now.title);
    let label = 'Now';
    if (isWaiting(i)) {
      text = `${esc(now.title)}: waiting for the DNS answer`;
    } else if (trip.dns.status === 'error' && i === DNS_INDEX) {
      label = 'End of the line';
      text = 'This trip stops at DNS';
    } else if (i < LAST) {
      text = `${esc(now.title)} <span class="dim">&middot; next: ${esc(STATIONS[i + 1].title)}</span>`;
    } else {
      label = 'Arrived';
      text = `Trip complete for ${esc(trip.displayHost)}`;
    }
    el.nowLabel.textContent = label;
    el.nowText.innerHTML = text;
  }

  function announce(message) {
    el.announcer.textContent = '';
    // Small delay so screen readers notice the change.
    setTimeout(() => { el.announcer.textContent = message; }, 50);
  }

  /* 10. Station panels -------------------------------------------------------
     Each station has a render function that returns HTML. Content for both
     modes is rendered together; CSS hides .eng in Simple mode and .simple in
     Engineer mode, so switching modes never restarts an animation. */

  function badge(kind) {
    return kind === 'live'
      ? '<span class="badge badge-live" title="Real data, fetched or measured just now">Live</span>'
      : '<span class="badge badge-explained" title="How it usually works, illustrated with your real domain and IP">Explained</span>';
  }

  function panelHead(i) {
    const s = STATIONS[i];
    return `
      <div class="panel-head" data-line="${s.line}">
        <span class="panel-num">${String(i + 1).padStart(2, '0')}</span>
        <h2 class="panel-title" id="panel-title">${esc(s.title)}</h2>
        <div class="badges">${badge(s.badge)}</div>
      </div>`;
  }

  /** CSP forbids inline style attributes, so animation variables travel in
      data attributes and get applied here. */
  function applyVars(root) {
    root.querySelectorAll('[data-i]').forEach((n) => n.style.setProperty('--i', n.dataset.i));
    root.querySelectorAll('[data-start]').forEach((n) => {
      n.style.setProperty('--start', n.dataset.start);
      n.style.setProperty('--len', n.dataset.len);
    });
  }

  function renderPanel() {
    const i = state.index;
    const trip = state.trip;
    if (!trip || i < 0) return renderIdle();

    const st = STATIONS[i];
    let body;
    if (isWaiting(i)) body = renderWaiting(trip);
    else if (st.needsDns && trip.dns.status === 'error') body = renderDnsError(trip);
    else body = RENDERERS[st.id](trip);

    el.panel.setAttribute('aria-labelledby', 'panel-title');
    el.panelInner.innerHTML = panelHead(i) + body;
    el.panelInner.dataset.line = st.line;
    // Restart the entrance animation.
    el.panelInner.style.animation = 'none';
    void el.panelInner.offsetWidth;
    el.panelInner.style.animation = '';
    applyVars(el.panelInner);
    wirePanelButtons();
  }

  function renderIdle() {
    el.panel.removeAttribute('aria-labelledby');
    el.panelInner.removeAttribute('data-line');
    el.panelInner.innerHTML = `
      <div class="idle-grid">
        <div>
          ${badge('live')}
          <h3>Real where it can be</h3>
          <p>The DNS lookup is real. Your browser asks a public DNS service for the site's actual addresses, and we time a real round trip to the server.</p>
        </div>
        <div>
          ${badge('explained')}
          <h3>Honest where it can't</h3>
          <p>Web pages aren't allowed to see raw network packets. So the TCP, TLS and HTTP stops show how it usually works, using your real domain and IP.</p>
        </div>
        <div>
          <h3>Reading the map</h3>
          <p>Each colour is a layer of the trip: red for your browser, blue for DNS, green for the connection, amber for HTTP. Switch to Engineer mode up top for the raw details.</p>
        </div>
      </div>`;
  }

  const RENDERERS = {

    /* Station 1: take the URL apart. This uses the browser's real URL parser. */
    enter(t) {
      const path = t.path + t.search;
      let schemeNote;
      if (!t.typedScheme) schemeNote = 'You didn\'t type <code>https://</code>, so the browser filled it in. Modern browsers try the secure version first.';
      else if (t.typedScheme === 'http') schemeNote = 'You typed <code>http://</code>. Almost every site sends you straight on to <code>https://</code>, so that\'s the trip we\'ll follow.';
      else schemeNote = 'You typed <code>https://</code> yourself. Respect.';
      const portNote = t.port ? ` You asked for port <code>${esc(t.port)}</code>. We'll follow the standard HTTPS port, 443, since that's where websites normally live.` : '';

      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">Before anything touches the network, your browser reads what you typed and takes it apart.</p>
            <p>First it decides: is this a website or a search? <code>${esc(t.displayHost)}</code> has a dot and a real ending, <code>.${esc(t.tld)}</code>, so it's treated as an address.</p>
            <p>Then it splits the address into parts. The domain matters most right now. Computers don't find each other by name, they need a number called an <strong>IP address</strong>. So the next job is turning <strong>${esc(t.displayHost)}</strong> into one.</p>
            <p class="note" data-line="conn">${schemeNote}${portNote}</p>
          </div>
          <div>
            <div class="url-anatomy" aria-label="The address, split into parts">
              <div class="url-part pc-scheme" data-i="0"><span>https://</span><small>Protocol<i>how to talk</i></small></div>
              <div class="url-part pc-host" data-i="1"><span>${esc(t.host)}</span><small>Domain<i>who to talk to</i></small></div>
              <div class="url-part pc-path" data-i="2"><span>${esc(path)}</span><small>Path<i>what to ask for</i></small></div>
            </div>
            <div class="eng">
              <p class="eng-title">Parsed by your browser's URL parser <span class="tag-live">Live</span></p>
              <table class="kv">
                <tr><th>scheme</th><td>https</td></tr>
                <tr><th>host</th><td>${esc(t.host)}</td></tr>
                <tr><th>port</th><td>443 <span class="dim">(the default for https)</span></td></tr>
                <tr><th>path</th><td>${esc(t.path)}</td></tr>
                <tr><th>query</th><td>${t.search ? esc(t.search) : '<span class="dim">(none)</span>'}</td></tr>
                <tr><th>origin</th><td>https://${esc(t.host)}</td></tr>
                <tr><th>DNS name</th><td>${esc(t.host)}</td></tr>
              </table>
              ${t.host.includes('xn--') ? '<p class="note">Your domain has non ASCII characters, so it was converted to <b>Punycode</b> (the <code>xn--</code> part). DNS only speaks plain ASCII.</p>' : ''}
              <p class="note">If ${esc(t.host)} is on the <b>HSTS preload list</b> built into your browser, it won't even try plain HTTP. It goes straight to HTTPS.</p>
            </div>
          </div>
        </div>`;
    },

    /* Station 2: caches. Explained, because a page can't read your caches. */
    cache(t) {
      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">Asking for directions takes time, so everyone on the way keeps a short memory of recent answers.</p>
            <p>Before going out to the network, your browser checks if it already knows the address for <strong>${esc(t.displayHost)}</strong>. If not, it asks your operating system, which keeps its own list. If either one remembers, and the answer hasn't expired, the DNS trip is skipped.</p>
            <p>For this story we'll assume a cold start: nobody remembers, so we go and ask.</p>
            <p class="note" data-line="browser"><b>Why "Explained"?</b> A web page can't look inside your browser's or computer's memory, and that's a good thing. So this stop shows how it usually works, not what happened on your machine.</p>
            <div class="eng">
              <p class="eng-title">Even earlier shortcuts</p>
              <p>Before DNS, the browser also checks its <strong>HTTP cache</strong> (maybe it can show a saved copy) and whether it already has an <strong>open connection</strong> to this site. Reusing a connection skips DNS, TCP and TLS completely, which is why clicking around inside one site feels faster than the first visit.</p>
            </div>
          </div>
          <ol class="steps" aria-label="Where the browser looks first">
            <li class="step" data-i="0">
              <span class="step-idx">1</span>
              <span class="step-body"><b>Browser cache</b><span class="simple">Names this browser looked up recently.</span><span class="eng">Chrome shows it at <code>chrome://net-internals/#dns</code></span></span>
              <span class="step-status miss">not here</span>
            </li>
            <li class="step" data-i="1">
              <span class="step-idx">2</span>
              <span class="step-body"><b>Operating system</b><span class="simple">Its own cache, plus a tiny address book called the hosts file.</span><span class="eng">Windows: <code>ipconfig /displaydns</code>. Linux with systemd: <code>resolvectl statistics</code>. Hosts file: <code>/etc/hosts</code></span></span>
              <span class="step-status miss">not here</span>
            </li>
            <li class="step" data-i="2" data-line="dns">
              <span class="step-idx">3</span>
              <span class="step-body"><b>Ask a DNS resolver</b><span class="simple">Time to use the network.</span><span class="eng">Usually the resolver your router hands out (your ISP's), or a public one like 1.1.1.1. It has a cache too.</span></span>
              <span class="step-status go">next stop</span>
            </li>
          </ol>
        </div>`;
    },

    /* Station 3: the real DNS answer. */
    dns(t) {
      const d = t.dns.data;
      const r = d.resolver;
      const v4 = d.v4.slice(0, 4);
      const v6 = d.v6.slice(0, 3);
      const more = (list, shown) => (list.length > shown.length ? `<li><small>+ ${list.length - shown.length} more</small></li>` : '');
      const zone = d.zone ? d.zone.zone : t.host;
      const ns = d.zone && d.zone.ns.length ? d.zone.ns[0] : `${zone}'s name servers`;
      const tld = zone.split('.').pop();
      const addresses = d.v4.length + d.v6.length;

      const chainHtml = d.chain.length ? `
        <p><strong>Plot twist:</strong> <code>${esc(t.host)}</code> is a nickname. DNS calls this a <strong>CNAME</strong>. It points to another name, and that one has the address.</p>
        <div class="cname-chain">
          <span class="node">${esc(t.host)}</span>
          ${d.chain.map((c) => `<span class="arrow" aria-hidden="true">&rarr;</span><span class="node">${esc(c.to)}</span>`).join('')}
        </div>` : '';

      const fallbackNote = d.failures.length
        ? `<p class="note" data-line="dns">${esc(d.failures.map((f) => f.name).join(' and '))} didn't answer, so we asked ${esc(r.name)} instead. That's what a fallback is for.</p>`
        : '';

      const hops = [
        { route: ['you', 'resolver'], msg: `"Where is ${t.host}?"`, status: 'question' },
        { route: ['resolver', 'root server (.)'], msg: `"No idea, but here are the servers for .${tld}."`, status: 'referral' },
        { route: ['resolver', `.${tld} servers`], msg: `"Ask ${zone}'s own servers, like ${ns}."`, status: 'referral' },
        { route: ['resolver', ns], msg: d.chain.length
            ? `"${t.host} is really ${d.finalName}." The resolver repeats the hunt for that name.`
            : `"${t.host} is at ${d.ip}."`, status: 'answer' },
        { route: ['resolver', 'you'], msg: `"Here you go: ${d.ip}. Keep it for ${d.ttl} seconds."`, status: 'answer' },
      ];

      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">We just asked a real DNS resolver where <strong>${esc(t.displayHost)}</strong> lives. Here's what it said.</p>
            <ul class="ip-list" aria-label="IPv4 addresses">
              ${v4.map((a) => `<li>${esc(a.ip)} <small>IPv4</small></li>`).join('')}${more(d.v4, v4)}
            </ul>
            ${v6.length ? `<ul class="ip-list v6" aria-label="IPv6 addresses">${v6.map((a) => `<li>${esc(a.ip)} <small>IPv6</small></li>`).join('')}${more(d.v6, v6)}</ul>` : ''}
            ${chainHtml}
            <p>The answer has a <strong>TTL</strong>, short for time to live, of <strong>${esc(formatTtl(d.ttl))}</strong>. That's how long anyone may remember it before they have to ask again.</p>
            <p>${addresses > 1
              ? `There's more than one address. Big sites spread visitors over many servers, and your browser just picks one, usually the first that works.`
              : 'Just one address. Nice and simple.'}</p>
            <p class="note" data-line="dns"><b>Small print:</b> your browser would normally ask the resolver your device is set up with, often your router or internet provider. We asked ${esc(r.name)} over HTTPS so we could show you the reply. Big sites answer differently depending on where you ask from, so your own lookup might get a different IP. Both are correct.</p>
            ${fallbackNote}
          </div>
          <div>
            <p class="code-label">How the resolver found it ${badge('explained')}</p>
            <ol class="steps" data-line="dns" aria-label="The DNS lookup, hop by hop">
              ${hops.map((h, i) => `
                <li class="step" data-i="${i}">
                  <span class="step-idx">${i + 1}</span>
                  <span class="step-body">
                    <span class="hop-route">${esc(h.route[0])}<span class="arrow" aria-label="to">&rarr;</span>${esc(h.route[1])}</span>
                    <span>${esc(h.msg)}</span>
                  </span>
                  <span class="step-status ${h.status === 'answer' ? 'go' : 'miss'}">${h.status}</span>
                </li>`).join('')}
            </ol>
            <p class="note" data-line="dns">For a popular site the resolver almost certainly had this cached and answered straight away. The full walk from the root only happens when nobody nearby asked recently.</p>
          </div>
        </div>
        <div class="eng eng-wide">
            <div>
              <p class="eng-title">Raw answer <span class="tag-live">Live</span></p>
              <table class="kv">
                <thead><tr><th>Name</th><th>Type</th><th>TTL</th><th>Data</th></tr></thead>
                <tbody>
                  ${d.records.map((rec) => `<tr><td>${esc(stripDot(rec.name))}</td><td>${esc(RR_TYPE[rec.type] || rec.type)}</td><td>${esc(rec.TTL)}</td><td>${esc(stripDot(rec.data))}</td></tr>`).join('')}
                </tbody>
              </table>
              <div class="stat-row">
                <div class="stat"><span class="stat-label">Resolver</span><span class="stat-value">${esc(r.name)}</span></div>
                <div class="stat"><span class="stat-label">Status</span><span class="stat-value">NOERROR (0)</span></div>
                <div class="stat"><span class="stat-label">Lookup time</span><span class="stat-value">~${ms(d.elapsed)}</span></div>
              </div>
              <p>Lookup time covers three questions (A, AAAA and CNAME) sent in parallel over HTTPS, so it includes some HTTPS overhead. Plain DNS over UDP is usually quicker.</p>
            </div>
            <div>
              <p class="eng-title">Behind the answer</p>
              <p><strong>DNSSEC:</strong> ${d.dnssec
                ? 'the AD flag is set, which means the resolver checked the cryptographic signatures on this answer and they were valid.'
                : 'the AD flag is not set, so this answer was not validated. Most often the domain simply isn\'t signed. That\'s common.'}</p>
              ${d.zone ? `<p><strong>Authoritative servers for ${esc(d.zone.zone)}</strong> <span class="tag-live">Live</span>: <code>${d.zone.ns.map(esc).join('</code> <code>')}</code></p>` : ''}
              <p class="eng-title">Try it yourself</p>
              <pre class="code">dig ${esc(t.host)} A +noall +answer

curl -H 'accept: application/dns-json' \\
  'https://cloudflare-dns.com/dns-query?name=${esc(t.host)}&amp;type=A'</pre>
            </div>
        </div>`;
    },

    /* Station 4: TCP three way handshake, with the real IP and a real (rough) RTT. */
    tcp(t) {
      const d = t.dns.data;
      const ip = d.ip;
      const a = t.isnClient;
      const b = t.isnServer;
      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">Now we have an address. Before sending anything real, your device checks the server is there and listening.</p>
            <p>It does this with three tiny messages called the <strong>TCP handshake</strong>. It's like a phone call: "Can you hear me?" "Yes, can you hear me?" "Yes." Now both sides know the line works, and they've agreed how to number the messages that follow, so nothing gets lost or arrives out of order.</p>
            <p>That costs one round trip. <span data-slot="rtt">${timingSentence(t)}</span></p>
            <p class="note" data-line="conn"><b>Why "Explained"?</b> Browsers don't let web pages see raw packets. The IP and port are real, the handshake is how TCP connections start, and the timing is a real but rough measurement.</p>
            <div class="eng">
              <p class="eng-title">Packet details (illustrative)</p>
              <table class="kv">
                <tr><th>Source</th><td>your device, port ${t.clientPort} <span class="dim">(a random high port picked by your OS)</span></td></tr>
                <tr><th>Destination</th><td>${esc(withPort(ip, 443))}</td></tr>
                <tr><th>Sequence numbers</th><td>random at the start, for safety. The ones shown are made up.</td></tr>
                <tr><th>SYN options</th><td>MSS 1460, SACK permitted, window scaling, timestamps <span class="dim">(typical)</span></td></tr>
              </table>
              <p class="eng-title">Timing <span class="tag-live">Live, approximate</span></p>
              <div data-slot="timing-detail">${timingDetail(t)}</div>
              <p class="note" data-line="conn">Many big sites also speak <b>HTTP/3</b>, which runs over QUIC on UDP and folds this handshake into the TLS one. Browsers usually learn a site supports it from an earlier response or a DNS record, so a first visit often still starts with TCP, like this.</p>
            </div>
          </div>
          <div class="ladder" data-line="conn">
            <div class="ladder-head">
              <span class="ladder-end">Your device <span class="mono">port ${t.clientPort}</span></span>
              <span class="ladder-end">${esc(t.displayHost)} <span class="mono">${esc(withPort(ip, 443))}</span></span>
            </div>
            <ol class="ladder-msgs" aria-label="TCP handshake messages">
              ${ladderMsg(0, 'to-server', 'SYN', 'Hi, can we talk?', `seq=${a}`)}
              ${ladderMsg(1, 'to-client', 'SYN-ACK', 'Sure. Can you hear me?', `seq=${b} ack=${a + 1}`)}
              ${ladderMsg(2, 'to-server', 'ACK', 'Loud and clear.', `seq=${a + 1} ack=${b + 1}`)}
            </ol>
          </div>
        </div>`;
    },

    /* Station 5: TLS 1.3 handshake. */
    tls(t) {
      const d = t.dns.data;
      const host = esc(t.host);
      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">The line is open, but anyone along the way could listen in. So before saying anything private, there's a secret handshake.</p>
            <p>In a few messages, two things happen. The server proves it really is <strong>${esc(t.displayHost)}</strong> by showing a <strong>certificate</strong>. And both sides agree on a secret key without ever sending the key itself. Some clever maths lets each side work it out from the pieces they swapped.</p>
            <p>Your browser checks the certificate like a bouncer checks an ID: is it for ${esc(t.displayHost)}, is it signed by an authority your device trusts, and has it expired?</p>
            <p>From here on, everything is encrypted. That's the padlock in your address bar.</p>
            <p class="note" data-line="conn">With <b>TLS 1.3</b>, which most sites use now, all of this takes one round trip. The older TLS 1.2 needed two.</p>
            <div class="eng">
              <p class="eng-title">What's going on underneath</p>
              <p>Messages in <code>{braces}</code> are already encrypted. In TLS 1.3 everything after ServerHello is, including the certificate.</p>
              <p>The key exchange is ephemeral (ECDHE), which gives <strong>forward secrecy</strong>: stealing the server's private key later can't decrypt today's traffic. Recent Chrome and Firefox also offer a hybrid post-quantum key share, <code>X25519MLKEM768</code>, next to classic <code>X25519</code>.</p>
              <p>The <strong>SNI</strong> (the site name in ClientHello) goes out unencrypted, so your network can still see which site you're visiting. Encrypted Client Hello (ECH) hides it, where both sides support it.</p>
              <p>A web page can't read another site's certificate. To see the real one, click the padlock in your address bar, or run:</p>
              <pre class="code">openssl s_client -connect ${host}:443 -servername ${host}</pre>
            </div>
          </div>
          <div class="ladder" data-line="conn">
            <div class="ladder-head">
              <span class="ladder-end">Your browser</span>
              <span class="ladder-end">${esc(t.displayHost)} <span class="mono">${esc(withPort(d.ip, 443))}</span></span>
            </div>
            <ol class="ladder-msgs" aria-label="TLS handshake messages">
              ${ladderMsg(0, 'to-server', 'ClientHello', `Hi, I'd like ${t.displayHost}. Here's how I can encrypt, and my half of a key.`, `SNI=${t.host} ALPN=h2,http/1.1 key_share=X25519MLKEM768,X25519`)}
              ${ladderMsg(1, 'to-client', 'ServerHello', 'Let\'s use this method. Here\'s my half of the key.', 'TLS 1.3, TLS_AES_128_GCM_SHA256, key_share')}
              ${ladderMsg(2, 'to-client', 'Certificate', 'And here\'s my ID card, signed by someone you trust.', '{EncryptedExtensions} {Certificate} {CertificateVerify} {Finished}')}
              ${ladderMsg(3, 'to-server', 'Finished', 'ID checks out. I got the same secret key. Let\'s talk.', '{Finished} then encrypted application data')}
            </ol>
            <div class="lock-wrap" data-i="4">
              <div class="lock" data-i="4" aria-hidden="true"><span class="lock-shackle" data-i="4"></span><span class="lock-body"></span></div>
              <span class="lock-text" data-i="4">Encrypted. Same key on both sides, never sent over the wire.</span>
            </div>
          </div>
        </div>`;
    },

    /* Station 6: the HTTP request (with your real browser headers) and a typical response. */
    http(t) {
      const host = esc(t.host);
      const path = esc(t.path + t.search);
      const ua = esc(navigator.userAgent);
      const lang = esc((navigator.languages && navigator.languages.length ? navigator.languages.slice(0, 2) : [navigator.language || 'en']).join(','));
      const date = esc(new Date().toUTCString());
      const redirectExample = t.host.startsWith('www.') ? 'to a different path' : `to <code>www.${host}</code>`;

      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">Finally, the actual question. Your browser sends a short text message: "Please send me the page at <code>${path}</code>."</p>
            <p>The server answers with a <strong>status code</strong> that says how it went, some <strong>headers</strong> with extra details, and then the page itself, written in HTML.</p>
            <ul class="codes" aria-label="Common status codes">
              <li><b>200</b>OK. Here you go.</li>
              <li><b>301</b>It moved. Go here instead.</li>
              <li><b>404</b>Never heard of that page.</li>
              <li><b>500</b>The server tripped over something.</li>
            </ul>
            <p class="note" data-line="http"><b>Real talk:</b> lots of sites answer the bare domain with a <b>301 redirect</b> first, for example ${redirectExample}, and the browser asks again. We show the 200 to keep the story short. The reply headers are typical examples, not ${esc(t.displayHost)}'s actual ones.</p>
            <div class="eng">
              <p class="eng-title">Headers worth knowing</p>
              <table class="kv prose">
                <tr><th>Host</th><td>Which site you want. One IP can serve thousands of sites.</td></tr>
                <tr><th>Accept-Encoding</th><td>Compression formats the browser can unpack.</td></tr>
                <tr><th>Content-Encoding</th><td><code>br</code> means the body is Brotli compressed.</td></tr>
                <tr><th>Strict-Transport-Security</th><td>Only use HTTPS for this site from now on.</td></tr>
                <tr><th>Alt-Svc</th><td>"I also speak HTTP/3." This is how the browser learns it can skip TCP next time.</td></tr>
              </table>
              <p class="note" data-line="http">Your browser most likely spoke <b>HTTP/2</b> or <b>HTTP/3</b> here. They carry the same information as compressed binary frames, with the first line split into pseudo headers like <code>:method: GET</code> and <code>:path: ${path}</code>. We show the HTTP/1.1 text form because humans can read it. See the real headers with <code>curl -sI https://${host}/</code></p>
            </div>
          </div>
          <div data-line="http">
            <p class="code-label">Your browser sends</p>
            <pre class="code simple"><span class="hl">GET</span> ${path} HTTP/1.1
Host: ${host}
Accept: text/html</pre>
            <pre class="code eng"><span class="hl">GET</span> ${path} HTTP/1.1
Host: ${host}
User-Agent: ${ua}
Accept: text/html,application/xhtml+xml,*/*;q=0.8
Accept-Language: ${lang}
Accept-Encoding: gzip, deflate, br, zstd
<span class="dim"># User-Agent and Accept-Language are your browser's real values</span></pre>
            <p class="code-label">The server replies</p>
            <pre class="code simple"><span class="hl">HTTP/1.1 200 OK</span>
Content-Type: text/html

&lt;!doctype html&gt;
&lt;html&gt; ...the page... &lt;/html&gt;</pre>
            <pre class="code eng"><span class="hl">HTTP/1.1 200 OK</span>
Date: ${date}
Content-Type: text/html; charset=utf-8
Content-Encoding: br
Cache-Control: private, max-age=0
Strict-Transport-Security: max-age=31536000
Alt-Svc: h3=":443"; ma=86400

&lt;!doctype html&gt;
&lt;html lang="en"&gt;&lt;head&gt;...</pre>
          </div>
        </div>`;
    },

    /* Station 7: rendering. HTML first, then subresources, then paint. */
    render(t) {
      const files = [
        { name: 'index.html', start: '0%', len: '24%', line: 'http' },
        { name: 'style.css', start: '26%', len: '16%', line: 'dns' },
        { name: 'app.js', start: '27%', len: '28%', line: 'browser' },
        { name: 'logo.svg', start: '30%', len: '12%', line: 'conn' },
        { name: 'font.woff2', start: '44%', len: '18%', line: 'dns' },
        { name: 'hero.jpg', start: '32%', len: '52%', line: 'conn' },
      ];
      const pipeSimple = ['Read HTML', 'Apply styles', 'Lay out', 'Paint'];
      const pipeEng = ['DOM', 'CSSOM', 'Render tree', 'Layout', 'Paint', 'Composite'];
      const pipe = (steps) => steps.map((s, i) => `${i ? `<li class="sep" data-i="${i}" aria-hidden="true">&rarr;</li>` : ''}<li data-i="${i}">${s}</li>`).join('');

      return `
        <div class="panel-grid">
          <div class="panel-copy">
            <p class="big-line">The HTML arrives. But it's only the first piece of the puzzle.</p>
            <p>Your browser reads it top to bottom and finds a shopping list: stylesheets, scripts, fonts, images. It fetches them, many at the same time over the connection that's already open.</p>
            <p>Then it builds a model of the page, works out the styles, figures out where every box goes, and fills in the pixels. That's the moment you see ${esc(t.displayHost)}.</p>
            <p class="note" data-line="browser">Extra files from the same site need no new DNS, TCP or TLS. The connection is already open. Files from other domains, like a font service, do need their own trip.</p>
            <div class="eng">
              <p class="eng-title">The critical rendering path</p>
              <p><strong>CSS is render blocking:</strong> the browser won't paint until it has the stylesheets in the head, to avoid a flash of unstyled content. <strong>Scripts without <code>defer</code> or <code>async</code></strong> block the HTML parser while they download and run.</p>
              <p><code>DOMContentLoaded</code> fires when the HTML is parsed. <code>load</code> fires when images and everything else are done too.</p>
              <p>Want the real waterfall for ${esc(t.displayHost)}? Open DevTools (F12), go to the Network tab and reload the page.</p>
            </div>
          </div>
          <div>
            <p class="code-label">Files arriving (illustrative)</p>
            <ul class="waterfall" aria-label="Files loading over time">
              ${files.map((f, i) => `<li data-line="${f.line}"><span class="wf-name">${f.name}</span><span class="wf-track"><span class="wf-bar" data-i="${i}" data-start="${f.start}" data-len="${f.len}"></span></span></li>`).join('')}
            </ul>
            <div class="mini-browser" data-line="browser" aria-hidden="true">
              <div class="mb-bar"><span class="mb-dots"><i></i><i></i><i></i></span><span class="mb-url">https://${esc(t.host)}${esc(t.path)}</span></div>
              <div class="mb-page">
                <span class="mb-block h" data-i="0"></span>
                <span class="mb-block" data-i="1"></span>
                <span class="mb-block short" data-i="2"></span>
                <span class="mb-block img" data-i="3"></span>
                <span class="mb-block" data-i="4"></span>
              </div>
            </div>
            <ol class="pipeline simple" aria-label="Rendering steps">${pipe(pipeSimple)}</ol>
            <ol class="pipeline eng" aria-label="Rendering steps">${pipe(pipeEng)}</ol>
          </div>
        </div>`;
    },

    /* Station 8: the summary card. */
    summary(t) {
      const d = t.dns.data;
      const fact = pickFact(t);
      const lines = STATIONS.slice(1).map((s) => `<i data-line="${s.line}"></i><b></b>`).join('');
      const timing = t.timing;
      const firstReply = timing.status === 'ok' ? `~${ms(timing.data.cold)}` : timing.status === 'failed' ? 'not measured' : 'measuring...';
      const steps = [
        `parsed the URL`,
        `checked its caches`,
        `asked DNS for ${t.host} and got ${d.ip}`,
        `opened a TCP connection to port 443`,
        `secured it with TLS`,
        `sent GET ${t.path}`,
        `got HTML back, fetched the rest, and painted the page`,
      ];

      return `
        <div class="panel-grid single">
          <div class="panel-copy">
            <p class="big-line">That's the whole trip. The numbers on this card were looked up and measured from your browser just now.</p>
          </div>
          <div class="summary-card" id="summary-card">
            <div class="sc-top"><span>WhatTheHTTP</span><span class="mono">${esc(t.startedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}</span></div>
            <div class="sc-host">${esc(t.displayHost)}</div>
            <div class="sc-line" aria-hidden="true"><b></b>${lines}</div>
            <div class="sc-grid">
              <div><span class="stat-label">IP address</span><span class="stat-value">${esc(d.ip)}</span></div>
              <div><span class="stat-label">TTL</span><span class="stat-value">${esc(d.ttl)}s</span></div>
              <div><span class="stat-label">First reply</span><span class="stat-value">${esc(firstReply)}</span></div>
              <div><span class="stat-label">Resolver</span><span class="stat-value">${esc(d.resolver.name)}</span></div>
            </div>
            <p class="sc-fact"><b>Surprising fact:</b> ${esc(fact)}</p>
          </div>
          <div class="summary-actions">
            <button type="button" class="btn" data-action="save">Save card as PNG</button>
            <button type="button" class="btn btn-ghost" data-action="replay">Replay</button>
            <button type="button" class="btn btn-ghost" data-action="new">Try another site</button>
          </div>
          <div class="panel-copy">
            <p class="eng-title">The interview answer, in one breath</p>
            <p>When you hit Enter, the browser ${esc(steps.slice(0, -1).join(', '))}, ${esc(steps[steps.length - 1])}.</p>
            <p class="eng">First reply is the time for one fresh request from your browser, including its own DNS lookup, TCP and TLS setup. Repeat requests on the open connection took ${timing.status === 'ok' && timing.data.warm ? `about ${esc(ms(timing.data.warm))}` : 'an unknown time'}. The DNS lookup itself took about ${esc(ms(d.elapsed))} via ${esc(d.resolver.name)}${d.dnssec ? ', and the answer was DNSSEC validated' : ''}.</p>
          </div>
        </div>`;
    },
  };

  /** One message row in a ladder (sequence) diagram. */
  function ladderMsg(i, direction, label, simpleText, engText) {
    const arrow = direction === 'to-server' ? 'device to server' : 'server to device';
    return `
      <li class="msg ${direction}" data-i="${i}">
        <span class="msg-text" data-i="${i}">
          <b>${esc(label)}</b> <span class="visually-hidden">(${arrow})</span>
          <span class="simple">${esc(simpleText)}</span>
          <span class="eng">${esc(engText)}</span>
        </span>
        <span class="msg-wire" data-i="${i}"><span class="packet" data-i="${i}"></span></span>
      </li>`;
  }

  /** The live round trip sentence on the TCP station. */
  function timingSentence(t) {
    const tm = t.timing;
    if (tm.status === 'ok' && tm.data.warm) {
      return `From where you are, a round trip to ${esc(t.displayHost)} takes about <strong>${ms(tm.data.warm)}</strong> <span class="tag-live">Live, approximate</span>.`;
    }
    if (tm.status === 'ok') {
      return `Your first request to ${esc(t.displayHost)} took about <strong>${ms(tm.data.cold)}</strong> in total <span class="tag-live">Live, approximate</span>.`;
    }
    if (tm.status === 'failed') {
      return 'We couldn\'t time this one. The site didn\'t answer our small test request, which happens: some sites block it, and some don\'t serve HTTPS on the bare domain.';
    }
    return `Measuring your round trip to this server ${loadingDots}`;
  }

  function timingDetail(t) {
    const tm = t.timing;
    if (tm.status !== 'ok') return `<p>${timingSentence(t)}</p>`;
    return `
      <div class="stat-row">
        <div class="stat"><span class="stat-label">First request</span><span class="stat-value">~${ms(tm.data.cold)}</span></div>
        <div class="stat"><span class="stat-label">Repeat request</span><span class="stat-value">${tm.data.warm ? `~${ms(tm.data.warm)}` : 'n/a'}</span></div>
      </div>
      <p>The first request paid for DNS, TCP, TLS and HTTP. Repeats reuse the open connection, so they're roughly one round trip plus a little server time. Measured with <code>fetch(..., { mode: "no-cors" })</code> and <code>performance.now()</code> against <code>/favicon.ico</code>.</p>`;
  }

  /** Update timing numbers in place, without re-rendering (and restarting) the diagrams. */
  function fillTimingSlots() {
    const t = state.trip;
    if (!t) return;
    el.panelInner.querySelectorAll('[data-slot="rtt"]').forEach((n) => { n.innerHTML = timingSentence(t); });
    el.panelInner.querySelectorAll('[data-slot="timing-detail"]').forEach((n) => { n.innerHTML = timingDetail(t); });
  }

  /** Pick one surprising, true fact, preferring ones that use this trip's real data. */
  function pickFact(t) {
    const d = t.dns.data;
    const tm = t.timing;
    if (tm.status === 'ok' && tm.data.warm) {
      // Light in optical fibre covers roughly 200 km per millisecond. A round
      // trip of R ms means at most R/2 ms each way, so at most R * 100 km.
      const km = Math.max(1, Math.round(tm.data.warm * 100));
      const kmText = km.toLocaleString('en');
      if (km < 500) {
        return `Light in fibre travels about 200 km every millisecond. Your round trip of ${ms(tm.data.warm)} means this server is at most ${kmText} km away. Big sites keep copies of themselves in cities all over the world for exactly this reason.`;
      }
      return `Light in fibre travels about 200 km every millisecond. Your round trip of ${ms(tm.data.warm)} means this server is at most about ${kmText} km away, and probably much closer, since cables never run in straight lines.`;
    }
    if (d.chain.length) {
      return `${t.host} isn't the real name. It's an alias (a CNAME) for ${d.finalName}. Sites do this so they can move between servers or CDNs without changing the name you type.`;
    }
    if (d.v6.length) {
      return `This site also has an IPv6 address. IPv4 has about 4.3 billion addresses in total. IPv6 has about 340 undecillion, a 39 digit number.`;
    }
    return 'There are only 13 root server names, a to m, but they run on well over a thousand machines around the world. A routing trick called anycast usually sends your question to a nearby one.';
  }

  /* 11. Waiting and error states -------------------------------------------- */
  function renderWaiting() {
    return `
      <div class="state-box" data-line="dns">
        <h3>Asking a public DNS resolver ${loadingDots}</h3>
        <p>We're sending a real DNS question over HTTPS. This usually takes a few milliseconds. If it takes longer, your network might be slow, or blocking us.</p>
      </div>`;
  }

  function renderDnsError(t) {
    const e = t.dns.error;
    const host = esc(t.displayHost);
    let terminus = 'Line terminates here';
    let title;
    let body;
    let eng = '';
    let actions = '<button type="button" class="btn" data-action="new">Try another site</button>';

    switch (e.kind) {
      case 'nxdomain': {
        const zone = e.soaZone === '' ? 'the root zone' : e.soaZone ? `the <code>${esc(e.soaZone)}</code> zone` : 'the authoritative server';
        title = `There's no such place as ${host}`;
        body = `
          <p>The DNS system answered, and the answer was <strong>NXDOMAIN</strong>, short for "non-existent domain". That's not the network failing. It's a real, confident reply: this name isn't set up, so there's no address to travel to.</p>
          <p>Most of the time it's a typo. Sometimes the domain expired, or was never registered.</p>
          <p class="note" data-line="dns"><b>Fun fact:</b> "doesn't exist" answers get cached too. So if someone registered this name a minute ago, resolvers might keep saying no for a little while.</p>`;
        eng = `<p>Status 3 (NXDOMAIN) from ${esc(e.resolver.name)}. The SOA record in the authority section shows that ${zone} gave the final word. Try it: <code>dig ${esc(t.host)}</code> and look for <code>status: NXDOMAIN</code>.</p>`;
        actions = `<button type="button" class="btn" data-action="edit">Fix the spelling</button><button type="button" class="btn btn-ghost" data-action="new">Try another site</button>`;
        break;
      }
      case 'servfail':
        title = 'The resolver got stuck';
        body = `
          <p>The answer was <strong>SERVFAIL</strong>. The resolver tried to look up ${host} but couldn't get a trustworthy answer. Usually the domain's own DNS servers are down or set up wrong, or a DNSSEC signature didn't check out.</p>
          <p>The site might exist. It just can't be looked up right now.</p>`;
        eng = `<p>Status 2 (SERVFAIL) from ${esc(e.resolver.name)}. If <code>dig ${esc(t.host)} +cd</code> (checking disabled) works but a normal lookup doesn't, DNSSEC is the likely culprit.</p>`;
        actions = `<button type="button" class="btn" data-action="retry">Try again</button><button type="button" class="btn btn-ghost" data-action="new">Try another site</button>`;
        break;
      case 'nodata':
        title = `${host} exists, but has no address`;
        body = `
          <p>The reply was <strong>NOERROR</strong>, so the name is real. But it has no A or AAAA records, which means there's no web server address to connect to. Some names are only used for email or other services.</p>
          <p>Try the site's www version, or another site.</p>`;
        eng = `<p>NOERROR with an empty answer section is often called NODATA. The name exists in the zone, just not with the record types we asked for.</p>`;
        break;
      case 'refused':
        title = 'The resolver said no';
        body = `<p>The resolver answered with status ${esc(e.status)} (${esc(RCODE[e.status] || 'unknown')}). That's unusual for a public resolver. Try again in a moment.</p>`;
        actions = `<button type="button" class="btn" data-action="retry">Try again</button><button type="button" class="btn btn-ghost" data-action="new">Try another site</button>`;
        break;
      default: // unreachable
        terminus = 'Signal failure';
        title = e.offline ? 'You seem to be offline' : 'We couldn\'t reach a DNS resolver';
        body = e.offline
          ? '<p>Your device says it has no network connection, so there\'s nobody to ask. Reconnect and try again. The trains will wait.</p>'
          : `<p>We tried Cloudflare, then Google, and neither answered. You might be offline, or your network might block DNS over HTTPS. Some offices, schools and filters do that on purpose.</p>
             <p>This doesn't mean ${host} is down. It means our way of asking couldn't get through.</p>`;
        eng = e.failures && e.failures.length
          ? `<table class="kv">${e.failures.map((f) => `<tr><th>${esc(f.name)}</th><td>${esc(f.reason)}</td></tr>`).join('')}</table>`
          : '';
        actions = `<button type="button" class="btn" data-action="retry">Try again</button><button type="button" class="btn btn-ghost" data-action="new">Try another site</button>`;
    }

    return `
      <div class="state-box is-error">
        <span class="terminus">${terminus}</span>
        <h3>${title}</h3>
        ${body}
        ${eng ? `<div class="eng"><p class="eng-title">Details <span class="tag-live">Live</span></p>${eng}</div>` : ''}
        <div class="state-actions">${actions}</div>
      </div>`;
  }

  /** Buttons inside the panel are re-created on each render, so wire them up each time. */
  function wirePanelButtons() {
    el.panelInner.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'new') endTrip();
        if (action === 'replay') { setPlaying(true, { silent: true }); goTo(0, { fromUser: true }); }
        if (action === 'retry' && state.trip) startTrip(state.trip, { startAt: DNS_INDEX });
        if (action === 'save') saveCard(btn);
        if (action === 'edit') {
          const host = state.trip.raw;
          endTrip();
          el.input.value = host;
          el.input.focus();
        }
      });
    });
  }

  /* 12. Summary card as PNG ---------------------------------------------------
     Drawn with the plain canvas API so people can share their result. Colours
     come from the CSS variables, so the PNG matches the current theme. */
  function saveCard(button) {
    const t = state.trip;
    if (!t || t.dns.status !== 'ok') return;
    const d = t.dns.data;
    const W = 1200;
    const H = 630;
    const scale = 2; // draw at 2x so it looks crisp on phones
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const css = getComputedStyle(el.root);
    const v = (name) => css.getPropertyValue(name).trim();
    const C = {
      paper: v('--paper'), surface: v('--surface'), ink: v('--ink'), muted: v('--muted'), rule: v('--rule'),
      browser: v('--line-browser'), dns: v('--line-dns'), conn: v('--line-conn'), http: v('--line-http'),
    };
    const TEXT = v('--font-text');
    const MONO = v('--font-mono');

    // Background and frame
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 5;
    ctx.strokeStyle = C.ink;
    roundRect(ctx, 24, 24, W - 48, H - 48, 22);
    ctx.stroke();

    // Brand mark and name
    ctx.fillStyle = C.ink;
    roundRect(ctx, 60, 58, 40, 40, 9);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = C.browser; line(ctx, 69, 78, 80, 78);
    ctx.strokeStyle = C.dns; line(ctx, 80, 78, 91, 78);
    ctx.fillStyle = C.paper; dot(ctx, 69, 78, 5); dot(ctx, 91, 78, 5);
    ctx.fillStyle = C.ink;
    ctx.font = `800 26px ${TEXT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('WhatTheHTTP', 114, 79);
    ctx.font = `500 18px ${MONO}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'right';
    ctx.fillText(t.startedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), W - 60, 79);
    ctx.textAlign = 'left';

    // Destination
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.muted;
    ctx.font = `700 15px ${TEXT}`;
    ctx.fillText('WHAT HAPPENED WHEN I HIT ENTER ON', 60, 152);
    ctx.fillStyle = C.ink;
    fitFont(ctx, t.displayHost, `800 {s}px ${MONO}`, 72, 30, W - 120);
    ctx.fillText(t.displayHost, 60, 222);

    // The metro line with all eight stations
    const lineY = 290;
    const x0 = 80;
    const x1 = W - 80;
    const step = (x1 - x0) / LAST;
    STATIONS.slice(1).forEach((s, i) => {
      ctx.strokeStyle = C[s.line];
      ctx.lineWidth = 8;
      line(ctx, x0 + step * i, lineY, x0 + step * (i + 1), lineY);
    });
    ctx.font = `700 14px ${TEXT}`;
    ctx.textAlign = 'center';
    STATIONS.forEach((s, i) => {
      const x = x0 + step * i;
      ctx.fillStyle = C.paper;
      dot(ctx, x, lineY, 10);
      ctx.lineWidth = 4;
      ctx.strokeStyle = C.ink;
      ctx.beginPath(); ctx.arc(x, lineY, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(s.short.toUpperCase(), x, lineY + 34);
    });
    ctx.textAlign = 'left';

    // Stats row
    const tm = t.timing;
    const stats = [
      ['IP ADDRESS', d.ip],
      ['TTL', `${d.ttl} s`],
      ['FIRST REPLY', tm.status === 'ok' ? `~${Math.round(tm.data.cold)} ms` : 'n/a'],
      ['RESOLVER', d.resolver.name],
    ];
    const colW = (W - 120) / 4;
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 2;
    line(ctx, 60, 360, W - 60, 360);
    stats.forEach(([label, value], i) => {
      const x = 60 + colW * i;
      if (i) line(ctx, x - 14, 375, x - 14, 445);
      ctx.fillStyle = C.muted;
      ctx.font = `700 13px ${TEXT}`;
      ctx.fillText(label, x, 395);
      ctx.fillStyle = C.ink;
      fitFont(ctx, value, `700 {s}px ${MONO}`, 26, 13, colW - 30);
      ctx.fillText(value, x, 432);
    });
    line(ctx, 60, 460, W - 60, 460);

    // The surprising fact, wrapped to at most three lines
    ctx.fillStyle = C.ink;
    ctx.font = `500 20px ${TEXT}`;
    wrapText(ctx, pickFact(t), 60, 498, W - 120, 28, 3);

    // Footer
    ctx.fillStyle = C.muted;
    ctx.font = `600 15px ${TEXT}`;
    ctx.fillText('What actually happens when you hit Enter.', 60, 580);
    ctx.textAlign = 'right';
    ctx.fillText(`DNS: live via ${d.resolver.name}. Times are approximate.`, W - 60, 580);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whatthehttp-${t.host}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (button) {
        const old = button.textContent;
        button.textContent = 'Saved';
        setTimeout(() => { button.textContent = old; }, 1600);
      }
    }, 'image/png');
  }

  // Tiny canvas helpers
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function line(ctx, ax, ay, bx, by) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  /** Shrink the font until the text fits the width. Template uses {s} for size. */
  function fitFont(ctx, text, template, max, min, width) {
    let size = max;
    ctx.font = template.replace('{s}', size);
    while (size > min && ctx.measureText(text).width > width) {
      size -= 2;
      ctx.font = template.replace('{s}', size);
    }
  }
  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = text.split(' ');
    let lineText = '';
    let lines = 0;
    for (let i = 0; i < words.length; i++) {
      const test = lineText ? `${lineText} ${words[i]}` : words[i];
      if (ctx.measureText(test).width > maxWidth && lineText) {
        if (lines === maxLines - 1) { ctx.fillText(`${lineText}...`, x, y); return; }
        ctx.fillText(lineText, x, y);
        lineText = words[i];
        y += lineHeight;
        lines++;
      } else {
        lineText = test;
      }
    }
    ctx.fillText(lineText, x, y);
  }

  /* 13. Theme, mode, keyboard, wiring ----------------------------------------- */
  const THEME_KEY = 'wthttp-theme'; // the only thing we ever store, in your own browser

  function currentTheme() {
    return el.root.dataset.theme || (prefersDark.matches ? 'dark' : 'light');
  }
  function applyTheme(theme) {
    if (theme) el.root.dataset.theme = theme;
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    el.themeToggle.setAttribute('aria-label', `Switch to ${next} theme`);
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode, no problem */ }
  }

  function setMode(mode) {
    el.body.classList.toggle('mode-simple', mode === 'simple');
    el.body.classList.toggle('mode-engineer', mode === 'engineer');
    document.querySelectorAll('.mode-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    // Panel height changed, so the vertical line on phones needs redrawing.
    requestAnimationFrame(drawTrack);
  }

  function submitSite(value) {
    const parsed = parseInput(value);
    if (!parsed.ok) {
      el.form.classList.add('has-error');
      el.help.innerHTML = inputErrorMessage(parsed);
      el.input.focus();
      return;
    }
    el.form.classList.remove('has-error');
    el.help.textContent = 'Any public website works. We only need the name.';
    el.input.value = parsed.displayHost + (parsed.path !== '/' ? parsed.path : '') + parsed.search;
    startTrip(parsed);
    // Move focus somewhere sensible now that the hero is hidden.
    el.panel.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  function onKey(e) {
    if (!state.trip) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); goTo(state.index + 1, { fromUser: true }); break;
      case 'ArrowLeft': e.preventDefault(); goTo(state.index - 1, { fromUser: true }); break;
      case 'Home': e.preventDefault(); goTo(0, { fromUser: true }); break;
      case 'End': e.preventDefault(); goTo(LAST, { fromUser: true }); break;
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        setPlaying(!state.playing);
        break;
      default:
    }
  }

  function init() {
    buildStations();
    renderIdle();

    // Theme: saved choice wins, otherwise follow the system.
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    applyTheme(saved === 'dark' || saved === 'light' ? saved : null);
    prefersDark.addEventListener('change', () => applyTheme());
    el.themeToggle.addEventListener('click', toggleTheme);

    document.querySelectorAll('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    el.form.addEventListener('submit', (e) => { e.preventDefault(); submitSite(el.input.value); });
    el.input.addEventListener('input', () => {
      if (el.form.classList.contains('has-error')) {
        el.form.classList.remove('has-error');
        el.help.textContent = 'Any public website works. We only need the name.';
      }
    });
    document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
      el.input.value = chip.dataset.site;
      submitSite(chip.dataset.site);
    }));

    el.stations.addEventListener('click', (e) => {
      const btn = e.target.closest('.station');
      if (btn && !btn.disabled) goTo(Number(btn.dataset.index), { fromUser: true });
    });
    el.prev.addEventListener('click', () => goTo(state.index - 1, { fromUser: true }));
    el.next.addEventListener('click', () => goTo(state.index + 1, { fromUser: true }));
    el.play.addEventListener('click', () => setPlaying(!state.playing));
    el.replay.addEventListener('click', () => { setPlaying(true, { silent: true }); goTo(0, { fromUser: true }); });
    el.speed.addEventListener('click', toggleSpeed);
    el.newTrip.addEventListener('click', endTrip);
    document.addEventListener('keydown', onKey);

    // Redraw the line whenever the layout changes size.
    new ResizeObserver(() => drawTrack()).observe(el.map);
    mobile.addEventListener('change', () => { placePanel(); drawTrack(); });
    // If someone turns on reduced motion mid trip, stop autoplay.
    reducedMotion.addEventListener('change', () => { if (reducedMotion.matches && state.playing) setPlaying(false); });

    drawTrack();

    // Shareable links: ?site=github.com starts that trip straight away.
    const site = new URLSearchParams(location.search).get('site');
    if (site) {
      el.input.value = site;
      submitSite(site);
    }
  }

  init();
})();
