// ==UserScript==
// @name         War Target List
// @namespace    eugene-torn-scripts
// @version      0.6.11
// @description  Torn faction war list with Ultimata (39th) dibs and FFScouter stats, for Torn PDA, Violentmonkey and Tampermonkey.
// @author       lannav
// @homepageURL  https://github.com/eugene-torn-scripts/war-target-list-userscript
// @updateURL    https://raw.githubusercontent.com/eugene-torn-scripts/war-target-list-userscript/main/war-target-list.user.js
// @downloadURL  https://raw.githubusercontent.com/eugene-torn-scripts/war-target-list-userscript/main/war-target-list.user.js
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/loader.php*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      ultimata.net
// @connect      ffscouter.com
// ==/UserScript==
(() => {
const WTL_PAGE = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
const WTL_GM = {
    xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null,
    getValue: typeof GM_getValue === "function" ? GM_getValue : null,
    setValue: typeof GM_setValue === "function" ? GM_setValue : null,
    info: typeof GM_info !== "undefined" && GM_info ? GM_info : null,
};
const WTL_PDA = {
    get: typeof PDA_httpGet === "function" ? PDA_httpGet : null,
    post: typeof PDA_httpPost === "function" ? PDA_httpPost : null,
    storage: typeof PDA_storage !== "undefined" && PDA_storage ? PDA_storage : null,
};
function splitSetCookie(value) {
    if (!value) return [];
    return String(value)
        .split(/,(?=\s*[^;,=\s]+=)/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function parseSetCookie(raw) {
    const [pair, ...attributes] = String(raw).split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const attrs = {};
    for (const attribute of attributes) {
        const at = attribute.indexOf("=");
        const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
        if (key) attrs[key] = at < 0 ? "" : attribute.slice(at + 1).trim();
    }
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attrs };
}

function isCookieExpired(cookie, nowMs) {
    if (cookie.value === "") return true;
    if (cookie.attrs["max-age"] !== undefined) {
        const age = Number(cookie.attrs["max-age"]);
        if (Number.isFinite(age)) return age <= 0;
    }
    if (cookie.attrs.expires) {
        const at = Date.parse(cookie.attrs.expires);
        if (Number.isFinite(at)) return at <= nowMs;
    }
    return false;
}

function createCookieJar(now) {
    const cookies = new Map();
    return {
        size: () => cookies.size,
        header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        toJSON: () => Object.fromEntries(cookies),
        replace(entries) {
            cookies.clear();
            for (const [name, value] of Object.entries(entries || {})) {
                if (name && typeof value === "string" && value) cookies.set(name, value);
            }
        },
        clear() {
            const had = cookies.size > 0;
            cookies.clear();
            return had;
        },
        store(setCookieHeader) {
            let changed = false;
            for (const raw of splitSetCookie(setCookieHeader)) {
                const cookie = parseSetCookie(raw);
                if (!cookie) continue;
                if (isCookieExpired(cookie, now())) {
                    if (cookies.delete(cookie.name)) changed = true;
                } else if (cookies.get(cookie.name) !== cookie.value) {
                    cookies.set(cookie.name, cookie.value);
                    changed = true;
                }
            }
            return changed;
        },
    };
}
function parseResponseHeaders(raw) {
    const headers = new Map();
    for (const line of String(raw || "").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
    return headers;
}

function hostOf(url) {
    const match = /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i.exec(String(url || ""));
    return match ? match[1].toLowerCase() : "";
}

function withTimeout(promise, ms, timers, label) {
    if (!ms) return promise;
    return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => reject(new Error(`${label} timeout`)), ms);
        promise.then(
            (value) => {
                timers.clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                timers.clearTimeout(timer);
                reject(err);
            },
        );
    });
}

function toResponse(raw) {
    return {
        status: Number(raw?.status) || 0,
        text: typeof raw?.responseText === "string" ? raw.responseText : "",
        headers: parseResponseHeaders(raw?.responseHeaders),
    };
}

function createPdaTransport({ get, post }) {
    return async (req) => {
        const raw = req.method === "POST" ? await post(req.url, req.headers, req.body ?? "") : await get(req.url, req.headers);
        if (!raw || typeof raw !== "object") throw new Error("no answer from Torn PDA: update the app to 3.3.1 or newer");
        return toResponse(raw);
    };
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function resolveUrl(location, base) {
    if (/^[a-z][a-z\d+.-]*:/i.test(location)) return location;
    if (location.startsWith("//")) return `${String(base).split(":")[0]}:${location}`;
    const origin = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+/i.exec(String(base))?.[0] || "";
    if (location.startsWith("/")) return origin + location;
    return String(base).replace(/[?#].*$/, "").replace(/[^/]*$/, "") + location;
}

function createGmTransport(gmRequest) {
    const once = (req) => new Promise((resolve, reject) => {
        gmRequest({
            method: req.method,
            url: req.url,
            headers: req.headers,
            data: req.body,
            timeout: req.timeoutMs || 0,
            redirect: "manual",
            onload: (res) => resolve(toResponse(res)),
            onerror: () => reject(new Error("network error")),
            ontimeout: () => reject(new Error("timeout")),
            onabort: () => reject(new Error("aborted")),
        });
    });
    return async (req) => {
        let current = req;
        for (let hop = 0; ; hop += 1) {
            const res = await once(current);
            const location = res.headers.get("location");
            if (!REDIRECT_CODES.has(res.status) || !location || hop >= MAX_REDIRECTS) return res;
            const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === "POST");
            current = { ...current, url: resolveUrl(location, current.url), method: toGet ? "GET" : current.method, body: toGet ? undefined : current.body };
        }
    };
}

function pickTransport({ page, pda, gm }) {
    if (typeof pda?.get === "function" && typeof pda?.post === "function") {
        return { kind: "pda", transport: createPdaTransport(pda) };
    }
    const bridge = page?.flutter_inappwebview;
    if (typeof bridge?.callHandler === "function") {
        return {
            kind: "pda",
            transport: createPdaTransport({
                get: (url, headers) => bridge.callHandler("PDA_httpGet", url, headers),
                post: (url, headers, body) => bridge.callHandler("PDA_httpPost", url, headers, body),
            }),
        };
    }
    if (typeof gm?.xmlhttpRequest === "function") return { kind: "gm", transport: createGmTransport(gm.xmlhttpRequest) };
    return null;
}

function createHttp({ transport, jar, cookieHost, onCookies, timers, defaultTimeoutMs = 20000 }) {
    return {
        async request({ method = "GET", url, headers = {}, body, timeoutMs = defaultTimeoutMs }) {
            if (!transport) throw new Error("no cross-origin HTTP in this browser");
            const sameHost = !!jar && hostOf(url) === cookieHost;
            const sent = { ...headers };
            if (sameHost && jar.size()) sent.Cookie = jar.header();
            const pending = transport({ method, url, headers: sent, body, timeoutMs });
            const res = await withTimeout(pending, timeoutMs, timers, `${method} ${hostOf(url)}`);
            if (sameHost && res.headers.has("set-cookie") && jar.store(res.headers.get("set-cookie"))) onCookies?.(jar.toJSON());
            return res;
        },
    };
}
function createStorage({ pda, gm, local, prefix = "wtl:" }) {
    if (typeof pda?.get === "function" && typeof pda?.set === "function") {
        return {
            kind: "pda",
            async load(key, fallback) {
                try {
                    const value = await pda.get(key, null);
                    return value == null ? fallback : value;
                } catch {
                    return fallback;
                }
            },
            async save(key, value) {
                try {
                    await pda.set(key, value);
                    return true;
                } catch {
                    return false;
                }
            },
        };
    }
    const backend = typeof gm?.getValue === "function" && typeof gm?.setValue === "function"
        ? { kind: "gm", read: (key) => gm.getValue(key, null), write: (key, raw) => gm.setValue(key, raw) }
        : { kind: "local", read: (key) => local.getItem(key), write: (key, raw) => local.setItem(key, raw) };
    return {
        kind: backend.kind,
        async load(key, fallback) {
            try {
                const raw = await backend.read(prefix + key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        async save(key, value) {
            try {
                await backend.write(prefix + key, JSON.stringify(value));
                return true;
            } catch {
                return false;
            }
        },
    };
}
const EIO_SEPARATOR = "\x1e";
const PROBE_BLOCKED_MS = 1500;
const PROBE_RELEASE_MS = 1000;

function decodePayload(text) {
    return String(text || "").split(EIO_SEPARATOR).filter((packet) => packet.length > 0);
}

function parseSocketPacket(body) {
    let rest = body.slice(1);
    let ns = "/";
    if (rest.startsWith("/")) {
        const comma = rest.indexOf(",");
        ns = comma < 0 ? rest : rest.slice(0, comma);
        rest = comma < 0 ? "" : rest.slice(comma + 1);
    }
    const ack = /^\d+/.exec(rest);
    if (ack) rest = rest.slice(ack[0].length);
    let data = null;
    if (rest) {
        try {
            data = JSON.parse(rest);
        } catch {
            data = null;
        }
    }
    return { type: body[0], ns, ack: ack ? Number(ack[0]) : null, data };
}

function createPollingSocket({ http, origin, namespace, timers, onConnect, onEvent, onClose, connectTimeoutMs = 15000, random = Math.random, now = () => Date.now() }) {
    const base = `${origin}/socket.io/?EIO=4&transport=polling`;
    const textHeaders = { "Content-Type": "text/plain;charset=UTF-8" };
    let sid = null;
    let open = false;
    let connected = false;
    let posting = false;
    let outbox = [];
    let pingInterval = 25000;
    let pingTimeout = 20000;
    let watchdog = null;
    let connectTimer = null;
    let requestCount = 0;
    let polling = false;
    let lastPollDoneAt = 0;
    let probeWaiter = null;
    let probing = false;

    function url() {
        requestCount += 1;
        const nonce = `${requestCount.toString(36)}${Math.floor(random() * 1e9).toString(36)}`;
        return `${base}${sid ? `&sid=${encodeURIComponent(sid)}` : ""}&t=${nonce}`;
    }

    function stopTimers() {
        timers.clearTimeout(watchdog);
        timers.clearTimeout(connectTimer);
        watchdog = null;
        connectTimer = null;
    }

    function armWatchdog() {
        timers.clearTimeout(watchdog);
        watchdog = timers.setTimeout(() => fail("server ping timeout"), pingInterval + pingTimeout);
    }

    function answerProbe(result) {
        const waiter = probeWaiter;
        probeWaiter = null;
        if (waiter) waiter(result);
    }

    function fail(reason) {
        if (!open) return;
        open = false;
        connected = false;
        outbox = [];
        answerProbe(null);
        stopTimers();
        onClose(reason);
    }

    function classifyProbe(startedAt, doneAt) {
        if (lastPollDoneAt <= startedAt) return "parallel";
        if (doneAt - startedAt >= PROBE_BLOCKED_MS && doneAt - lastPollDoneAt <= PROBE_RELEASE_MS) return "blocked";
        return null;
    }

    async function flush() {
        if (posting || !open || !outbox.length) return;
        posting = true;
        const body = outbox.join(EIO_SEPARATOR);
        outbox = [];
        const waiter = probeWaiter;
        probeWaiter = null;
        const startedAt = now();
        const pollOpen = polling;
        let sent = false;
        try {
            const res = await http.request({ method: "POST", url: url(), headers: textHeaders, body });
            if (res.status !== 200) fail(`send HTTP ${res.status}`);
            else sent = true;
        } catch (err) {
            fail(`send failed: ${err.message}`);
        }
        if (waiter) waiter(sent && pollOpen ? classifyProbe(startedAt, now()) : null);
        posting = false;
        flush();
    }

    function probe() {
        if (!open || probing) return Promise.resolve(null);
        probing = true;
        return new Promise((resolve) => {
            probeWaiter = (result) => {
                probing = false;
                resolve(result);
            };
            send("6");
        });
    }

    function send(packet) {
        if (!open) return false;
        outbox.push(packet);
        flush();
        return true;
    }

    function onSocketPacket(body) {
        const packet = parseSocketPacket(body);
        if (packet.ns !== namespace) return;
        if (packet.type === "0") {
            connected = true;
            timers.clearTimeout(connectTimer);
            connectTimer = null;
            onConnect(packet.data);
        } else if (packet.type === "4") {
            fail(`connect error: ${packet.data?.message || "refused"}`);
        } else if (packet.type === "1") {
            fail("disconnected by server");
        } else if (packet.type === "2" && Array.isArray(packet.data) && packet.data.length) {
            onEvent(packet.data[0], packet.data.slice(1));
        }
    }

    function onEnginePacket(packet) {
        const type = packet[0];
        if (type === "2") {
            armWatchdog();
            send("3");
        } else if (type === "1") {
            fail("closed by server");
        } else if (type === "4") {
            onSocketPacket(packet.slice(1));
        }
    }

    async function poll() {
        while (open) {
            let res;
            polling = true;
            try {
                res = await http.request({ url: url(), timeoutMs: pingInterval + pingTimeout });
            } catch (err) {
                polling = false;
                fail(`poll failed: ${err.message}`);
                return;
            }
            polling = false;
            lastPollDoneAt = now();
            if (!open) return;
            if (res.status !== 200) {
                fail(`poll HTTP ${res.status}`);
                return;
            }
            for (const packet of decodePayload(res.text)) {
                if (!open) return;
                onEnginePacket(packet);
            }
        }
    }

    async function start() {
        const res = await http.request({ url: url() });
        if (res.status !== 200) throw new Error(`handshake HTTP ${res.status}`);
        const packets = decodePayload(res.text);
        const handshake = packets.find((packet) => packet[0] === "0");
        let info = null;
        try {
            info = handshake ? JSON.parse(handshake.slice(1)) : null;
        } catch {
            info = null;
        }
        if (!info?.sid) throw new Error("handshake without sid");
        sid = info.sid;
        pingInterval = Number(info.pingInterval) || pingInterval;
        pingTimeout = Number(info.pingTimeout) || pingTimeout;
        open = true;
        armWatchdog();
        connectTimer = timers.setTimeout(() => fail("namespace connect timeout"), connectTimeoutMs);
        send(`40${namespace},`);
        for (const packet of packets) {
            if (packet !== handshake && open) onEnginePacket(packet);
        }
        poll();
    }

    function emit(name, ...args) {
        if (!connected) return false;
        return send(`42${namespace},${JSON.stringify([name, ...args])}`);
    }

    function close() {
        if (!open) return;
        open = false;
        connected = false;
        outbox = [];
        answerProbe(null);
        stopTimers();
        http.request({ method: "POST", url: url(), headers: textHeaders, body: "1" }).catch(() => null);
    }

    return { start, emit, close, probe, isOpen: () => open, isConnected: () => connected };
}
const WTL_DEFAULT_CONFIG = {
    ffKey: "",
    apiKey: "",
    warId: null,
    autoWarId: true,
    callAlertEnabled: true,
    callAlertLeadSec: 30,
    hideNative: true,
    showOwnFaction: true,
    soundEnabled: true,
    soundLeadSec: 10,
    statMin: "",
    statMax: "",
    ffMin: "",
    ffMax: "",
    idFilter: "",
};

function pickActiveWar(payload, factionId) {
    const list = Array.isArray(payload) ? payload
        : Array.isArray(payload?.wars) ? payload.wars
        : Array.isArray(payload?.data) ? payload.data
        : [];
    const mine = list.filter((war) => {
        const byFaction = war?.by_faction ?? war?.byFaction;
        return byFaction == null || String(byFaction) === String(factionId);
    });
    const active = (mine.length ? mine : list).filter((war) => war?.active !== false && !war?.ended_at);
    const sorted = active.sort((a, b) => Date.parse(b?.created_at || 0) - Date.parse(a?.created_at || 0));
    return sorted[0]?.id ?? null;
}

function warIdFromHtml(html) {
    const ids = [...String(html || "").matchAll(/\\?\/war\\?\/(\d+)/g)].map((match) => Number(match[1])).filter(Boolean);
    return ids.length ? Math.max(...ids) : null;
}

function parseAssignments(rows) {
    const map = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        let player = null;
        try {
            player = JSON.parse(String(row?.player));
        } catch {
            player = null;
        }
        if (!player || typeof player !== "object" || row.target_id == null) continue;
        (map[row.target_id] = map[row.target_id] || []).push(player);
    }
    return map;
}

function createCore({ http, storage, jar, timers, now, push, socketFactory, origin, log = () => {}, probeRequests = false, measureDelay = false, manager = null }) {
    const PROBE_DELAYS_MS = [2000, 30000, 90000];
    const DELAY_CHECK_AFTER_MS = 5000;
    const DELAY_SAMPLES = 3;
    const DELAY_SLOW_MS = 60;
    const DELAY_TIMEOUT_MS = 5000;
    const DELAY_PROBE_URL = "data:text/plain,wtl";
    const FF_TTL_MS = 24 * 60 * 60 * 1000;
    const FF_MISS_TTL_MS = 60 * 60 * 1000;
    const FF_BATCH = 200;
    const MAX_RECONNECT_MS = 30000;

    let config = { ...WTL_DEFAULT_CONFIG };
    const state = {
        connected: false,
        connecting: false,
        warId: null,
        war: null,
        ranked: null,
        members: [],
        dibs: [],
        me: null,
        lastError: null,
        needsLogin: false,
        assignments: {},
        groups: [],
        requestLock: false,
        requestDelayMs: null,
    };
    const ffCache = new Map();
    const listeners = new Set();
    let socket = null;
    let reconnectDelay = 1000;
    let reconnectTimer = null;
    let connectQueued = false;
    let started = false;
    let delayChecked = false;
    let markReady = null;
    const ready = new Promise((resolve) => {
        markReady = resolve;
    });

    function publicConfig() {
        const { apiKey, ...rest } = config;
        return { ...rest, apiKeySet: !!apiKey };
    }

    function publicState() {
        return {
            connected: state.connected,
            warId: state.warId,
            war: state.war,
            ranked: state.ranked,
            members: state.members,
            dibs: state.dibs,
            assignments: state.assignments,
            groups: state.groups,
            requestLock: state.requestLock,
            requestDelayMs: state.requestDelayMs,
            manager,
            me: state.me,
            config: publicConfig(),
            lastError: state.lastError,
            needsLogin: state.needsLogin,
        };
    }

    function snapshot() {
        return {
            connected: state.connected,
            connecting: state.connecting,
            needsLogin: state.needsLogin,
            lastError: state.lastError,
            warId: state.warId,
            me: state.me,
            config: publicConfig(),
        };
    }

    function broadcast(event, data) {
        push(event, data);
        const snap = snapshot();
        for (const listener of listeners) listener(snap);
    }

    async function api(path) {
        const res = await http.request({ url: `${origin}${path}`, headers: { accept: "*/*" } });
        if (res.status < 200 || res.status >= 300) throw new Error(`${path} -> HTTP ${res.status}`);
        try {
            return JSON.parse(res.text);
        } catch {
            throw new Error(`${path} -> invalid JSON`);
        }
    }

    async function login(apiKey) {
        const res = await http.request({
            method: "POST",
            url: `${origin}/api/login`,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: apiKey, shareKey: false }),
        });
        if (res.status >= 200 && res.status < 300) return;
        let message = "";
        try {
            message = JSON.parse(res.text)?.message || "";
        } catch {
            message = "";
        }
        const err = new Error(`login failed: ${message || `HTTP ${res.status}`}`);
        err.auth = res.status >= 400 && res.status < 500;
        throw err;
    }

    async function logout() {
        await http.request({ method: "POST", url: `${origin}/api/logout` }).catch(() => null);
        if (jar?.clear()) await storage.save("cookies", {});
    }

    async function ensureLoggedIn() {
        let me = await api("/api/user");
        if (!me?.isLoggedIn) {
            if (!config.apiKey) {
                state.needsLogin = true;
                throw new Error("not logged in: enter a Torn API key (public access)");
            }
            try {
                await login(config.apiKey);
            } catch (err) {
                if (err.auth) state.needsLogin = true;
                throw err;
            }
            me = await api("/api/user");
            if (!me?.isLoggedIn) {
                state.needsLogin = true;
                throw new Error("login did not start a session");
            }
        }
        state.needsLogin = false;
        state.me = { id: me.id, name: me.name, factionId: me.faction_id, factionName: me.faction_name };
    }

    async function resolveWarId() {
        if (!config.autoWarId && config.warId) return Number(config.warId);
        try {
            const id = pickActiveWar(await api("/api/wars"), state.me?.factionId);
            if (id) return Number(id);
        } catch (err) {
            log("war list api failed", err.message);
        }
        try {
            const res = await http.request({ url: `${origin}/wars` });
            const id = res.status >= 200 && res.status < 300 ? warIdFromHtml(res.text) : null;
            if (id) return id;
        } catch (err) {
            log("wars page scrape failed", err.message);
        }
        return config.warId ? Number(config.warId) : null;
    }

    function applyDibs(dibs) {
        state.dibs = Array.isArray(dibs) ? dibs : [];
        broadcast("dibs", { dibs: state.dibs });
    }

    function applyWarPayload(payload) {
        if (!payload) return;
        const data = payload.warData?.data || payload.data || payload;
        if (Array.isArray(data?.members)) state.members = data.members;
        if (payload.war) {
            state.war = payload.war;
            if (Array.isArray(payload.war.wars_assigned_targets)) state.assignments = parseAssignments(payload.war.wars_assigned_targets);
        }
        if (Array.isArray(payload.dibs)) applyDibs(payload.dibs);
        if (data?.ranked) state.ranked = data.ranked;
        broadcast("war", publicState());
    }

    async function loadGroups() {
        try {
            const res = await api(`/api/war/groups?facid=${encodeURIComponent(state.me.factionId)}`);
            state.groups = Array.isArray(res?.groups) ? res.groups : [];
        } catch (err) {
            log("groups failed", err.message);
        }
    }

    async function refreshWar() {
        if (!state.warId) return;
        applyWarPayload(await api(`/api/war/${state.warId}`));
    }

    function onServerEvent(name, args) {
        if (name === "war") {
            const data = args[0]?.data || args[0];
            if (!Array.isArray(data?.members)) return;
            state.members = data.members;
            if (data.ranked) state.ranked = data.ranked;
            broadcast("war", publicState());
        } else if (name === "dibs") {
            const [dibs, warId] = args;
            if (warId != null && Number(warId) !== Number(state.warId)) return;
            applyDibs(dibs);
        } else if (name === "war-update-member") {
            const member = args[0];
            if (!member?.playerId) return;
            const index = state.members.findIndex((m) => String(m.playerId) === String(member.playerId));
            if (index >= 0) state.members[index] = { ...state.members[index], ...member };
            else state.members.push(member);
            broadcast("member", { member });
        } else if (name === "war-refresh") {
            refreshWar().catch((err) => log("war refresh failed", err.message));
        } else if (name === "assign_targets") {
            state.assignments = args[0] && typeof args[0] === "object" ? args[0] : {};
            broadcast("assignments", { assignments: state.assignments, groups: state.groups });
        } else if (name === "user_list") {
            broadcast("users", { users: args[0] });
        } else {
            broadcast("event", { name, args });
        }
    }

    function scheduleProbe(current, attempt) {
        if (attempt >= PROBE_DELAYS_MS.length) return;
        timers.setTimeout(async () => {
            if (socket !== current || !current.isConnected()) return;
            const result = await current.probe();
            if (result === "blocked") {
                state.requestLock = true;
                log("requests wait for each other:", manager || "unknown userscript manager");
                broadcast("requests", { lock: true, delayMs: state.requestDelayMs, manager });
            } else if (result !== "parallel") {
                scheduleProbe(current, attempt + 1);
            }
        }, PROBE_DELAYS_MS[attempt]);
    }

    async function sampleRequestDelay() {
        const samples = [];
        for (let i = 0; i < DELAY_SAMPLES; i += 1) {
            const startedAt = now();
            await http.request({ url: DELAY_PROBE_URL, timeoutMs: DELAY_TIMEOUT_MS });
            samples.push(now() - startedAt);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)];
    }

    function scheduleDelayCheck() {
        if (!measureDelay || delayChecked) return;
        delayChecked = true;
        timers.setTimeout(async () => {
            let delay;
            try {
                delay = await sampleRequestDelay();
            } catch (err) {
                log("request delay check failed", err.message);
                return;
            }
            if (delay < DELAY_SLOW_MS) return;
            state.requestDelayMs = Math.round(delay);
            log("each request waits in the userscript manager:", `${state.requestDelayMs} ms`, manager || "unknown userscript manager");
            broadcast("requests", { lock: state.requestLock, delayMs: state.requestDelayMs, manager });
        }, DELAY_CHECK_AFTER_MS);
    }

    function closeSocket() {
        if (socket) socket.close();
        socket = null;
        state.connected = false;
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = timers.setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    }

    function openSocket() {
        const current = socketFactory({
            onConnect: () => {
                if (socket !== current) return;
                state.connected = true;
                state.lastError = null;
                reconnectDelay = 1000;
                current.emit("join-war-room", state.warId);
                broadcast("status", { connected: true, warId: state.warId, needsLogin: false });
                if (probeRequests && !state.requestLock) scheduleProbe(current, 0);
                scheduleDelayCheck();
            },
            onEvent: (name, args) => {
                if (socket === current) onServerEvent(name, args);
            },
            onClose: (reason) => {
                if (socket !== current) return;
                state.connected = false;
                state.lastError = reason;
                broadcast("status", { connected: false, error: reason, needsLogin: state.needsLogin });
                scheduleReconnect();
            },
        });
        socket = current;
        return current.start();
    }

    async function connect(force = false) {
        if (state.connecting) {
            if (force) connectQueued = true;
            return;
        }
        if (!force && socket?.isOpen()) return;
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        state.connecting = true;
        closeSocket();
        try {
            await ensureLoggedIn();
            await loadGroups();
            const warId = await resolveWarId();
            if (!warId) throw new Error("no active war found (set war id manually)");
            state.warId = warId;
            await refreshWar();
            await http.request({ url: `${origin}/api/socket` }).catch(() => null);
            await openSocket();
        } catch (err) {
            state.lastError = err.message;
            broadcast("status", { connected: false, error: err.message, needsLogin: state.needsLogin });
            if (!state.needsLogin) scheduleReconnect();
        } finally {
            state.connecting = false;
        }
        if (connectQueued) {
            connectQueued = false;
            await connect(true);
        }
    }

    function emitEvent(name, ...args) {
        if (!socket || !state.connected) return false;
        return socket.emit(name, ...args);
    }

    const ffFresh = (hit, at) => !!hit && at - hit.ts < (hit.value ? FF_TTL_MS : FF_MISS_TTL_MS);

    async function loadFFCache() {
        const saved = await storage.load("ff", null);
        const at = now();
        for (const entry of Array.isArray(saved) ? saved : []) {
            if (!Array.isArray(entry) || entry[0] == null) continue;
            const hit = { ts: Number(entry[1]), value: entry[2] && typeof entry[2] === "object" ? entry[2] : null };
            if (ffFresh(hit, at)) ffCache.set(String(entry[0]), hit);
        }
    }

    function saveFFCache(at) {
        const entries = [];
        for (const [id, hit] of ffCache) {
            if (ffFresh(hit, at)) entries.push([id, hit.ts, hit.value]);
            else ffCache.delete(id);
        }
        return storage.save("ff", entries);
    }

    async function fetchFF(ids) {
        const key = String(config.ffKey || "").trim();
        if (!key || !ids.length) return {};
        const at = now();
        const fresh = {};
        const missing = [];
        for (const raw of ids) {
            const id = String(raw);
            const hit = ffCache.get(id);
            if (!ffFresh(hit, at)) missing.push(id);
            else if (hit.value) fresh[id] = hit.value;
        }
        let learned = false;
        for (let i = 0; i < missing.length; i += FF_BATCH) {
            const batch = missing.slice(i, i + FF_BATCH);
            try {
                const res = await http.request({ url: `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${batch.join(",")}` });
                if (res.status < 200 || res.status >= 300) continue;
                const json = JSON.parse(res.text);
                const rows = Array.isArray(json) ? json : json?.data || [];
                for (const id of batch) ffCache.set(id, { ts: at, value: null });
                for (const row of rows) {
                    const id = String(row.player_id ?? row.target ?? row.id);
                    const value = {
                        fairFight: row.fair_fight ?? null,
                        bsEstimate: row.bs_estimate ?? null,
                        bsHuman: row.bs_estimate_human ?? null,
                        lastUpdated: row.last_updated ?? null,
                    };
                    if (value.bsEstimate == null && value.fairFight == null) continue;
                    ffCache.set(id, { ts: at, value });
                    fresh[id] = value;
                }
                learned = true;
            } catch (err) {
                log("ffscouter failed", err.message);
            }
        }
        if (learned) await saveFFCache(at);
        return fresh;
    }

    const handlers = {
        getState: async () => publicState(),
        getConfig: async () => publicConfig(),
        async setConfig(patch) {
            const next = { ...(patch || {}) };
            let keyChanged = false;
            if ("apiKey" in next) {
                next.apiKey = String(next.apiKey || "").trim();
                keyChanged = next.apiKey !== config.apiKey;
            }
            config = { ...config, ...next };
            await storage.save("config", config);
            if (keyChanged) {
                await logout();
                state.me = null;
                state.needsLogin = false;
            }
            if (keyChanged || "warId" in next || "autoWarId" in next) {
                state.warId = null;
                await connect(true);
            }
            broadcast("config", publicConfig());
            return publicConfig();
        },
        async connect() {
            await connect(true);
            return publicState();
        },
        async refresh() {
            await refreshWar();
            return publicState();
        },
        async toggleDibs({ targetId, targetName } = {}) {
            if (!state.connected) throw new Error("39th socket not connected");
            if (!emitEvent("dibs", Number(targetId), String(targetName), Number(state.warId))) throw new Error("emit failed");
            return { sent: true };
        },
        async overrideDibs({ targetId, targetName } = {}) {
            if (!state.connected) throw new Error("39th socket not connected");
            if (!emitEvent("override-dibs", Number(targetId), String(targetName), Number(state.warId))) throw new Error("emit failed");
            return { sent: true };
        },
        ff: async ({ ids } = {}) => fetchFF(ids || []),
    };

    async function handle(action, payload) {
        const handler = handlers[action];
        if (!handler) throw new Error(`unknown action: ${action}`);
        await ready;
        return handler(payload);
    }

    function listen(page, blocked) {
        page.addEventListener("message", (event) => {
            if (event.source !== page) return;
            const msg = event.data;
            if (!msg || msg.type !== "WTL_REQ" || blocked()) return;
            handle(msg.action, msg.payload).then(
                (data) => page.postMessage({ type: "WTL_RES", id: msg.id, response: { ok: true, data } }, "*"),
                (err) => page.postMessage({ type: "WTL_RES", id: msg.id, response: { ok: false, error: err.message } }, "*"),
            );
        });
    }

    async function start() {
        if (started) return;
        started = true;
        config = { ...WTL_DEFAULT_CONFIG, ...((await storage.load("config", null)) || {}) };
        if (jar) jar.replace(await storage.load("cookies", {}));
        await loadFFCache();
        markReady();
        await connect();
    }

    function resume() {
        if (!started || state.connected || state.connecting || state.needsLogin) return;
        reconnectDelay = 1000;
        connect(true);
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return { start, resume, handle, listen, subscribe, snapshot };
}
const WTL_ORIGIN = "https://ultimata.net";

function onDomReady(doc, fn) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
}

function injectStyle(doc, css) {
    const style = doc.createElement("style");
    style.id = "wtl-style";
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
}

function managerName(info) {
    return [info?.scriptHandler, info?.version].filter(Boolean).join(" ") || null;
}

function checksRequestDelay(kind, manager) {
    return kind === "gm" && /^tampermonkey\b/i.test(manager || "");
}

function extensionPresent(doc) {
    return doc.documentElement?.getAttribute("data-wtl-bridge") === "ready";
}

function wtlBootstrap({ page, doc, css, gm, pda, runEarly, runContent }) {
    if (page.__wtlUserscript) return;
    page.__wtlUserscript = true;
    const log = (...args) => console.log("[wtl]", ...args);
    const now = () => Date.now();
    const timers = {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        setInterval: (fn, ms) => setInterval(fn, ms),
    };

    injectStyle(doc, css);
    runEarly();

    let local = null;
    try {
        local = page.localStorage;
    } catch {
        local = null;
    }
    const storage = createStorage({ pda: pda.storage, gm, local });
    const picked = pickTransport({ page, pda, gm });
    const manager = managerName(gm.info);
    const jar = picked?.kind === "pda" ? createCookieJar(now) : null;
    const http = createHttp({
        transport: picked?.transport || null,
        jar,
        cookieHost: hostOf(WTL_ORIGIN),
        onCookies: (cookies) => storage.save("cookies", cookies),
        timers,
    });
    const core = createCore({
        http,
        storage,
        jar,
        timers,
        now,
        push: (event, data) => page.postMessage({ type: "WTL_PUSH", event, data }, "*"),
        socketFactory: (handlers) => createPollingSocket({ http, origin: WTL_ORIGIN, namespace: "/war", timers, ...handlers }),
        origin: WTL_ORIGIN,
        log,
        probeRequests: picked?.kind === "gm",
        measureDelay: checksRequestDelay(picked?.kind, manager),
        manager,
    });
    core.listen(page, () => extensionPresent(doc));
    page.__wtlCore = { snapshot: core.snapshot, transport: picked?.kind || "none", storage: storage.kind };

    onDomReady(doc, () => {
        if (extensionPresent(doc)) {
            log("War Target List extension found, the userscript stays passive");
            return;
        }
        core.start().catch((err) => log("start failed", err.message));
        doc.addEventListener("visibilitychange", () => {
            if (doc.visibilityState === "visible") core.resume();
        });
        page.addEventListener("pageshow", (event) => {
            if (event.persisted) core.resume();
        });
    });

    runContent();
}
const WTL_CSS = ".wtl-scope li.enemy,\n.wtl-scope li.your {\n    padding: 0 !important;\n    contain: layout style;\n}\n.wtl-scope [class*=\"your-faction\"] li.your { position: relative !important; }\n\n.wtl-scope [class*=\"userStatusWrap___\"],\n.wtl-scope [class*=\"level___\"]:not(.__warhelper),\n.wtl-scope .iconStats { display: none !important; }\n\n.wtl-scope [class*=\"honorWrap___\"][class*=\"flexCenter___\"][class*=\"honorWrapSmall___\"][class*=\"customBlockWrap___\"] img:not(.ff-scouter-arrow):not(.tt-ff-scouter-arrow),\n.wtl-scope [class*=\"honorWrap___\"][class*=\"flexCenter___\"][class*=\"customBlockWrap___\"] img:not(.ff-scouter-arrow):not(.tt-ff-scouter-arrow),\n.wtl-scope .honor-wrap img:not(.ff-scouter-arrow):not(.tt-ff-scouter-arrow),\n.wtl-scope .honor-image-wrap img:not(.ff-scouter-arrow):not(.tt-ff-scouter-arrow) {\n    opacity: 0 !important;\n    pointer-events: none !important;\n}\n.wtl-scope [class*=\"honorWrap___\"][class*=\"flexCenter___\"][class*=\"honorWrapSmall___\"][class*=\"customBlockWrap___\"],\n.wtl-scope [class*=\"honorWrap___\"][class*=\"flexCenter___\"][class*=\"customBlockWrap___\"] {\n    justify-content: flex-start !important;\n    text-align: left !important;\n    padding: 0 !important;\n    margin: 0 !important;\n    min-width: auto !important;\n    width: auto !important;\n    flex-shrink: 1 !important;\n}\n.wtl-scope [class*=\"honorWrap___\"] .honor-text-svg { display: none !important; }\n.wtl-scope .honor-text-wrap {\n    display: flex !important;\n    flex-direction: column !important;\n    align-items: flex-start !important;\n    justify-content: center !important;\n    line-height: 1 !important;\n    gap: 0 !important;\n}\n\n.wtl-attack-cell {\n    display: flex !important;\n    align-items: center !important;\n    gap: 4px !important;\n    flex-wrap: nowrap !important;\n    overflow: visible !important;\n    justify-content: flex-start !important;\n}\na.wtl-attack { opacity: 1 !important; pointer-events: auto !important; }\n\n.wtl-scope .tt-stats-estimate,\n.wtl-scope [class*=\"tt-stats-estimate\"],\n.wtl-scope [class*=\"statsEstimate\"],\n.wtl-scope [class*=\"estimate___\"] { display: none !important; }\n\n.wtl-scope li[data-estimate]::before,\n.wtl-scope li[data-estimate]::after,\n.wtl-scope li.tt-estimated::before,\n.wtl-scope li.tt-estimated::after { content: none !important; display: none !important; }\n\n.wtl-scope [class*=\"status___\"].wtl-has-timer { font-size: 0 !important; }\n.wtl-scope li[class*=\"enemy\"] [class*=\"attack___\"] > span,\n.wtl-scope li[class*=\"enemy\"] .attack > span { display: none !important; }\n\n.wtl-scope li[class*=\"enemy\"] [class*=\"factionWrap___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"factionWrap___\"] { display: none !important; }\n\n.wtl-scope li[class*=\"enemy\"] [class*=\"level___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"level___\"] { display: none !important; }\n.wtl-scope .white-grad [class*=\"level___\"]:not(.wtl-stat-head) { display: none !important; }\n\n.wtl-scope li[class*=\"enemy\"] [class*=\"attack___\"],\n.wtl-scope li[class*=\"enemy\"] .attack {\n    display: flex !important;\n    align-items: center !important;\n    gap: 4px !important;\n    justify-content: flex-start !important;\n    padding-right: 44px !important;\n}\n\n.wtl-scope .wtl-stat-head { cursor: pointer; }\n\n.wtl-scope li .member,\n.wtl-scope li [class*=\"member___\"],\n.wtl-scope li [class*=\"userInfoBox___\"],\n.wtl-scope li [class*=\"honorWrap___\"] { overflow: visible !important; }\n\n.wtl-scope li[class*=\"enemy\"] a.wtl-native-attack { display: none !important; }\n\n.wtl-scope li[class*=\"enemy\"] [class*=\"member___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"member___\"],\n.wtl-scope li[class*=\"enemy\"] [class*=\"userInfoBox___\"],\n.wtl-scope li[class*=\"enemy\"] [class*=\"honorWrap___\"],\n.wtl-scope li[class*=\"enemy\"] .honor-text-wrap { overflow: visible !important; }\n\n.wtl-scope .wtl-name-stack {\n    display: flex !important;\n    flex-direction: column !important;\n    align-items: flex-start !important;\n    justify-content: center !important;\n    line-height: 1.1 !important;\n}\n.wtl-scope li [class*=\"userInfoBox___\"] {\n    width: 100% !important;\n    max-width: 100% !important;\n    box-sizing: border-box !important;\n}\n.wtl-scope .wtl-name-stack > a {\n    width: auto !important;\n    height: auto !important;\n    min-width: 0 !important;\n}\n.wtl-scope .wtl-name-stack .honor-text-wrap {\n    width: auto !important;\n    min-width: 0 !important;\n}\n.wtl-scope .wtl-name-stack .honor-text-wrap > img:not(.ff-scouter-arrow):not(.tt-ff-scouter-arrow) { display: none !important; }\n.wtl-scope .wtl-name-stack .honor-text:not(.honor-text-svg) {\n    position: static !important;\n    display: block !important;\n    top: auto !important;\n    left: auto !important;\n    width: auto !important;\n    height: auto !important;\n    text-align: left !important;\n}\n.wtl-scope li[class*=\"enemy\"], .wtl-scope li[class*=\"your\"] { min-height: 34px; }\n\n.wtl-scope .wtl-meta { z-index: 6 !important; }\n\n.wtl-scope .wtl-stat,\n.wtl-scope .wtl-stat-head {\n    width: 46px !important;\n    min-width: 46px !important;\n    max-width: 46px !important;\n    flex: 0 0 46px !important;\n    text-align: center !important;\n    padding: 0 !important;\n    margin: 0 !important;\n    box-sizing: border-box !important;\n}\n\n.wtl-scope .white-grad > .member,\n.wtl-scope li[class*=\"enemy\"] > .member,\n.wtl-scope li[class*=\"your\"] > .member {\n    flex: 1 1 0 !important;\n    min-width: 0 !important;\n    width: 0 !important;\n}\n.wtl-scope li[class*=\"enemy\"],\n.wtl-scope li[class*=\"your\"] { flex-wrap: nowrap !important; }\n.wtl-scope .white-grad > .points,\n.wtl-scope li[class*=\"enemy\"] > .points,\n.wtl-scope li[class*=\"your\"] > .points {\n    flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;\n    text-align: center !important; padding: 0 !important; box-sizing: border-box !important;\n}\n.wtl-scope .white-grad > .status,\n.wtl-scope li[class*=\"enemy\"] > .status,\n.wtl-scope li[class*=\"your\"] > .status {\n    flex: 0 0 60px !important; width: 60px !important; min-width: 60px !important; max-width: 60px !important;\n    text-align: center !important; padding: 0 !important; box-sizing: border-box !important;\n}\n.wtl-scope li[class*=\"enemy\"] > [class*=\"status___\"],\n.wtl-scope li[class*=\"your\"] > [class*=\"status___\"] { overflow: hidden !important; text-overflow: ellipsis !important; }\n.wtl-scope .white-grad > .attack,\n.wtl-scope li[class*=\"enemy\"] > .attack,\n.wtl-scope li[class*=\"your\"] > .attack {\n    flex: 0 0 84px !important; width: 84px !important; min-width: 84px !important; max-width: 84px !important;\n    box-sizing: border-box !important;\n}\n\n.wtl-scope li[class*=\"enemy\"] > .attack { padding: 0 2px !important; }\n\n.wtl-scope li[class*=\"enemy\"] > .member,\n.wtl-scope li[class*=\"your\"] > .member { overflow: visible !important; }\n.wtl-scope .wtl-name-stack {\n    flex: 1 1 auto !important;\n    width: auto !important;\n    min-width: 0 !important;\n    max-width: calc(100% - 6px) !important;\n    margin-left: 6px !important;\n}\n.wtl-scope .honor-text,\n.wtl-scope [class*=\"honorWrap___\"] a {\n    overflow: hidden !important;\n    text-overflow: ellipsis !important;\n    white-space: nowrap !important;\n    max-width: 100% !important;\n}\n.wtl-scope li[class*=\"enemy\"], .wtl-scope li[class*=\"your\"] {\n    min-height: 36px !important;\n    height: auto !important;\n    padding-top: 2px !important;\n    padding-bottom: 2px !important;\n}\n.wtl-scope .wtl-la-col {\n    flex: 0 0 30px !important;\n    width: 30px !important;\n    min-width: 30px !important;\n    max-width: 30px !important;\n    display: flex !important;\n    align-items: center;\n    justify-content: flex-end;\n    padding: 0 2px 0 0 !important;\n    box-sizing: border-box !important;\n}\n.wtl-scope .wtl-la-header { right: 2px !important; padding: 0 2px !important; }\n\n.wtl-scope .white-grad { padding-right: 30px !important; box-sizing: border-box !important; }\n.wtl-scope li[class*=\"your\"] > .attack { flex: 0 0 84px !important; width: 84px !important; }\n\n.wtl-scope .white-grad > div {\n    font-size: 10px !important;\n    overflow: hidden !important;\n    text-overflow: clip !important;\n    white-space: nowrap !important;\n}\n.wtl-scope .white-grad > .points,\n.wtl-scope .white-grad > .status,\n.wtl-scope .white-grad > .attack { text-align: center !important; padding: 0 !important; }\n\n.wtl-scope li[class*=\"enemy\"], .wtl-scope li[class*=\"your\"] { align-items: center !important; }\n.wtl-scope .wtl-name-stack { line-height: 1.05 !important; padding: 1px 0 !important; }\n.wtl-scope .wtl-name-stack .honor-text,\n.wtl-scope .wtl-name-stack [class*=\"honorContainer___\"] { line-height: 1.1 !important; }\n.wtl-scope .wtl-meta { margin-top: 2px !important; }\n.wtl-scope li[class*=\"enemy\"] [class*=\"userInfoBox___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"userInfoBox___\"] { align-items: center !important; }\n\n.wtl-scope .white-grad {\n    display: flex !important;\n    align-items: center !important;\n    overflow: visible !important;\n}\n.wtl-scope .white-grad > .clear,\n.wtl-scope li[class*=\"enemy\"] > .clear,\n.wtl-scope li[class*=\"your\"] > .clear { display: none !important; }\n.wtl-scope .white-grad > div { float: none !important; }\n.wtl-scope li[class*=\"enemy\"] > div,\n.wtl-scope li[class*=\"your\"] > div { float: none !important; }\n\n.wtl-scope li[class*=\"enemy\"] [class*=\"userInfoBox___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"userInfoBox___\"],\n.wtl-scope li[class*=\"enemy\"] [class*=\"honorWrap___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"honorWrap___\"],\n.wtl-scope li[class*=\"enemy\"] .honor-text-wrap,\n.wtl-scope li[class*=\"your\"] .honor-text-wrap,\n.wtl-scope li[class*=\"enemy\"] [class*=\"honorContainer___\"],\n.wtl-scope li[class*=\"your\"] [class*=\"honorContainer___\"] {\n    height: auto !important;\n    max-height: none !important;\n    min-height: 0 !important;\n    overflow: visible !important;\n}\n\n.wtl-scope li.wtl-hidden { display: none !important; }\n\n.wtl-scope .white-grad > .wtl-stat-head { text-align: center !important; }\n.wtl-scope .white-grad > .points { text-align: center !important; padding: 0 !important; }\n.wtl-scope .white-grad > .status { text-align: center !important; }\n.wtl-scope .white-grad > .attack { text-align: left !important; padding: 0 0 0 6px !important; }\n.wtl-scope .wtl-la-header { text-align: right !important; }\n\n.wtl-scope .white-grad > .ffscouter-header,\n.wtl-scope .white-grad > .wtl-ffs-header {\n    flex: 0 0 38px !important;\n    width: 38px !important;\n    min-width: 38px !important;\n    max-width: 38px !important;\n    margin: 0 !important;\n    padding: 0 !important;\n    text-align: center !important;\n    box-sizing: border-box !important;\n}\n.wtl-scope li[class*=\"enemy\"] > .ffscouter-cell,\n.wtl-scope li[class*=\"your\"] > .ffscouter-cell {\n    flex: 0 0 32px !important;\n    width: 32px !important;\n    min-width: 32px !important;\n    max-width: 32px !important;\n    box-sizing: border-box !important;\n}\n\n.wtl-scope .ffscouter-marker-wrapper,\n.wtl-scope .ffscouter-marker-wrapper *,\n.wtl-scope .ffscouter-source-marker,\n.wtl-scope .tt-ff-scouter-arrow,\n.wtl-scope .wtl-meta,\n.wtl-scope .honor-text-wrap::before,\n.wtl-scope .honor-text-wrap::after { pointer-events: none !important; }\n\n.wtl-scope .wtl-la-col {\n    position: static !important;\n    order: 0 !important;\n    left: auto !important;\n    right: auto !important;\n    float: none !important;\n}\n.wtl-scope .wtl-call,\n.wtl-scope a.wtl-attack { transition: none !important; animation: none !important; }\n\n.wtl-scope .wtl-meta {\n    max-width: 100% !important;\n    overflow: hidden !important;\n    text-overflow: ellipsis !important;\n}\n.wtl-scope.wtl-narrow > .white-grad > .points,\n.wtl-scope.wtl-narrow li[class*=\"enemy\"] > .points,\n.wtl-scope.wtl-narrow li[class*=\"your\"] > .points,\n.wtl-scope.wtl-narrow li[class*=\"enemy\"] > [class*=\"points___\"],\n.wtl-scope.wtl-narrow li[class*=\"your\"] > [class*=\"points___\"] { display: none !important; }\n.wtl-scope .wtl-assigned-tag.wtl-has-order .wtl-assigned-word,\n.wtl-scope.wtl-narrow .wtl-assigned-tag:not(.wtl-has-order) { display: none; }\n.wtl-scope,\n#wtl-bar {\n    --wtl-font: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif;\n    --wtl-fg: #1c2128;\n    --wtl-fg-2: #4b5563;\n    --wtl-fg-3: #8a929c;\n    --wtl-line: rgba(15, 23, 42, .09);\n    --wtl-line-2: rgba(15, 23, 42, .18);\n    --wtl-card: #ffffff;\n    --wtl-raise: rgba(15, 23, 42, .04);\n    --wtl-raise-2: rgba(15, 23, 42, .075);\n    --wtl-field: #ffffff;\n    --wtl-head: #f2f4f6;\n    --wtl-accent: #2563eb;\n    --wtl-accent-soft: rgba(37, 99, 235, .13);\n    --wtl-on-accent: #ffffff;\n    --wtl-taken: #be123c;\n    --wtl-taken-bg: rgba(225, 29, 72, .09);\n    --wtl-taken-line: rgba(225, 29, 72, .30);\n    --wtl-assigned: #f59e0b;\n    --wtl-assigned-ink: #b45309;\n    --wtl-assigned-bg: rgba(245, 158, 11, .11);\n    --wtl-ok: #15803d;\n    --wtl-hosp: #dc2626;\n    --wtl-soon: #c2410c;\n    --wtl-out: #a16207;\n    --wtl-travel: #0369a1;\n    --wtl-online: #22c55e;\n    --wtl-idle: #f59e0b;\n    --wtl-offline: #a1a8b0;\n    --wtl-danger: #dc2626;\n    --wtl-danger-bg: rgba(220, 38, 38, .10);\n    --wtl-hard: #ea580c;\n    --wtl-hard-bg: rgba(234, 88, 12, .11);\n    --wtl-even: #a16207;\n    --wtl-even-bg: rgba(202, 138, 4, .15);\n    --wtl-good: #15803d;\n    --wtl-good-bg: rgba(22, 163, 74, .12);\n    --wtl-easy: #0e7490;\n    --wtl-easy-bg: rgba(8, 145, 178, .11);\n    --wtl-tiny: #6b7280;\n    --wtl-tiny-bg: rgba(107, 114, 128, .11);\n}\nbody.dark-mode .wtl-scope,\nbody.dark-mode #wtl-bar {\n    --wtl-fg: #e8eaed;\n    --wtl-fg-2: #b0b6bd;\n    --wtl-fg-3: #7f8790;\n    --wtl-line: rgba(255, 255, 255, .08);\n    --wtl-line-2: rgba(255, 255, 255, .16);\n    --wtl-card: #1e2125;\n    --wtl-raise: rgba(255, 255, 255, .04);\n    --wtl-raise-2: rgba(255, 255, 255, .08);\n    --wtl-field: #141619;\n    --wtl-head: #23262a;\n    --wtl-accent: #3b82f6;\n    --wtl-accent-soft: rgba(59, 130, 246, .20);\n    --wtl-taken: #ff8fa3;\n    --wtl-taken-bg: rgba(255, 99, 132, .14);\n    --wtl-taken-line: rgba(255, 99, 132, .32);\n    --wtl-assigned: #fbbf24;\n    --wtl-assigned-ink: #fcd34d;\n    --wtl-assigned-bg: rgba(251, 191, 36, .09);\n    --wtl-ok: #4ade80;\n    --wtl-hosp: #f87171;\n    --wtl-soon: #fb923c;\n    --wtl-out: #fde047;\n    --wtl-travel: #7dd3fc;\n    --wtl-online: #4ade80;\n    --wtl-idle: #fbbf24;\n    --wtl-offline: #6b7280;\n    --wtl-danger: #ff6b6b;\n    --wtl-danger-bg: rgba(255, 107, 107, .15);\n    --wtl-hard: #ffa94d;\n    --wtl-hard-bg: rgba(255, 169, 77, .15);\n    --wtl-even: #ffd43b;\n    --wtl-even-bg: rgba(255, 212, 59, .13);\n    --wtl-good: #69db7c;\n    --wtl-good-bg: rgba(105, 219, 124, .14);\n    --wtl-easy: #66d9e8;\n    --wtl-easy-bg: rgba(102, 217, 232, .13);\n    --wtl-tiny: #adb5bd;\n    --wtl-tiny-bg: rgba(173, 181, 189, .12);\n}\n\n.wtl-scope .white-grad,\n.wtl-scope li[class*=\"enemy\"],\n.wtl-scope li[class*=\"your\"] { font-family: var(--wtl-font) !important; }\n\n.wtl-scope .white-grad {\n    background: var(--wtl-head) !important;\n    border-bottom: 1px solid var(--wtl-line) !important;\n    box-shadow: none !important;\n}\n.wtl-scope .white-grad > div {\n    color: var(--wtl-fg-3) !important;\n    font-family: var(--wtl-font) !important;\n    font-weight: 700 !important;\n    letter-spacing: .05em !important;\n    text-transform: uppercase !important;\n    text-shadow: none !important;\n}\n.wtl-scope .white-grad > [data-wtl-sort] { color: var(--wtl-fg) !important; }\n.wtl-scope .white-grad.wtl-sorted [class*=\"sortIcon___\"],\n.wtl-scope .ffscouter-sort-icon { display: none !important; }\n.wtl-scope .wtl-sort-arrow {\n    display: inline-block !important;\n    position: static !important;\n    flex: none !important;\n    width: 0 !important;\n    height: 0 !important;\n    margin: 0 0 0 4px !important;\n    padding: 0 !important;\n    vertical-align: 1px !important;\n    background: none !important;\n    border-left: 3.5px solid transparent !important;\n    border-right: 3.5px solid transparent !important;\n}\n.wtl-scope .wtl-sort-arrow[data-dir=\"asc\"] { border-top: 0 !important; border-bottom: 4px solid var(--wtl-accent) !important; }\n.wtl-scope .wtl-sort-arrow[data-dir=\"desc\"] { border-bottom: 0 !important; border-top: 4px solid var(--wtl-accent) !important; }\n\n.wtl-scope .wtl-name-stack > a {\n    display: inline-flex !important;\n    align-items: center !important;\n    justify-content: flex-start !important;\n    gap: 5px !important;\n    max-width: 100% !important;\n    text-decoration: none !important;\n}\n.wtl-scope .wtl-name-stack > a::before {\n    content: \"\";\n    flex: none;\n    width: 7px;\n    height: 7px;\n    border-radius: 50%;\n    background: var(--wtl-dot, transparent);\n}\n.wtl-scope .wtl-name-stack[data-wtl-online=\"online\"] { --wtl-dot: var(--wtl-online); }\n.wtl-scope .wtl-name-stack[data-wtl-online=\"idle\"] { --wtl-dot: var(--wtl-idle); }\n.wtl-scope .wtl-name-stack[data-wtl-online=\"offline\"] { --wtl-dot: var(--wtl-offline); }\n.wtl-scope .honor-text {\n    color: var(--wtl-fg) !important;\n    font-family: var(--wtl-font) !important;\n    font-size: 12px !important;\n    font-weight: 600 !important;\n    line-height: 1.2 !important;\n    letter-spacing: 0 !important;\n    text-shadow: none !important;\n    -webkit-text-stroke: 0 !important;\n    background: none !important;\n}\n.wtl-scope .wtl-meta {\n    box-sizing: border-box !important;\n    padding-left: 12px !important;\n    color: var(--wtl-fg-3) !important;\n    font-family: var(--wtl-font) !important;\n    font-weight: 500 !important;\n    letter-spacing: .01em !important;\n}\n.wtl-scope .wtl-revive {\n    color: var(--wtl-good) !important;\n    font-size: 9px;\n}\n.wtl-scope .wtl-assigned-tag {\n    order: -1;\n    padding: 0 4px;\n    border-radius: 3px;\n    background: var(--wtl-assigned-bg);\n    color: var(--wtl-assigned-ink) !important;\n    font-weight: 700 !important;\n}\n.wtl-scope .wtl-assigned-tag::first-letter { text-transform: uppercase; }\n.wtl-scope .wtl-assigned-tag .wtl-assigned-word { color: inherit !important; font: inherit !important; }\n\n.wtl-scope li[class*=\"enemy\"] > .points,\n.wtl-scope li[class*=\"your\"] > .points,\n.wtl-scope li[class*=\"enemy\"] > [class*=\"points___\"],\n.wtl-scope li[class*=\"your\"] > [class*=\"points___\"] {\n    color: var(--wtl-fg-3) !important;\n    font-family: var(--wtl-font) !important;\n    font-size: 11px !important;\n    font-weight: 600 !important;\n    font-variant-numeric: tabular-nums;\n}\n\n.wtl-scope li[class*=\"enemy\"] > [class*=\"status___\"],\n.wtl-scope li[class*=\"your\"] > [class*=\"status___\"] {\n    color: var(--wtl-fg-2) !important;\n    font-family: var(--wtl-font) !important;\n    font-weight: 600 !important;\n    letter-spacing: 0 !important;\n    text-transform: none !important;\n}\n.wtl-scope li[class*=\"enemy\"] > [class*=\"status___\"]:not(.wtl-has-timer),\n.wtl-scope li[class*=\"your\"] > [class*=\"status___\"]:not(.wtl-has-timer) { font-size: 11px !important; }\n.wtl-scope li > [class*=\"status___\"].wtl-okay { color: var(--wtl-ok) !important; }\n.wtl-scope li > [class*=\"status___\"].wtl-travel { color: var(--wtl-travel) !important; }\n.wtl-scope .wtl-timer {\n    font-family: var(--wtl-font) !important;\n    font-size: 11px !important;\n    font-weight: 700 !important;\n    font-variant-numeric: tabular-nums;\n    letter-spacing: 0 !important;\n}\n.wtl-scope .wtl-hosp > .wtl-timer { color: var(--wtl-hosp) !important; }\n.wtl-scope .wtl-soon > .wtl-timer { color: var(--wtl-soon) !important; }\n.wtl-scope .wtl-out > .wtl-timer { color: var(--wtl-out) !important; }\n\n.wtl-scope .wtl-la-col {\n    color: var(--wtl-fg-3) !important;\n    font-family: var(--wtl-font) !important;\n    font-size: 10.5px !important;\n    font-weight: 600 !important;\n    font-variant-numeric: tabular-nums;\n}\n\n.wtl-scope .wtl-stat { cursor: help; }\n.wtl-scope .wtl-stat-value {\n    display: inline-block !important;\n    min-width: 34px;\n    padding: 2px 4px !important;\n    box-sizing: border-box;\n    border-radius: 999px;\n    background: var(--wtl-tier-bg, transparent);\n    color: var(--wtl-tier, var(--wtl-fg-3)) !important;\n    font-family: var(--wtl-font) !important;\n    font-size: 10.5px !important;\n    font-weight: 700 !important;\n    font-variant-numeric: tabular-nums;\n    line-height: 1.3 !important;\n    text-align: center;\n}\n.wtl-scope .wtl-stat-danger { --wtl-tier: var(--wtl-danger); --wtl-tier-bg: var(--wtl-danger-bg); }\n.wtl-scope .wtl-stat-hard { --wtl-tier: var(--wtl-hard); --wtl-tier-bg: var(--wtl-hard-bg); }\n.wtl-scope .wtl-stat-even { --wtl-tier: var(--wtl-even); --wtl-tier-bg: var(--wtl-even-bg); }\n.wtl-scope .wtl-stat-good { --wtl-tier: var(--wtl-good); --wtl-tier-bg: var(--wtl-good-bg); }\n.wtl-scope .wtl-stat-easy { --wtl-tier: var(--wtl-easy); --wtl-tier-bg: var(--wtl-easy-bg); }\n.wtl-scope .wtl-stat-tiny { --wtl-tier: var(--wtl-tiny); --wtl-tier-bg: var(--wtl-tiny-bg); }\n.wtl-scope .wtl-stat-wait { --wtl-tier: var(--wtl-fg-3); --wtl-tier-bg: transparent; font-weight: 500 !important; }\n\n.wtl-scope button.wtl-call {\n    -webkit-appearance: none !important;\n    appearance: none !important;\n    flex: 0 0 52px !important;\n    width: 52px !important;\n    min-width: 52px !important;\n    max-width: 52px !important;\n    height: 24px !important;\n    margin: 0 !important;\n    padding: 0 4px !important;\n    box-sizing: border-box !important;\n    border: 1px solid var(--wtl-line-2) !important;\n    border-radius: 6px !important;\n    background: var(--wtl-raise-2) !important;\n    box-shadow: none !important;\n    color: var(--wtl-fg) !important;\n    font-family: var(--wtl-font) !important;\n    font-size: 11px !important;\n    font-weight: 600 !important;\n    line-height: 22px !important;\n    letter-spacing: 0 !important;\n    text-align: center !important;\n    text-shadow: none !important;\n    text-transform: none !important;\n    white-space: nowrap !important;\n    overflow: hidden !important;\n    text-overflow: ellipsis !important;\n    cursor: pointer !important;\n}\n.wtl-scope button.wtl-call.wtl-call-mine {\n    border-color: transparent !important;\n    background: var(--wtl-accent) !important;\n    color: var(--wtl-on-accent) !important;\n}\n.wtl-scope button.wtl-call.wtl-call-taken {\n    border-color: var(--wtl-taken-line) !important;\n    background: var(--wtl-taken-bg) !important;\n    color: var(--wtl-taken) !important;\n}\n.wtl-scope button.wtl-call.wtl-call-locked,\n.wtl-scope button.wtl-call:disabled {\n    opacity: .45 !important;\n    cursor: not-allowed !important;\n}\n\n.wtl-scope a.wtl-attack {\n    display: inline-flex !important;\n    align-items: center !important;\n    justify-content: center !important;\n    flex: 0 0 24px !important;\n    width: 24px !important;\n    height: 24px !important;\n    padding: 0 !important;\n    box-sizing: border-box !important;\n    border: 1px solid var(--wtl-line-2) !important;\n    border-radius: 6px !important;\n    background: var(--wtl-raise) !important;\n    color: var(--wtl-fg-2) !important;\n    text-decoration: none !important;\n}\n.wtl-scope a.wtl-attack svg { display: block; width: 14px; height: 14px; }\n\n.wtl-scope li.wtl-assigned {\n    box-shadow: inset 3px 0 0 var(--wtl-assigned) !important;\n    background-image: linear-gradient(var(--wtl-assigned-bg), var(--wtl-assigned-bg)) !important;\n}\n.wtl-scope li.wtl-flash { animation: wtlFlash 1.4s ease-out; }\n@keyframes wtlFlash {\n    from { background-color: var(--wtl-accent-soft); }\n}\n\n#wtl-bar {\n    display: block;\n    margin: 0 0 8px;\n    padding: 8px 10px;\n    box-sizing: border-box;\n    border: 1px solid var(--wtl-line);\n    border-radius: 10px;\n    background: var(--wtl-card);\n    color: var(--wtl-fg-2);\n    font: 12px/1.35 var(--wtl-font);\n    text-align: left;\n}\n#wtl-bar svg { display: block; flex: none; width: 14px; height: 14px; }\n#wtl-bar .wtl-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }\n#wtl-bar .wtl-brand { display: inline-flex; align-items: center; gap: 6px; color: var(--wtl-fg); font-size: 13px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; }\n#wtl-bar .wtl-brand svg { width: 17px; height: 17px; color: var(--wtl-accent); }\n#wtl-bar .wtl-badge {\n    display: inline-flex;\n    align-items: center;\n    gap: 6px;\n    min-height: 22px;\n    padding: 0 9px;\n    box-sizing: border-box;\n    border-radius: 999px;\n    background: var(--wtl-raise-2);\n    color: var(--wtl-fg-2);\n    font-size: 11px;\n    font-weight: 600;\n}\n#wtl-bar .wtl-badge::before { content: \"\"; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }\n#wtl-bar .wtl-badge.wtl-on { color: var(--wtl-ok); }\n#wtl-bar .wtl-badge.wtl-warn { color: var(--wtl-soon); }\n#wtl-bar .wtl-badge.wtl-off { color: var(--wtl-hosp); }\n#wtl-bar .wtl-badge[hidden] { display: none !important; }\n#wtl-bar .wtl-head > .wtl-gear { margin-left: auto; }\n#wtl-bar .wtl-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; }\n#wtl-bar .wtl-group,\n#wtl-bar .wtl-control { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px; }\n#wtl-bar .wtl-label { color: var(--wtl-fg-3); font-size: 11px; font-weight: 600; }\n#wtl-bar .wtl-dash { color: var(--wtl-fg-3); }\n#wtl-bar input[type=\"text\"],\n#wtl-bar input[type=\"password\"] {\n    height: 24px;\n    margin: 0;\n    padding: 0 7px;\n    box-sizing: border-box;\n    border: 1px solid var(--wtl-line-2);\n    border-radius: 6px;\n    background: var(--wtl-field);\n    color: var(--wtl-fg);\n    font: 12px var(--wtl-font);\n    outline: none;\n}\n#wtl-bar input::placeholder { color: var(--wtl-fg-3); opacity: 1; }\n#wtl-bar input[type=\"text\"]:focus,\n#wtl-bar input[type=\"password\"]:focus { border-color: var(--wtl-accent); box-shadow: 0 0 0 3px var(--wtl-accent-soft); }\n#wtl-bar .wtl-mini {\n    display: inline-flex;\n    align-items: center;\n    gap: 5px;\n    height: 24px;\n    margin: 0;\n    padding: 0 10px;\n    box-sizing: border-box;\n    border: 1px solid var(--wtl-line-2);\n    border-radius: 6px;\n    background: var(--wtl-raise-2);\n    color: var(--wtl-fg);\n    font: 600 11px var(--wtl-font);\n    white-space: nowrap;\n    cursor: pointer;\n}\n#wtl-bar .wtl-mini.wtl-primary { border-color: transparent; background: var(--wtl-accent); color: var(--wtl-on-accent); }\n#wtl-bar .wtl-gear.wtl-active { border-color: var(--wtl-accent); background: var(--wtl-accent-soft); color: var(--wtl-accent); }\n#wtl-bar .wtl-err { margin-top: 6px; color: var(--wtl-hosp); }\n#wtl-bar .wtl-err:empty { display: none; }\n#wtl-bar .wtl-notice {\n    display: flex;\n    align-items: center;\n    flex-wrap: wrap;\n    gap: 8px 12px;\n    margin-top: 8px;\n    padding: 8px 10px;\n    border: 1px solid var(--wtl-assigned);\n    border-radius: 8px;\n    background: var(--wtl-assigned-bg);\n    color: var(--wtl-fg);\n}\n#wtl-bar .wtl-notice[hidden] { display: none !important; }\n#wtl-bar .wtl-link { color: var(--wtl-accent); font-weight: 600; text-decoration: underline; }\n#wtl-bar .wtl-link[hidden] { display: none !important; }\n#wtl-bar .wtl-panel {\n    display: grid;\n    grid-template-columns: max-content minmax(0, 1fr);\n    align-items: center;\n    gap: 6px 14px;\n    margin-top: 8px;\n    padding: 10px 12px;\n    border-radius: 8px;\n    background: var(--wtl-raise);\n}\n#wtl-bar .wtl-panel[hidden],\n#wtl-bar .wtl-field[hidden] { display: none !important; }\n#wtl-bar .wtl-field { display: contents; }\n#wtl-bar .wtl-field > .wtl-label { color: var(--wtl-fg); font-size: 12px; }\n#wtl-bar .wtl-control { color: var(--wtl-fg-2); }\n#wtl-bar .wtl-section {\n    grid-column: 1 / -1;\n    margin-top: 4px;\n    padding-top: 8px;\n    border-top: 1px solid var(--wtl-line);\n    color: var(--wtl-fg-3);\n    font-size: 10px;\n    font-weight: 700;\n    letter-spacing: .08em;\n    text-transform: uppercase;\n}\n#wtl-bar .wtl-section:first-child { margin-top: 0; padding-top: 0; border-top: 0; }\n#wtl-bar .wtl-hint { grid-column: 2; margin: -3px 0 4px; color: var(--wtl-fg-3); font-size: 11px; }\n#wtl-bar .wtl-saved { grid-column: 1 / -1; min-height: 15px; color: var(--wtl-fg-2); }\n#wtl-bar .wtl-saved:empty { min-height: 0; }\n#wtl-bar input.wtl-switch {\n    -webkit-appearance: none;\n    appearance: none;\n    position: relative;\n    flex: none;\n    width: 30px;\n    height: 18px;\n    margin: 0;\n    border-radius: 999px;\n    background: var(--wtl-line-2);\n    cursor: pointer;\n    transition: background-color .15s ease;\n}\n#wtl-bar input.wtl-switch::after {\n    content: \"\";\n    position: absolute;\n    top: 2px;\n    left: 2px;\n    width: 14px;\n    height: 14px;\n    border-radius: 50%;\n    background: #ffffff;\n    box-shadow: 0 1px 2px rgba(0, 0, 0, .35);\n    transition: transform .15s ease;\n}\n#wtl-bar input.wtl-switch:checked { background: var(--wtl-accent); }\n#wtl-bar input.wtl-switch:checked::after { transform: translateX(12px); }\n@media (max-width: 520px) {\n    #wtl-bar .wtl-panel { grid-template-columns: minmax(0, 1fr); }\n    #wtl-bar .wtl-hint { grid-column: 1; }\n}\n";
wtlBootstrap({
page: WTL_PAGE,
doc: document,
css: WTL_CSS,
gm: WTL_GM,
pda: WTL_PDA,
runEarly: () => {
(function (window) {
(() => {
    const W = window;
    if (W.__wtlEarly) return;
    W.__wtlEarly = true;

    const BUFFER_CAP = 500;
    const HOSP_ICON_RE = /Hospital[^>]*data-time=(?:'|&#039;|&quot;|")(\d+)(?:'|&#039;|&quot;|")/;

    W.__wtlQueue = [];
    W.__wtlReady = false;

    function emit(kind, data) {
        const msg = { kind, data, ts: Date.now() };
        if (W.__wtlReady) {
            W.dispatchEvent(new CustomEvent("wtl:torn", { detail: msg }));
            return;
        }
        W.__wtlQueue.push(msg);
        if (W.__wtlQueue.length > BUFFER_CAP) W.__wtlQueue.splice(0, W.__wtlQueue.length - BUFFER_CAP);
    }
    W.__wtlEmit = emit;

    const torn = { hooked: 0, open: 0, statuses: 0 };
    W.__wtlTornSocket = torn;
    const tornSockets = new WeakSet();
    const TORN_SOCKET_PATH = /\/connection\/websocket/i;

    function watchTorn(socket) {
        if (!socket || tornSockets.has(socket)) return;
        tornSockets.add(socket);
        torn.hooked += 1;
        let open = false;
        const update = (next) => {
            if (next === open) return;
            open = next;
            torn.open += next ? 1 : -1;
            emit("socket", { open: torn.open, hooked: torn.hooked });
        };
        socket.addEventListener("open", () => update(true));
        socket.addEventListener("close", () => update(false));
        if (socket.readyState === 1) update(true);
    }

    function normStatus(userId, status) {
        const text = String(status?.text || "").trim();
        if (!text) return null;
        return {
            id: String(userId),
            text,
            details: status?.details || "",
            until: status?.until || status?.updateAt || null,
            area: status?.area ?? null,
        };
    }

    const hasStatus = (text) => text.indexOf("updateStatus") !== -1 || text.indexOf("updateIcons") !== -1;

    function parseJson(text) {
        try {
            return JSON.parse(text);
        } catch (err) {
            const pos = String(err).match(/position (\d+)/);
            if (!pos) return null;
            try { return JSON.parse(text.substring(0, parseInt(pos[1], 10))); } catch { return null; }
        }
    }

    function onWsMessage(event) {
        const raw = event.data;
        if (typeof raw !== "string" || raw[0] !== "{" || !hasStatus(raw)) return;
        for (const line of raw.split("\n")) {
            if (line[0] === "{" && hasStatus(line)) readPush(parseJson(line), event.currentTarget);
        }
    }

    function readPush(json, socket) {
        const actions = json?.push?.pub?.data?.message?.namespaces?.users?.actions;
        if (!actions) return;
        torn.statuses += 1;
        watchTorn(socket);

        const su = actions.updateStatus;
        if (su && su.status) {
            const n = normStatus(su.userId, su.status);
            if (n) emit("status", n);
        }

        const iu = actions.updateIcons;
        if (iu && iu.icons) {
            const m = String(iu.icons).match(HOSP_ICON_RE);
            emit("icons", {
                id: String(iu.userId),
                hospSeconds: m ? parseInt(m[1], 10) : null,
                icons: String(iu.icons),
            });
        }
    }

    const NativeWebSocket = W.WebSocket;
    function PatchedWebSocket(...args) {
        const socket = new NativeWebSocket(...args);
        try {
            socket.addEventListener("message", onWsMessage);
            if (TORN_SOCKET_PATH.test(String(args[0]))) watchTorn(socket);
        } catch { /* noop */ }
        return socket;
    }
    PatchedWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(PatchedWebSocket, {
        CONNECTING: { value: NativeWebSocket.CONNECTING },
        OPEN: { value: NativeWebSocket.OPEN },
        CLOSING: { value: NativeWebSocket.CLOSING },
        CLOSED: { value: NativeWebSocket.CLOSED },
    });
    W.WebSocket = PatchedWebSocket;

    function matchUrl(url) {
        if (typeof url !== "string") return null;
        if (url.includes("step=getwarusers")) return "getwarusers";
        if (url.includes("step=getwardata")) return "getwardata";
        if (url.includes("step=getProcessBarRefreshData")) return "processbar";
        if (url.includes("chat/online-status")) return "online";
        return null;
    }

    function publishBulk(kind, text) {
        if (!text || text[0] !== "{") return;
        let json;
        try { json = JSON.parse(text); } catch { return; }

        const statuses = [];
        const online = {};

        const warDescMembers = json?.warDesc?.members || json?.userStatuses;
        if (warDescMembers && typeof warDescMembers === "object") {
            for (const id of Object.keys(warDescMembers)) {
                const member = warDescMembers[id];
                const n = normStatus(member?.userID || id, member?.status || member);
                if (n) {
                    n.name = member?.playername || member?.name || null;
                    n.level = member?.level ?? null;
                    statuses.push(n);
                }
            }
        }

        if (json?.rankedWarMembers && typeof json.rankedWarMembers === "object") {
            for (const [id, data] of Object.entries(json.rankedWarMembers)) {
                const n = normStatus(id, data?.status);
                if (n) statuses.push(n);
                const os = data?.onlineStatus?.status;
                if (os) online[String(id)] = os;
            }
        }

        if (Array.isArray(json?.members)) {
            for (const member of json.members) {
                const n = normStatus(member?.userID, member?.status);
                if (n) statuses.push(n);
            }
        }

        if (Array.isArray(json?.users)) {
            for (const user of json.users) {
                if (user?.userID != null && user?.status) online[String(user.userID)] = String(user.status);
            }
        }

        if (statuses.length || Object.keys(online).length) emit("bulk", { kind, statuses, online });
    }

    const nativeFetch = W.fetch;
    if (typeof nativeFetch === "function") {
        W.fetch = function (input, init) {
            const url = typeof input === "string" ? input : input?.url;
            const promise = nativeFetch.call(this, input, init);
            const kind = matchUrl(url);
            if (kind) {
                promise.then((res) => {
                    if (!res || !res.ok) return;
                    res.clone().text().then((t) => publishBulk(kind, t)).catch(() => {});
                }).catch(() => {});
            }
            return promise;
        };
    }

    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const open = XHR.prototype.open;
        const send = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
            this.__wtlUrl = url;
            return open.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (body) {
            const kind = matchUrl(this.__wtlUrl);
            if (kind) {
                this.addEventListener("load", () => {
                    if (this.status >= 200 && this.status < 300) publishBulk(kind, this.responseText || "");
                });
            }
            return send.call(this, body);
        };
    }
})();
})(WTL_PAGE);
},
runContent: () => {
(function (window) {
(() => {
    const W = window;
    if (W.__wtlContent) return;
    W.__wtlContent = true;

    const REQUEST_TIMEOUT_MS = 15000;
    const PAINT_DELAY_MS = 16;
    const REFRESH_DELAY_MS = 150;
    const REFRESH_MAX_WAIT_MS = 500;
    const CALL_LOCK_MS = 600;
    const CALL_FALLBACK_MS = 800;
    const SWEEP_TICKS = 10;
    const BAR_TICKS = 5;
    const FF_RETRY_MS = 60 * 60 * 1000;
    const TORN_WAIT_MS = 15000;
    const PRUNE_LIMIT = 1000;
    const SEL = {
        warList: ".f-war-list",
        rows: 'li[class*="enemy"], li[class*="your"]',
        member: '[class*="member___"]',
        level: '[class*="level___"], .level',
        points: '[class*="points___"], .points',
        status: '[class*="status___"], .status',
        attack: '[class*="attack___"], .attack',
        nameWrap: '.honor-text-wrap, [class*="honorContainer___"], [class*="honorWrap___"]',
        honorWrap: '[class*="honorWrap___"], .honor-text-wrap',
        block: '.members-cont, [class*="membersCont"]',
        header: ".white-grad",
    };

    const pending = new Map();
    let requestId = 0;

    const store = {
        config: null,
        me: null,
        warId: null,
        war: null,
        connected: false,
        lastError: null,
        members: new Map(),
        dibs: new Map(),
        status: new Map(),
        online: new Map(),
        ff: new Map(),
        myDibCount: 0,
        sort: "status",
        sortDir: 1,
        busy: new Map(),
        orderHash: new WeakMap(),
        needsLogin: false,
        assignments: {},
        groups: [],
        assigned: new Map(),
        assignedReady: false,
        stats: { full: 0, rows: 0, refresh: 0, sweeps: 0 },
        requestLock: false,
        requestDelayMs: null,
        manager: null,
    };
    W.__wtl = store;

    function bg(action, payload) {
        return new Promise((resolve, reject) => {
            const id = ++requestId;
            pending.set(id, { resolve, reject });
            W.postMessage({ type: "WTL_REQ", id, action, payload }, "*");
            setTimeout(() => {
                if (!pending.has(id)) return;
                pending.delete(id);
                reject(new Error("bridge timeout"));
            }, REQUEST_TIMEOUT_MS);
        });
    }

    W.addEventListener("message", (event) => {
        if (event.source !== W) return;
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "WTL_RES") {
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            if (msg.response?.ok) entry.resolve(msg.response.data);
            else entry.reject(new Error(msg.response?.error || "request failed"));
            return;
        }
        if (msg.type === "WTL_PUSH") onPush(msg.event, msg.data);
    });

    function onPush(event, data) {
        if (event === "war") { ingestState(data); enhanceAll(); }
        else if (event === "dibs") { ingestDibs(data.dibs); settleCalls(); paintCalls(); }
        else if (event === "member") {
            const id = data.member?.playerId;
            ingestMembers([data.member]);
            if (id != null) {
                schedulePaint(String(id));
                sortSoon();
            }
        } else if (event === "status") {
            store.connected = !!data.connected;
            store.lastError = data.error || null;
            if (data.warId) store.warId = data.warId;
            if ("needsLogin" in data) store.needsLogin = !!data.needsLogin;
            renderBar();
            paintCalls();
        } else if (event === "config") { store.config = data; renderBar(); applyFilter(); }
        else if (event === "requests") {
            if ("lock" in data) store.requestLock = !!data.lock;
            if ("delayMs" in data) store.requestDelayMs = data.delayMs ?? null;
            if (data.manager) store.manager = data.manager;
            renderBar();
        }
        else if (event === "assignments") {
            const fresh = ingestAssignments(data.assignments, data.groups);
            schedulePaint();
            if (fresh.length && store.config?.soundEnabled !== false) beep();
            for (const id of fresh) flash(id);
        }
    }

    function ingestState(data) {
        if (!data) return;
        store.config = data.config || store.config;
        store.me = data.me || store.me;
        store.warId = data.warId ?? store.warId;
        store.war = data.war || store.war;
        store.connected = !!data.connected;
        store.lastError = data.lastError || null;
        if ("needsLogin" in data) store.needsLogin = !!data.needsLogin;
        if ("requestLock" in data) store.requestLock = !!data.requestLock;
        if ("requestDelayMs" in data) store.requestDelayMs = data.requestDelayMs ?? null;
        if (data.manager) store.manager = data.manager;
        if (Array.isArray(data.members)) ingestMembers(data.members);
        if (Array.isArray(data.dibs)) ingestDibs(data.dibs);
        if (data.assignments || data.groups) ingestAssignments(data.assignments, data.groups);
    }

    function assigneeIds(assignees) {
        const ids = new Set();
        for (const entry of Array.isArray(assignees) ? assignees : []) {
            const id = Number(entry?.id);
            if (!Number.isFinite(id)) continue;
            if (id >= 0) {
                ids.add(String(id));
                continue;
            }
            const group = store.groups.find((g) => Number(g?.id) === -id);
            for (const player of group?.war_faction_group_players || []) ids.add(String(player?.player_id));
        }
        return ids;
    }

    function ingestAssignments(assignments, groups) {
        if (assignments && typeof assignments === "object") store.assignments = assignments;
        if (Array.isArray(groups)) store.groups = groups;
        const me = String(store.me?.id ?? "");
        const next = new Map();
        if (me) {
            for (const [targetId, assignees] of Object.entries(store.assignments)) {
                if (Number(targetId) === 0 || !assigneeIds(assignees).has(me)) continue;
                const direct = (assignees || []).find((a) => String(a?.id) === me);
                next.set(String(targetId), Number(direct?.order) || 0);
            }
        }
        const fresh = store.assignedReady ? [...next.keys()].filter((id) => !store.assigned.has(id)) : [];
        store.assigned = next;
        if (me) store.assignedReady = true;
        return fresh;
    }

    function ingestMembers(members) {
        for (const member of members) {
            if (!member?.playerId) continue;
            const id = String(member.playerId);
            store.members.set(id, { ...(store.members.get(id) || {}), ...member });
            const st = member.status;
            if (st?.state) {
                applyStatus(id, { text: st.state, details: st.description || "", until: st.until || null, source: "39th" });
            }
        }
    }

    function ingestDibs(dibs) {
        store.dibs.clear();
        store.myDibCount = 0;
        for (const dib of dibs || []) {
            if (dib.expired) continue;
            const id = String(dib.target_id);
            const list = store.dibs.get(id) || [];
            list.push(dib);
            store.dibs.set(id, list);
            if (String(dib.dibser_id) === String(store.me?.id)) store.myDibCount += 1;
        }
    }

    const SOURCE_RANK = { "39th": 0, bulk: 1, icons: 2, ws: 3 };

    function statusKind(text) {
        if (/hospital/i.test(text)) return "hospital";
        if (/okay/i.test(text)) return "okay";
        if (/travel|abroad/i.test(text)) return "travel";
        if (/jail|federal|fallen/i.test(text)) return "jail";
        return "other";
    }

    function applyStatus(id, next) {
        const prev = store.status.get(id);
        const now = Date.now();
        if (prev) {
            const prevRank = SOURCE_RANK[prev.source] ?? 0;
            const nextRank = SOURCE_RANK[next.source] ?? 0;
            if (nextRank < prevRank && now - prev.ts < 3000) return false;
        }
        const details = next.details || "";
        const until = normalizeUntil(next.until);
        store.status.set(id, { text: next.text, kind: statusKind(next.text), details, until, source: next.source, ts: now });
        return !prev || prev.text !== next.text || prev.details !== details || prev.until !== until;
    }

    function normalizeUntil(until) {
        if (!until) return null;
        const n = Number(until);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n > 9999999999 ? Math.floor(n / 1000) : n;
    }

    W.addEventListener("wtl:torn", (event) => {
        const { kind, data } = event.detail || {};
        const changed = new Set();
        if (kind === "status") {
            const id = String(data.id);
            if (applyStatus(id, { text: data.text, details: data.details, until: data.until, source: "ws" })) changed.add(id);
        } else if (kind === "icons" && data.hospSeconds > 0) {
            const id = String(data.id);
            if (applyStatus(id, { text: "Hospital", until: Math.floor(Date.now() / 1000) + data.hospSeconds, source: "icons" })) changed.add(id);
        } else if (kind === "bulk") {
            for (const s of data.statuses || []) {
                if (applyStatus(String(s.id), { text: s.text, details: s.details, until: s.until, source: "bulk" })) changed.add(String(s.id));
            }
            for (const [id, value] of Object.entries(data.online || {})) {
                if (store.online.get(String(id)) === value) continue;
                store.online.set(String(id), value);
                changed.add(String(id));
            }
        } else if (kind === "socket") {
            renderBar();
        }
        for (const id of changed) schedulePaint(id);
        if (changed.size) sortSoon();
    });

    function drainEarlyQueue() {
        W.__wtlReady = true;
        for (const msg of W.__wtlQueue || []) W.dispatchEvent(new CustomEvent("wtl:torn", { detail: msg }));
        W.__wtlQueue = [];
    }

    function rowId(row) {
        if (row.dataset.wtlId) return row.dataset.wtlId;
        const link = row.querySelector('a[href*="user2ID="], a[href*="XID="]');
        const match = link?.href.match(/(?:user2ID|XID)=(\d+)/);
        if (!match) return null;
        row.dataset.wtlId = match[1];
        return match[1];
    }

    const isEnemyRow = (row) => /enemy/i.test(row.className);

    const PARTS = new WeakMap();

    function partsOf(row) {
        let parts = PARTS.get(row);
        if (!parts) {
            parts = {};
            PARTS.set(row, parts);
        }
        return parts;
    }

    function part(row, key, selector, root = row) {
        const parts = partsOf(row);
        const hit = parts[key];
        if (hit && hit.isConnected && root.contains(hit)) return hit;
        parts[key] = root.querySelector(selector);
        return parts[key];
    }

    function own(row, key) {
        const hit = PARTS.get(row)?.[key];
        return hit && hit.isConnected && row.contains(hit) ? hit : null;
    }

    function remember(row, key, el) {
        partsOf(row)[key] = el;
        return el;
    }

    function child(parent, selector) {
        for (const el of parent.children) {
            if (el.matches(selector)) return el;
        }
        return null;
    }

    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    const BLOCKS = new WeakMap();

    function blockOf(el) {
        const start = el?.parentElement;
        if (!start) return null;
        const known = BLOCKS.get(start);
        if (known?.isConnected && known.contains(start)) return known;
        let node = start;
        while (node && node !== document.body && !child(node, SEL.header)) node = node.parentElement;
        const block = node && node !== document.body ? node : el.closest(SEL.warList);
        if (block) BLOCKS.set(start, block);
        return block || null;
    }

    function memberName(row) {
        const honor = row.querySelector(".honor-text:not(.honor-text-svg)")?.textContent?.trim();
        if (honor) return honor;
        const cell = row.querySelector(SEL.member);
        if (!cell) return "";
        const clone = cell.cloneNode(true);
        clone.querySelectorAll(".wtl-stat, .wtl-meta, .iconStats, [class*='iconStats']").forEach((el) => el.remove());
        return (clone.textContent || "").trim().split("\n")[0].trim();
    }

    const myDibFor = (id) => (store.dibs.get(id) || []).find((d) => String(d.dibser_id) === String(store.me?.id)) || null;

    let audioCtx = null;
    const alerted = new Set();
    const lastLeft = new Map();

    const HOSPITAL_TONES = [990, 1320];
    const CALL_TONES = [880, 660];

    function beep(tones = HOSPITAL_TONES) {
        try {
            audioCtx = audioCtx || new (W.AudioContext || W.webkitAudioContext)();
            const now = audioCtx.currentTime;
            for (let i = 0; i < tones.length; i += 1) {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "square";
                osc.frequency.value = tones[i];
                gain.gain.setValueAtTime(0.0001, now + i * 0.18);
                gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.15);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(now + i * 0.18);
                osc.stop(now + i * 0.18 + 0.16);
            }
        } catch { /* autoplay policy — needs one click on the page first */ }
    }

    function checkHospitalAlerts() {
        if (store.config && store.config.soundEnabled === false) return;
        const lead = Number(store.config?.soundLeadSec ?? 10);
        const nowSec = Math.floor(Date.now() / 1000);

        for (const [targetId, list] of store.dibs) {
            if (!list.some((d) => String(d.dibser_id) === String(store.me?.id))) continue;
            const st = store.status.get(targetId);
            if (!st || !/hospital/i.test(st.text) || !st.until) continue;

            const key = `${targetId}:${st.until}`;
            const left = st.until - nowSec;
            const previous = lastLeft.get(key);
            lastLeft.set(key, left);

            if (previous == null || previous <= lead) continue;
            if (left > lead || left < 0) continue;
            if (alerted.has(key)) continue;

            alerted.add(key);
            const name = store.members.get(targetId)?.name || targetId;
            logAlert({ kind: "hospital", target: name, id: targetId, secondsLeft: left, previous });
            beep(HOSPITAL_TONES);
            flash(targetId);
        }
        if (alerted.size > 200) alerted.clear();
        if (lastLeft.size > 400) lastLeft.clear();
    }

    function logAlert(fields) {
        const entry = { at: new Date().toISOString(), ...fields };
        store.alertLog = [...(store.alertLog || []).slice(-49), entry];
        console.log(`[wtl] ${fields.kind} alert`, entry);
    }

    const callAlerted = new Set();

    function checkCallExpiry() {
        if (store.config?.callAlertEnabled === false) return;
        const ttlSec = Number(store.war?.auto_undibs) || 0;
        const me = String(store.me?.id ?? "");
        if (!ttlSec || !me) return;
        const lead = Number(store.config?.callAlertLeadSec ?? 30);
        const now = Date.now();
        for (const [targetId, list] of store.dibs) {
            const mine = list.find((d) => String(d.dibser_id) === me);
            const calledAt = Date.parse(mine?.dibsed_at);
            if (!Number.isFinite(calledAt)) continue;
            const left = Math.round((calledAt + ttlSec * 1000 - now) / 1000);
            const key = `${targetId}:${mine.dibsed_at}`;
            if (left <= 0 || left > lead || callAlerted.has(key)) continue;
            callAlerted.add(key);
            logAlert({ kind: "call", target: mine.target_name || store.members.get(targetId)?.name || targetId, id: targetId, secondsLeft: left });
            beep(CALL_TONES);
            flash(targetId);
        }
        if (callAlerted.size > 200) callAlerted.clear();
    }

    function fmtCountdown(seconds) {
        const pad = (n) => String(n).padStart(2, "0");
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
    }

    const STAT_UNITS = [["b", 1e9], ["m", 1e6], ["k", 1e3]];

    function abbreviate(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return "";
        for (const [unit, size] of STAT_UNITS) {
            if (n < size) continue;
            const scaled = n / size;
            const digits = scaled >= 100 ? 0 : scaled >= 10 || unit !== "b" ? 1 : 2;
            return `${scaled.toFixed(digits)}${unit}`;
        }
        return String(Math.round(n));
    }

    const STAT_TIERS = ["danger", "hard", "even", "good", "easy"];
    const RATIO_STEPS = [5, 2, 0.75, 0.25, 0.05];
    const TOTAL_STEPS = [1e10, 2e9, 5e8, 1e8, 1e7];

    function statTier(targetBs, viewerBs) {
        if (targetBs == null) return "wtl-stat-tiny";
        const value = viewerBs ? targetBs / viewerBs : targetBs;
        const index = (viewerBs ? RATIO_STEPS : TOTAL_STEPS).findIndex((step) => value >= step);
        return `wtl-stat-${index === -1 ? "tiny" : STAT_TIERS[index]}`;
    }

    const viewerBs = () => store.ff.get(String(store.me?.id))?.bsEstimate ?? null;

    function statusView(id) {
        const st = store.status.get(id);
        if (!st) return null;
        if (st.kind === "hospital" && st.until) {
            const secs = st.until - Math.floor(Date.now() / 1000);
            if (secs <= 0) return { label: "0:00", cls: "wtl-out", timer: true };
            return { label: fmtCountdown(secs), cls: secs <= 60 ? "wtl-soon" : "wtl-hosp", timer: true };
        }
        if (st.kind === "okay") return { label: "Okay", cls: "wtl-okay", timer: false };
        if (st.kind === "travel") return { label: st.text, cls: "wtl-travel", timer: false };
        return { label: st.text, cls: "wtl-other", timer: false };
    }

    const FILL = { flex: "1 1 0px", width: "0px", "min-width": "0px" };
    const HALF = { width: "calc(50% - 4px)", "max-width": "calc(50% - 4px)", "box-sizing": "border-box" };
    const FULL = { width: "100%", "max-width": "100%", "box-sizing": "border-box" };
    const TAB_CONT = ".tab-menu-cont, [class*=\"tabMenuCont\"]";
    const NARROW_PX = 360;

    function listsSideBySide(cont) {
        let shown = 0;
        for (const el of cont.parentElement.children) {
            if (el.matches(TAB_CONT) && getComputedStyle(el).display !== "none") shown += 1;
        }
        return shown > 1;
    }

    function pin(el, props) {
        if (!el) return;
        for (const [name, value] of Object.entries(props)) {
            if (el.style.getPropertyValue(name) === value && el.style.getPropertyPriority(name) === "important") continue;
            el.style.setProperty(name, value, "important");
        }
    }

    const ROW_BOX = { "padding-bottom": "2px", width: "100%", "max-width": "100%", "box-sizing": "border-box", "margin-left": "0px", "margin-right": "0px" };
    const MEMBER_CELL = ".member, " + SEL.member;
    const LAID_OUT = new WeakSet();

    function layoutRow(row, force = false) {
        let fresh = force || !LAID_OUT.has(row) || row.style.getPropertyPriority("max-width") !== "important";
        for (const cell of row.children) {
            if (fresh) break;
            fresh = !LAID_OUT.has(cell);
        }
        if (!fresh) return;
        if (row.style.display !== "flex") row.style.display = "flex";
        if (row.style.alignItems !== "center") row.style.alignItems = "center";
        pin(row, ROW_BOX);
        for (const cell of row.children) {
            LAID_OUT.add(cell);
            if (cell.matches(".tt-stats-estimate")) pin(cell, { display: "none" });
            if (cell.tagName !== "DIV" || cell.classList.contains("clear")) continue;
            if (cell.matches(MEMBER_CELL)) pin(cell, FILL);
            const margin = cell.classList.contains("ffscouter-cell") ? "3px" : "0px";
            pin(cell, { "margin-left": margin, "margin-right": margin });
        }
        LAID_OUT.add(row);
    }

    function fmtLastAction(timestamp) {
        if (!timestamp) return "";
        const secs = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp));
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m`;
        if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
        return `${Math.floor(secs / 86400)}d`;
    }

    function ensureLevelIndicator(row, id) {
        const wrap = part(row, "honor", SEL.honorWrap);
        if (!wrap) return;
        wrap.classList.toggle("wtl-name-stack", true);
        const level = (part(row, "level", SEL.level)?.textContent || "").trim() || store.members.get(id)?.level;
        if (!level) return;

        let indicator = own(row, "meta");
        if (!indicator) {
            indicator = remember(row, "meta", document.createElement("span"));
            indicator.className = "wtl-meta";
            indicator.style.cssText = "font-size:10px!important;line-height:1.2!important;text-decoration:none!important;border:none!important;display:flex!important;align-items:center!important;gap:4px!important;background:none!important;white-space:nowrap!important;";
            wrap.appendChild(indicator);
        }
        const revive = store.members.get(id)?.reviveson;
        const label = `Lvl ${level}`;
        if (indicator.firstChild?.textContent !== label) {
            indicator.textContent = label;
        }
        let icon = indicator.querySelector(".wtl-revive");
        if (revive && !icon) {
            icon = document.createElement("span");
            icon.className = "wtl-revive";
            icon.textContent = "✚";
            icon.title = "Revives on";
            indicator.appendChild(icon);
        } else if (!revive && icon) {
            icon.remove();
        }
    }

    function ensureAssignedTag(row, order) {
        let tag = own(row, "tag");
        if (order == null) {
            tag?.remove();
            return;
        }
        const parent = own(row, "meta") || part(row, "honor", SEL.honorWrap);
        if (!parent) return;
        if (!tag || tag.parentElement !== parent) {
            tag?.remove();
            tag = remember(row, "tag", document.createElement("span"));
            tag.className = "wtl-assigned-tag";
            parent.appendChild(tag);
        }
        const label = order > 0 ? `assigned #${order}` : "assigned";
        if (tag.textContent !== label) {
            const word = document.createElement("span");
            word.className = "wtl-assigned-word";
            word.textContent = order > 0 ? "assigned " : "assigned";
            tag.replaceChildren(word);
            if (order > 0) tag.append(`#${order}`);
        }
        tag.classList.toggle("wtl-has-order", order > 0);
    }

    function paintSeen(row, id) {
        const cell = own(row, "seen");
        if (cell) setText(cell, fmtLastAction(store.members.get(id)?.last_action?.timestamp));
    }

    function ensureLastActionCell(row, id) {
        let cell = own(row, "seen");
        if (!cell) {
            cell = remember(row, "seen", document.createElement("div"));
            cell.className = "wtl-la-col left";
        }
        const clear = part(row, "clear", ":scope > .clear");
        if (clear && cell.nextElementSibling !== clear) row.insertBefore(cell, clear);
        else if (!clear && cell.parentElement !== row) row.appendChild(cell);
        paintSeen(row, id);
    }

    function ensureLastActionHeader(block) {
        const header = block.querySelector(":scope > " + SEL.header);
        if (!header || header.querySelector(".wtl-la-header")) return;
        const cell = document.createElement("div");
        cell.className = "wtl-la-header left";
        cell.style.cssText = "position:absolute;right:0;top:0;bottom:0;margin-top:2px;display:flex;align-items:center;padding:0 6px;white-space:nowrap;cursor:pointer;";
        cell.textContent = "Seen";
        cell.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSort("lastAction", store.sort === "lastAction" ? -store.sortDir : 1);
        });
        header.style.position = "relative";
        header.appendChild(cell);
    }

    function ensureStatsColumn(row) {
        const existing = own(row, "stat");
        if (existing) return existing;

        const block = blockOf(row);
        const scope = block && (child(block, SEL.header) || block);
        if (!scope?.querySelector(".wtl-stat-head")) return null;

        const anchor = part(row, "level", SEL.level) || part(row, "points", SEL.points);
        if (!anchor) return null;

        const column = remember(row, "stat", document.createElement("div"));
        column.className = "wtl-stat left";
        const value = remember(row, "statValue", document.createElement("span"));
        value.className = "wtl-stat-value wtl-stat-wait";
        value.textContent = "-";
        column.appendChild(value);
        if (anchor.matches(SEL.points)) anchor.parentNode.insertBefore(column, anchor);
        else anchor.parentNode.insertBefore(column, anchor.nextSibling);
        return column;
    }

    function ensureScouterHeader(header) {
        let cell = header.querySelector(":scope > .wtl-ffs-header");
        if (header.querySelector(":scope > .ffscouter-header")) {
            cell?.remove();
            return;
        }
        const score = header.querySelector('[class*="points___"], .points');
        if (!score) return;
        if (!cell) {
            cell = document.createElement("div");
            cell.className = "wtl-ffs-header left";
            score.parentNode.insertBefore(cell, score);
        }
        const label = document.querySelector(".ffscouter-header")?.textContent.trim() || "FF";
        if (cell.textContent !== label) cell.textContent = label;
    }

    function ensureStatsHeader(block) {
        const header = block.querySelector(":scope > " + SEL.header);
        if (!header) return;
        if (block.querySelector("li > .ffscouter-cell")) {
            header.querySelector(":scope > .wtl-stat-head")?.remove();
            ensureScouterHeader(header);
            return;
        }
        header.querySelector(":scope > .wtl-ffs-header")?.remove();
        if (header.querySelector(".wtl-stat-head")) return;

        const levelHeader = header.querySelector('[class*="level___"]')
            || header.querySelector('[class*="points___"]')
            || [...header.querySelectorAll("*")].find((el) => /^(Level|Score)$/.test(el.textContent?.trim() || "") && !el.children.length);
        if (!levelHeader) return;
        const beforeScore = !levelHeader.className.includes("level");

        const cell = document.createElement("div");
        cell.className = "wtl-stat-head left";
        const inherited = (levelHeader.className || "").split(" ").filter((c) => c && !c.includes("level") && !c.includes("points") && c !== "left");
        if (inherited.length) cell.className += " " + inherited.join(" ");
        cell.textContent = "Stats";
        cell.title = "FFScouter battle-stat estimate — click to sort";
        cell.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSort(store.sort === "stats" ? "stats" : "stats", store.sort === "stats" ? -store.sortDir : -1);
        });
        if (beforeScore) levelHeader.parentNode.insertBefore(cell, levelHeader);
        else levelHeader.parentNode.insertBefore(cell, levelHeader.nextSibling);
    }

    function ensureStatusHeaderSort(block) {
        const header = block.querySelector(":scope > " + SEL.header);
        if (!header) return;
        const cell = header.querySelector('[class*="status___"]')
            || [...header.querySelectorAll("*")].find((el) => el.textContent?.trim() === "Status" && !el.children.length);
        if (!cell || cell.dataset.wtlSortable) return;
        cell.dataset.wtlSortable = "1";
        cell.style.cursor = "pointer";
        cell.title = "Sort by status / hospital time";
        cell.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSort("status", store.sort === "status" ? -store.sortDir : 1);
        });
    }

    function ensureCallButton(row, id) {
        const existing = own(row, "call");
        if (existing) return existing;
        const container = part(row, "attack", SEL.attack);
        if (!container) return null;
        const button = remember(row, "call", document.createElement("button"));
        button.type = "button";
        button.className = "wtl-call";
        button.dataset.wtlCall = id;
        container.insertBefore(button, container.firstChild);
        return button;
    }

    function ensureAttackLink(row, id) {
        const container = part(row, "attack", SEL.attack);
        if (!container) return;

        const native = part(row, "native", 'a[href*="user2ID="]:not(.wtl-attack)', container);
        if (native) native.classList.toggle("wtl-native-attack", true);

        const href = `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
        container.classList.toggle("wtl-attack-cell", true);

        let link = own(row, "attackLink");
        if (!link) {
            link = remember(row, "attackLink", document.createElement("a"));
            link.className = "wtl-attack";
            link.innerHTML = ICON_TARGET;
            link.setAttribute("aria-label", "Attack");
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            container.appendChild(link);
        }
        if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    }

    function onlineFromRow(row) {
        const label = part(row, "online", '[class*="userStatusWrap"]')?.getAttribute("aria-label") || "";
        return label.match(/ is (online|offline|idle)$/i)?.[1] || null;
    }

    function ffFromRow(row) {
        const bs = Number(row.dataset.estValue);
        if (!Number.isFinite(bs) || bs <= 0) return null;
        const fair = Number(row.dataset.ffValue);
        return { bsEstimate: bs, bsHuman: abbreviate(bs), fairFight: Number.isFinite(fair) && fair > 0 ? fair : null };
    }

    function paintOnline(row, id) {
        const value = onlineFromRow(row) || store.online.get(id);
        if (!value) return;
        const wrap = part(row, "honor", SEL.honorWrap);
        if (!wrap) return;
        const normalized = /online/i.test(value) ? "online" : /idle/i.test(value) ? "idle" : "offline";
        if (wrap.dataset.wtlOnline !== normalized) wrap.dataset.wtlOnline = normalized;
    }

    const STATUS_CLASSES = ["wtl-okay", "wtl-out", "wtl-soon", "wtl-hosp", "wtl-travel", "wtl-other"];

    function paintStatus(row, id) {
        const view = statusView(id);
        const cell = view && part(row, "status", SEL.status);
        if (!cell) return;
        let timer = own(row, "timer");
        if (view.timer && !timer) {
            timer = remember(row, "timer", document.createElement("span"));
            timer.className = "wtl-timer";
            cell.appendChild(timer);
        }
        if (timer) setText(timer, view.timer ? view.label : "");
        cell.classList.toggle("wtl-has-timer", view.timer);
        for (const cls of STATUS_CLASSES) cell.classList.toggle(cls, cls === view.cls);
    }

    function paintStats(row, id) {
        if (!store.ff.has(id)) {
            const fromRow = ffFromRow(row);
            if (fromRow) store.ff.set(id, fromRow);
        }
        if (child(row, ".ffscouter-cell")) {
            own(row, "stat")?.remove();
            return;
        }
        const span = ensureStatsColumn(row) && own(row, "statValue");
        if (!span) return;
        const ff = store.ff.get(id);
        const member = store.members.get(id);
        const value = abbreviate(ff?.bsEstimate) || ff?.bsHuman || abbreviate(member?.spy?.total) || "-";
        const raw = ff?.bsEstimate ?? member?.spy?.total ?? null;
        setText(span, value);
        const cls = `wtl-stat-value ${value === "-" ? "wtl-stat-wait" : statTier(raw, viewerBs())}`;
        if (span.className !== cls) span.className = cls;
        const tip = ff?.fairFight != null ? `FF: ${Number(ff.fairFight).toFixed(2)}` : "";
        if (span.getAttribute("title") !== tip) span.setAttribute("title", tip);
    }

    const TIPS = new WeakMap();

    function callTip(dibs) {
        if (!dibs.length) return "Call this target on 39th";
        let tip = TIPS.get(dibs);
        if (tip === undefined) {
            tip = dibs.map((d) => `${d.dibser_name} @ ${new Date(d.dibsed_at).toLocaleTimeString()}`).join(" · ");
            TIPS.set(dibs, tip);
        }
        return tip;
    }

    function myCallLabel(mine) {
        const ttlSec = Number(store.war?.auto_undibs) || 0;
        const calledAt = Date.parse(mine?.dibsed_at);
        if (!ttlSec || !Number.isFinite(calledAt)) return "You";
        return `${Math.max(0, Math.ceil((calledAt + ttlSec * 1000 - Date.now()) / 1000))}s`;
    }

    function paintCall(row, id) {
        const button = ensureCallButton(row, id);
        if (!button) return;
        const dibs = store.dibs.get(id) || [];
        const mine = myDibFor(id);
        const other = dibs.find((d) => String(d.dibser_id) !== String(store.me?.id)) || null;
        const full = dibs.length >= (store.war?.max_dibs ?? 1) && !mine;
        const perPerson = store.war?.max_dibs_one_person ?? 1;
        const locked = !mine && !full && perPerson > 0 && store.myDibCount >= perPerson;
        const call = store.busy.get(id);
        const waiting = !!call && !call.done;
        setText(button, waiting ? "…" : mine ? myCallLabel(mine) : other ? String(other.dibser_name) : "Call");
        const override = full ? "1" : "0";
        if (button.dataset.override !== override) button.dataset.override = override;
        const cls = `wtl-call${mine ? " wtl-call-mine" : ""}${full ? " wtl-call-taken" : ""}${locked ? " wtl-call-locked" : ""}`;
        if (button.className !== cls) button.className = cls;
        if (button.hasAttribute("title")) button.removeAttribute("title");
        const tip = callTip(dibs);
        if (button.dataset.tooltip !== tip) button.dataset.tooltip = tip;
        const disabled = !store.connected || waiting || locked;
        if (button.disabled !== disabled) button.disabled = disabled;
    }

    function paintOne(row, id, relayout = false) {
        store.stats.rows += 1;
        paintOnline(row, id);
        ensureLevelIndicator(row, id);
        const order = store.assigned.get(id);
        row.classList.toggle("wtl-assigned", order !== undefined);
        ensureAssignedTag(row, order);
        paintStatus(row, id);
        ensureLastActionCell(row, id);
        paintStats(row, id);
        row.classList.toggle("wtl-hidden", filteredOut(id));
        if (isEnemyRow(row)) {
            ensureAttackLink(row, id);
            paintCall(row, id);
        }
        layoutRow(row, relayout);
    }

    function paintCalls() {
        eachRow((row, id) => {
            if (isEnemyRow(row)) paintCall(row, id);
        });
    }

    function flash(id) {
        for (const row of rowsOf(id)) {
            row.classList.add("wtl-flash");
            setTimeout(() => row.classList.remove("wtl-flash"), 1500);
        }
    }

    function paintRow(id) {
        for (const row of rowsOf(id)) paintOne(row, id);
    }

    const registry = { list: [], byId: new Map(), stale: true };

    function scanRows() {
        const list = [];
        const byId = new Map();
        for (const warList of document.querySelectorAll(SEL.warList)) {
            for (const row of warList.querySelectorAll(SEL.rows)) {
                const id = rowId(row);
                if (!id) continue;
                list.push({ row, id });
                if (byId.has(id)) byId.get(id).push(row);
                else byId.set(id, [row]);
            }
        }
        registry.list = list;
        registry.byId = byId;
        registry.stale = false;
    }

    function eachRow(fn) {
        if (registry.stale) scanRows();
        let lost = false;
        for (const { row, id } of registry.list) {
            if (row.isConnected) fn(row, id);
            else lost = true;
        }
        if (lost) scheduleRefresh();
    }

    function rowsOf(id) {
        if (registry.stale) scanRows();
        return (registry.byId.get(id) || []).filter((row) => row.isConnected);
    }

    function sortKey(id) {
        if (store.sort === "stats") {
            const ff = store.ff.get(id);
            return -(ff?.bsEstimate || store.members.get(id)?.spy?.total || 0);
        }
        if (store.sort === "ff") return store.ff.get(id)?.fairFight ?? 1e9;
        if (store.sort === "level") return -(store.members.get(id)?.level || 0);
        if (store.sort === "lastAction") return -(store.members.get(id)?.last_action?.timestamp || 0);

        const st = store.status.get(id);
        if (!st) return 3e6;
        if (st.kind === "hospital") {
            if (!st.until) return 1e5;
            const secs = st.until - Math.floor(Date.now() / 1000);
            return secs <= 0 ? 1 : secs;
        }
        return STATUS_RANK[st.kind] ?? 3e6;
    }

    const STATUS_RANK = { okay: 0, travel: 1e6, jail: 2e6, other: 3e6 };
    const PRESS_QUIET_MS = 300;
    const PRESS_MAX_MS = 10000;
    const AIM_QUIET_MS = 300;
    let pressQuietUntil = 0;
    let aimQuietUntil = 0;
    let aimList = null;
    let sortRetryTimer = null;

    function retrySortIn(ms) {
        clearTimeout(sortRetryTimer);
        sortRetryTimer = setTimeout(() => {
            sortRetryTimer = null;
            applySort();
        }, ms);
    }

    document.addEventListener("pointerdown", () => {
        pressQuietUntil = Date.now() + PRESS_MAX_MS;
    }, true);
    for (const type of ["pointerup", "pointercancel"]) {
        document.addEventListener(type, () => {
            pressQuietUntil = Date.now() + PRESS_QUIET_MS;
            if (sortRetryTimer) retrySortIn(PRESS_QUIET_MS + 20);
        }, true);
    }
    document.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "mouse") return;
        aimList = event.target.closest?.(SEL.warList) || null;
        if (aimList) aimQuietUntil = Date.now() + AIM_QUIET_MS;
    }, { capture: true, passive: true });

    function sortPauseLeft(parent, now) {
        const aim = aimList?.contains(parent) ? aimQuietUntil - now : 0;
        return Math.max(pressQuietUntil - now, aim, 0);
    }

    function applyRowOrder(parent, rows) {
        if (!parent.dataset.wtlFlex) {
            parent.style.display = "flex";
            parent.style.flexDirection = "column";
            parent.dataset.wtlFlex = "1";
        }
        rows.forEach((row, index) => {
            const value = String(index);
            if (row.style.order !== value) row.style.order = value;
        });
    }

    function applySort(force = false) {
        const now = Date.now();
        let retryIn = 0;
        const parents = new Map();
        eachRow((row, id) => {
            const parent = row.parentElement;
            if (!parent) return;
            let entries = parents.get(parent);
            if (!entries) parents.set(parent, (entries = []));
            entries.push({ row, id, index: entries.length, key: 0 });
        });

        for (const [parent, entries] of parents) {
            if (entries.length < 2) continue;
            const pause = force ? 0 : sortPauseLeft(parent, now);
            if (pause > 0) {
                retryIn = Math.max(retryIn, pause);
                continue;
            }
            if (store.sort === "none") {
                for (const entry of entries) if (entry.row.style.order) entry.row.style.removeProperty("order");
                continue;
            }
            for (const entry of entries) entry.key = sortKey(entry.id);
            entries.sort((a, b) => (a.key - b.key) * store.sortDir || a.index - b.index);
            const hash = entries.map((e) => e.id).join(",");
            if (store.orderHash.get(parent) === hash) continue;
            store.orderHash.set(parent, hash);
            applyRowOrder(parent, entries.map((e) => e.row));
        }
        if (retryIn > 0) retrySortIn(retryIn + 20);
    }

    function parseStat(text) {
        const raw = String(text ?? "").trim().toLowerCase().replace(/[, ]/g, "");
        if (!raw) return null;
        const match = raw.match(/^([\d.]+)\s*([kmb])?$/);
        if (!match) return null;
        const value = parseFloat(match[1]);
        if (!Number.isFinite(value)) return null;
        const factor = match[2] === "b" ? 1e9 : match[2] === "m" ? 1e6 : match[2] === "k" ? 1e3 : 1;
        return value * factor;
    }

    function statOf(id) {
        const ff = store.ff.get(id);
        return ff?.bsEstimate ?? store.members.get(id)?.spy?.total ?? null;
    }

    function parseFF(text) {
        const raw = String(text ?? "").trim().replace(",", ".");
        if (!raw) return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    const ffOf = (id) => store.ff.get(id)?.fairFight ?? null;

    function parseIds(text) {
        const ids = String(text ?? "").match(/\b\d+\b/g);
        return ids ? new Set(ids) : null;
    }

    function outOfRange(value, min, max) {
        if (value == null) return false;
        return (min != null && value < min) || (max != null && value > max);
    }

    let filterMemo = { config: null, key: null, rules: null };

    function filterRules() {
        const config = store.config || {};
        if (filterMemo.config === config) return filterMemo.rules;
        const key = JSON.stringify([config.statMin, config.statMax, config.ffMin, config.ffMax, config.idFilter]);
        if (filterMemo.key !== key) {
            filterMemo.rules = {
                statMin: parseStat(config.statMin),
                statMax: parseStat(config.statMax),
                ffMin: parseFF(config.ffMin),
                ffMax: parseFF(config.ffMax),
                ids: parseIds(config.idFilter),
            };
            filterMemo.key = key;
        }
        filterMemo.config = config;
        return filterMemo.rules;
    }

    function filteredOut(id) {
        const rules = filterRules();
        return (rules.ids != null && !rules.ids.has(id))
            || outOfRange(statOf(id), rules.statMin, rules.statMax)
            || outOfRange(ffOf(id), rules.ffMin, rules.ffMax);
    }

    function applyFilter() {
        eachRow((row, id) => row.classList.toggle("wtl-hidden", filteredOut(id)));
    }

    function setSort(mode, dir) {
        store.sort = mode;
        store.sortDir = dir || 1;
        store.orderHash = new WeakMap();
        applySort(true);
        paintSortHeads();
        renderBar();
    }

    function paintSortHeads() {
        const ascending = store.sort === "stats" ? store.sortDir === -1 : store.sortDir === 1;
        for (const header of document.querySelectorAll(`${SEL.warList} ${SEL.header}`)) {
            header.classList.toggle("wtl-sorted", store.sort !== "none");
            const heads = [
                [["stats", "ff"], header.querySelector(":scope > .wtl-stat-head, :scope > .ffscouter-header, :scope > .wtl-ffs-header")],
                [["status"], header.querySelector(":scope > [data-wtl-sortable]")],
                [["lastAction"], header.querySelector(":scope > .wtl-la-header")],
            ];
            for (const [modes, cell] of heads) {
                if (!cell) continue;
                const dir = modes.includes(store.sort) ? (ascending ? "asc" : "desc") : "";
                let arrow = cell.querySelector(":scope > .wtl-sort-arrow");
                if (!dir) {
                    arrow?.remove();
                    if (cell.dataset.wtlSort) delete cell.dataset.wtlSort;
                    continue;
                }
                if (!arrow) {
                    arrow = document.createElement("span");
                    arrow.className = "wtl-sort-arrow";
                    cell.appendChild(arrow);
                }
                if (arrow.dataset.dir !== dir) arrow.dataset.dir = dir;
                if (cell.dataset.wtlSort !== dir) cell.dataset.wtlSort = dir;
            }
        }
    }

    function scouterSortMode(cell) {
        const display = cell.closest(".faction-war")?.getAttribute("data-ffscouter-col-display");
        if (display) return display === "fair_fight" ? "ff" : "stats";
        return /^ff\b/i.test(cell.textContent.trim()) ? "ff" : "stats";
    }

    function onScouterHeaderPress(event) {
        const cell = event.target.closest?.(".ffscouter-header, .wtl-ffs-header");
        if (!cell || !cell.closest(SEL.warList)) return;
        event.preventDefault();
        event.stopPropagation();
        const mode = scouterSortMode(cell);
        setSort(mode, store.sort === mode ? -store.sortDir : mode === "stats" ? -1 : 1);
    }

    document.addEventListener("click", onScouterHeaderPress, true);

    function ensureHooks() {
        for (const list of document.querySelectorAll(SEL.warList)) list.classList.toggle("wtl-scope", true);
        const blocks = new Set();
        for (const header of document.querySelectorAll(`${SEL.warList} ${SEL.header}`)) {
            if (header.parentElement) blocks.add(header.parentElement);
        }
        const fits = [];
        for (const block of blocks) {
            if (!block.querySelector(SEL.rows)) continue;
            const cont = block.parentElement;
            if (!cont?.matches(TAB_CONT)) {
                fits.push({ block, cont: null });
                continue;
            }
            const sideBySide = listsSideBySide(cont);
            const room = cont.parentElement.clientWidth / (sideBySide ? 2 : 1);
            fits.push({ block, cont, sideBySide, narrow: room > 0 && room < NARROW_PX });
        }
        for (const { block, cont, sideBySide, narrow } of fits) {
            block.classList.toggle("wtl-scope", true);
            if (cont) {
                pin(cont, sideBySide ? HALF : FULL);
                block.classList.toggle("wtl-narrow", narrow);
            }
            pin(block, { width: "100%", "box-sizing": "border-box" });
            pin(block.querySelector(":scope > " + SEL.header + " > .member"), FILL);
            ensureStatsHeader(block);
            ensureStatusHeaderSort(block);
            ensureLastActionHeader(block);
            releaseOnNativeSort(block);
        }
        paintSortHeads();
    }

    function releaseOnNativeSort(block) {
        const header = block.querySelector(":scope > " + SEL.header);
        if (!header || header.dataset.wtlRelease) return;
        header.dataset.wtlRelease = "1";
        header.addEventListener("click", (event) => {
            const cell = event.target.closest("div");
            if (!cell || cell.matches(".wtl-stat-head, .wtl-la-header, .wtl-ffs-header, .ffscouter-header")) return;
            if (cell.dataset.wtlSortable) return;
            setSort("none", 1);
        }, true);
    }

    function enhanceAll() {
        ensureHooks();
        registry.stale = true;
        paintAll();
        applySort();
        renderBar();
        if (ffCoverageGap() > 0) scheduleFFRefresh();
    }

    function paintAll() {
        store.stats.full += 1;
        eachRow((row, id) => paintOne(row, id));
    }

    const dirtyRows = new Set();
    let dirtyAll = false;
    let sortDirty = false;
    let paintTimer = null;

    function schedulePaint(id) {
        if (id == null) dirtyAll = true;
        else dirtyRows.add(String(id));
        if (!paintTimer) paintTimer = setTimeout(flushPaint, PAINT_DELAY_MS);
    }

    function sortSoon() {
        sortDirty = true;
        if (!paintTimer) paintTimer = setTimeout(flushPaint, PAINT_DELAY_MS);
    }

    function flushPaint() {
        paintTimer = null;
        if (dirtyAll) {
            dirtyAll = false;
            dirtyRows.clear();
            paintAll();
        } else {
            const ids = [...dirtyRows];
            dirtyRows.clear();
            for (const id of ids) paintRow(id);
        }
        if (!sortDirty) return;
        sortDirty = false;
        applySort();
    }

    let refreshTimer = null;
    let refreshDeadline = 0;

    function scheduleRefresh() {
        registry.stale = true;
        const now = Date.now();
        if (!refreshDeadline) refreshDeadline = now + REFRESH_MAX_WAIT_MS;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, Math.max(0, Math.min(REFRESH_DELAY_MS, refreshDeadline - now)));
    }

    function refresh() {
        refreshTimer = null;
        refreshDeadline = 0;
        store.stats.refresh += 1;
        ensureHooks();
        paintAll();
        applySort();
        renderBar();
        if (ffCoverageGap() > 0) scheduleFFRefresh();
    }

    const FILTER_FIELDS = [["min", "statMin"], ["max", "statMax"], ["ffmin", "ffMin"], ["ffmax", "ffMax"], ["ids", "idFilter"]];
    const ICON_TARGET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/></svg>';
    const ICON_SLIDERS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h6.5M12.5 4.5H14M2 11.5h1.5M7.5 11.5H14"/><circle cx="10.5" cy="4.5" r="2"/><circle cx="5.5" cy="11.5" r="2"/></svg>';
    const BAR_HTML = `
        <div class="wtl-head">
            <span class="wtl-brand">${ICON_TARGET}War Target List</span>
            <span class="wtl-badge" data-wtl="conn"></span>
            <span class="wtl-badge" data-wtl="torn"></span>
            <span class="wtl-badge wtl-warn" data-wtl="lock" hidden>Calls slow</span>
            <button type="button" class="wtl-mini wtl-gear" data-wtl="toggle">${ICON_SLIDERS}Settings</button>
        </div>
        <div class="wtl-filters">
            <span class="wtl-group"><span class="wtl-label">Stats</span><input type="text" data-wtl="min" placeholder="min" size="4"><span class="wtl-dash">–</span><input type="text" data-wtl="max" placeholder="max" size="4"></span>
            <span class="wtl-group"><span class="wtl-label">FF</span><input type="text" data-wtl="ffmin" placeholder="min" size="3"><span class="wtl-dash">–</span><input type="text" data-wtl="ffmax" placeholder="max" size="3"></span>
            <span class="wtl-group"><span class="wtl-label">IDs</span><input type="text" autocomplete="off" spellcheck="false" data-wtl="ids" placeholder="id, id, …" size="12"></span>
        </div>
        <div class="wtl-err" data-wtl="err"></div>
        <div class="wtl-notice" data-wtl="notice" hidden>
            <span data-wtl="noticetext"></span>
            <a class="wtl-link" data-wtl="noticelink" target="_blank" rel="noopener noreferrer" hidden></a>
            <button type="button" class="wtl-mini" data-wtl="noticehide">Hide</button>
        </div>
        <div class="wtl-panel" data-wtl="panel" hidden>
            <div class="wtl-section">Connection</div>
            <div class="wtl-field" data-wtl="keyrow" hidden>
                <span class="wtl-label">Torn API key</span>
                <span class="wtl-control"><input type="password" data-wtl="apikey" autocomplete="off" spellcheck="false" size="22"><button type="button" class="wtl-mini wtl-primary" data-wtl="login">Log in</button></span>
                <span class="wtl-hint">Public access is enough. It is used only to log in to 39th.</span>
            </div>
            <div class="wtl-field">
                <span class="wtl-label">War id</span>
                <span class="wtl-control"><input type="text" inputmode="numeric" data-wtl="warid" size="11"><button type="button" class="wtl-mini" data-wtl="reconnect">Reconnect</button></span>
                <span class="wtl-hint">Leave empty to find the war automatically.</span>
            </div>
            <div class="wtl-section">Calls</div>
            <div class="wtl-field">
                <span class="wtl-label">Call expiry</span>
                <span class="wtl-control"><input type="checkbox" class="wtl-switch" data-wtl="callalert"><input type="text" inputmode="numeric" data-wtl="calllead" size="3">s before</span>
                <span class="wtl-hint">Beeps before 39th drops your call, so you can call again: tap your countdown, then Call.</span>
            </div>
            <div class="wtl-field">
                <span class="wtl-label">Alert</span>
                <span class="wtl-control"><input type="checkbox" class="wtl-switch" data-wtl="sound"><input type="text" inputmode="numeric" data-wtl="lead" size="3">s before</span>
                <span class="wtl-hint">Beeps before a target you called leaves hospital, and when you get a new assigned target.</span>
            </div>
            <div class="wtl-section">Stats</div>
            <div class="wtl-field">
                <span class="wtl-label">FFScouter key</span>
                <span class="wtl-control"><input type="password" data-wtl="ffkey" autocomplete="off" spellcheck="false" size="18"></span>
                <span class="wtl-hint">Not needed when FF Scouter V2 is installed.</span>
            </div>
            <div class="wtl-saved" data-wtl="saved"></div>
        </div>`;

    const panelState = { open: false, auto: false, message: "", timer: null };
    const CLASHING_SCRIPTS = [
        { id: "39x", name: "39X: Faction War Page", short: "39X", selector: ".finally-bs-api, .finally-bs-col, .finally-focus-row" },
    ];
    const hiddenNotices = new Set();
    const TORN_BADGE = {
        live: ["Torn live", "wtl-on"],
        reconnecting: ["Torn reconnecting", "wtl-warn"],
        waiting: ["Torn …", ""],
        missing: ["Torn not live", "wtl-warn"],
    };
    const TORN_HINT = "Torn live status is off, so status changes can come up to 30 s late. In Torn PDA, set this script's injection time to Start, then reload the page.";

    const MOVE_GUIDE = { href: "https://github.com/eugene-torn-scripts/war-target-list-userscript#faster-calls-on-a-computer", label: "How to move" };

    function violentmonkeyFits() {
        return !/^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(W.navigator?.userAgent || "");
    }

    function lockHint() {
        const manager = store.manager || "Your userscript manager";
        const fix = violentmonkeyFits() ? "Move this script to Violentmonkey"
            : /^tampermonkey/i.test(manager) ? "Update Tampermonkey to 5.3.2 or later" : "Use Tampermonkey 5.3.2 or later";
        return `${manager} sends one request at a time, so your calls can wait up to 25 s. ${fix}, then reload the page.`;
    }

    function speedHint() {
        const ms = Math.max(10, Math.round(store.requestDelayMs / 10) * 10);
        return `Tampermonkey makes each call about ${ms} ms slower. In Violentmonkey, calls go out at once.`;
    }

    function speedNoticeDue() {
        return store.requestDelayMs > 0 && /^tampermonkey/i.test(store.manager || "") && violentmonkeyFits() && !noticeHidden("speed");
    }

    function tornState() {
        const torn = W.__wtlTornSocket;
        if (torn?.open > 0) return "live";
        if (torn?.hooked > 0) return "reconnecting";
        return performance.now() < TORN_WAIT_MS ? "waiting" : "missing";
    }

    function noticeHidden(id) {
        if (hiddenNotices.has(id)) return true;
        try {
            return localStorage.getItem(`wtl:hide-notice:${id}`) === "1";
        } catch {
            return false;
        }
    }

    function hideNotice(id) {
        hiddenNotices.add(id);
        try {
            localStorage.setItem(`wtl:hide-notice:${id}`, "1");
        } catch {
            return;
        }
    }

    function showMessage(text) {
        panelState.message = text;
        clearTimeout(panelState.timer);
        panelState.timer = setTimeout(() => {
            panelState.message = "";
            renderBar();
        }, 3000);
        renderBar();
    }

    function saveConfig(patch, done = "Saved") {
        store.config = { ...(store.config || {}), ...patch };
        return bg("setConfig", patch).then((config) => {
            if (config) store.config = config;
            showMessage(done);
        }).catch((err) => showMessage(err.message));
    }

    function setValue(input, value) {
        if (document.activeElement !== input && input.value !== value) input.value = value;
    }

    function ensureBar() {
        let bar = document.getElementById("wtl-bar");
        if (bar && bar.isConnected) return bar;
        const list = document.querySelector(SEL.warList);
        if (!list) return null;
        const anchor = list.closest(".desc-wrap") || list.parentElement;
        if (!anchor?.parentElement) return null;

        bar = document.createElement("div");
        bar.id = "wtl-bar";
        bar.innerHTML = BAR_HTML;
        anchor.parentElement.insertBefore(bar, anchor);
        bar.style.width = "100%";
        const field = (name) => bar.querySelector(`[data-wtl="${name}"]`);
        const onCommit = (input, fn) => {
            input.addEventListener("change", fn);
            input.addEventListener("keydown", (e) => { if (e.key === "Enter") fn(); });
        };

        for (const [key, name] of FILTER_FIELDS) {
            const input = field(key);
            onCommit(input, () => {
                const patch = { [name]: input.value.trim() };
                bg("setConfig", patch).catch(() => {});
                store.config = { ...(store.config || {}), ...patch };
                applyFilter();
            });
        }

        field("noticehide").addEventListener("click", () => {
            hideNotice(field("notice").dataset.clash);
            renderBar();
        });

        field("toggle").addEventListener("click", () => {
            panelState.open = !panelState.open;
            panelState.auto = false;
            renderBar();
        });

        const login = () => {
            const input = field("apikey");
            const key = input.value.trim();
            if (!key) return showMessage("Paste a Torn API key first");
            showMessage("Logging in…");
            return bg("setConfig", { apiKey: key }).then((config) => {
                if (config) store.config = config;
                input.value = "";
                showMessage(store.needsLogin ? "" : "Logged in");
            }).catch((err) => showMessage(err.message));
        };
        field("login").addEventListener("click", login);
        field("apikey").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

        onCommit(field("warid"), () => {
            const raw = field("warid").value.trim();
            if (raw && !/^\d+$/.test(raw)) return showMessage("War id must be a number");
            const warId = raw ? Number(raw) : null;
            const current = store.config?.autoWarId === false ? store.config?.warId ?? null : null;
            if (warId !== current) saveConfig({ warId, autoWarId: warId == null });
        });
        field("reconnect").addEventListener("click", () => {
            showMessage("Connecting…");
            bg("connect").then((s) => {
                ingestState(s);
                enhanceAll();
                showMessage("");
            }).catch((err) => {
                store.lastError = err.message;
                showMessage(err.message);
            });
        });

        field("callalert").addEventListener("change", (e) => {
            if (e.target.checked) beep(CALL_TONES);
            saveConfig({ callAlertEnabled: e.target.checked });
        });
        onCommit(field("calllead"), () => {
            const sec = Number(field("calllead").value.trim());
            if (!Number.isFinite(sec) || sec < 5 || sec > 300) return showMessage("Call alert needs 5 to 300 s");
            if (sec !== Number(store.config?.callAlertLeadSec ?? 30)) saveConfig({ callAlertLeadSec: sec });
        });
        field("sound").addEventListener("change", (e) => {
            if (e.target.checked) beep();
            saveConfig({ soundEnabled: e.target.checked });
        });
        onCommit(field("lead"), () => {
            const sec = Number(field("lead").value.trim());
            if (!Number.isFinite(sec) || sec < 3 || sec > 120) return showMessage("Alert needs 3 to 120 s");
            if (sec !== Number(store.config?.soundLeadSec ?? 10)) saveConfig({ soundLeadSec: sec });
        });
        onCommit(field("ffkey"), () => {
            const value = field("ffkey").value.trim();
            if (value === (store.config?.ffKey || "")) return;
            saveConfig({ ffKey: value }).then(() => {
                ffAsked.clear();
                refreshFF();
            });
        });
        return bar;
    }

    function renderBar() {
        const bar = ensureBar();
        if (!bar) return;
        const field = (name) => bar.querySelector(`[data-wtl="${name}"]`);
        const conn = field("conn");
        const noKey = !(store.config?.ffKey || "").trim() && !document.querySelector(".ffscouter-cell");
        const text = store.connected
            ? `39th live · war ${store.warId ?? "?"}${noKey ? " · no FFScouter key" : ""}`
            : "39th offline";
        setText(conn, text);
        const connClass = `wtl-badge ${store.connected ? (noKey ? "wtl-warn" : "wtl-on") : "wtl-off"}`;
        if (conn.className !== connClass) conn.className = connClass;
        const torn = tornState();
        const [tornText, tornTone] = TORN_BADGE[torn];
        const tornBadge = field("torn");
        setText(tornBadge, tornText);
        const tornClass = tornTone ? `wtl-badge ${tornTone}` : "wtl-badge";
        if (tornBadge.className !== tornClass) tornBadge.className = tornClass;
        field("lock").hidden = !store.requestLock;
        const err = store.connected ? "" : (store.lastError || "");
        if (field("err").textContent !== err) field("err").textContent = err;

        if (store.needsLogin && !panelState.open) {
            panelState.open = true;
            panelState.auto = true;
        } else if (!store.needsLogin && panelState.auto) {
            panelState.open = false;
            panelState.auto = false;
        }
        field("panel").hidden = !panelState.open;
        field("toggle").classList.toggle("wtl-active", panelState.open);
        if (field("saved").textContent !== panelState.message) field("saved").textContent = panelState.message;

        const clash = CLASHING_SCRIPTS.find((script) => !noticeHidden(script.id) && document.querySelector(script.selector));
        const notice = clash
            ? { id: clash.id, text: `${clash.name} is also running and changes this list too. This script does the same work, so turn ${clash.short} off in your userscript manager and reload the page.` }
            : store.requestLock && !noticeHidden("requestlock") ? { id: "requestlock", text: lockHint(), link: violentmonkeyFits() ? MOVE_GUIDE : null }
            : torn === "missing" && !noticeHidden("tornlive") ? { id: "tornlive", text: TORN_HINT }
            : speedNoticeDue() ? { id: "speed", text: speedHint(), link: MOVE_GUIDE } : null;
        field("notice").hidden = !notice;
        if (notice) {
            field("notice").dataset.clash = notice.id;
            setText(field("noticetext"), notice.text);
            const link = field("noticelink");
            const href = notice.link?.href || "";
            if ((link.getAttribute("href") || "") !== href) {
                if (href) link.setAttribute("href", href);
                else link.removeAttribute("href");
            }
            setText(link, notice.link?.label || "");
            link.hidden = !href;
        }

        const config = store.config;
        if (!config) return;
        field("keyrow").hidden = !("apiKeySet" in config);
        field("apikey").placeholder = config.apiKeySet ? "saved, paste to replace" : "public access key";
        field("warid").placeholder = store.warId ? `auto (${store.warId})` : "auto";
        setValue(field("warid"), config.autoWarId === false && config.warId ? String(config.warId) : "");
        field("callalert").checked = config.callAlertEnabled !== false;
        setValue(field("calllead"), String(config.callAlertLeadSec ?? 30));
        field("sound").checked = config.soundEnabled !== false;
        setValue(field("lead"), String(config.soundLeadSec ?? 10));
        setValue(field("ffkey"), config.ffKey || "");
        for (const [key, name] of FILTER_FIELDS) setValue(field(key), config[name] ?? "");
    }

    function onCallPress(event) {
        const button = event.target.closest(".wtl-call[data-wtl-call]");
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const press = event.type === "pointerdown" ? event.button === 0 : event.detail === 0;
        if (!press || button.disabled) return;
        const id = button.dataset.wtlCall;
        if (store.busy.has(id)) return;
        const row = button.closest(SEL.rows);
        const name = row ? memberName(row) : "";
        const action = button.dataset.override === "1" ? "overrideDibs" : "toggleDibs";
        const call = { mine: !!myDibFor(id), at: Date.now(), done: false };
        store.busy.set(id, call);
        paintRow(id);
        bg(action, { targetId: id, targetName: name })
            .catch((err) => { store.lastError = err.message; renderBar(); })
            .finally(() => setTimeout(() => releaseCall(id, call), CALL_FALLBACK_MS));
    }

    function settleCalls() {
        for (const [id, call] of store.busy) {
            if (call.done || !!myDibFor(id) === call.mine) continue;
            call.done = true;
            setTimeout(() => releaseCall(id, call), Math.max(0, call.at + CALL_LOCK_MS - Date.now()));
        }
    }

    function releaseCall(id, call) {
        if (store.busy.get(id) !== call) return;
        store.busy.delete(id);
        for (const row of rowsOf(id)) paintCall(row, id);
    }

    document.addEventListener("pointerdown", onCallPress, true);
    document.addEventListener("click", onCallPress, true);

    let ffPendingTimer = null;
    let ffLastRun = 0;

    function scheduleFFRefresh() {
        if (ffPendingTimer) return;
        const wait = Math.max(0, 3000 - (Date.now() - ffLastRun));
        ffPendingTimer = setTimeout(() => { ffPendingTimer = null; refreshFF(); }, wait);
    }

    const ffAsked = new Map();

    function ffWanted(id, now) {
        return !store.ff.has(id) && !(now - (ffAsked.get(id) ?? -Infinity) < FF_RETRY_MS);
    }

    const sameFF = (a, b) => !!a && !!b && a.bsEstimate === b.bsEstimate && a.fairFight === b.fairFight && a.bsHuman === b.bsHuman;

    function ffCoverageGap() {
        const now = Date.now();
        let missing = 0;
        eachRow((row, id) => {
            if (ffWanted(id, now)) missing += 1;
        });
        const me = store.me?.id != null ? String(store.me.id) : null;
        if (me && ffWanted(me, now)) missing += 1;
        return missing;
    }

    async function refreshFF() {
        if (document.querySelector(".ffscouter-cell")) return;
        const now = Date.now();
        const ids = new Set();
        eachRow((row, id) => {
            if (ffWanted(id, now)) ids.add(id);
        });
        const me = store.me?.id != null ? String(store.me.id) : null;
        if (me && ffWanted(me, now)) ids.add(me);
        if (!ids.size) return;
        ffLastRun = now;
        for (const id of ids) ffAsked.set(id, now);
        let data;
        try {
            data = await bg("ff", { ids: [...ids] });
        } catch {
            for (const id of ids) ffAsked.delete(id);
            return;
        }
        let changed = false;
        for (const [id, value] of Object.entries(data || {})) {
            if (sameFF(store.ff.get(String(id)), value)) continue;
            store.ff.set(String(id), value);
            changed = true;
        }
        if (!changed) return;
        schedulePaint();
        if (store.sort === "stats" || store.sort === "ff") sortSoon();
    }

    const OWN_NODES = ".wtl-timer, .wtl-la-col, .wtl-stat, .wtl-ffs-header, .wtl-assigned-tag, .wtl-meta, .wtl-call, .wtl-attack, .wtl-sort-arrow, #wtl-bar";

    const LIST_PARTS = `${SEL.block}, ${SEL.header}, ${SEL.rows}`;

    function hasMatch(nodes, selector) {
        for (const node of nodes) {
            if (node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))) return true;
        }
        return false;
    }

    function onMutations(records) {
        let structural = false;
        for (const record of records) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (!target) continue;
            if (!target.closest(SEL.warList)) {
                if (!structural && hasMatch(record.addedNodes, SEL.warList)) structural = true;
                continue;
            }
            if (target.closest(OWN_NODES)) continue;
            const row = target.closest(SEL.rows);
            if (row?.dataset.wtlId) schedulePaint(row.dataset.wtlId);
            else if (!structural && (row || target.closest(SEL.block)
                || hasMatch(record.addedNodes, LIST_PARTS) || hasMatch(record.removedNodes, LIST_PARTS))) structural = true;
        }
        if (structural) scheduleRefresh();
    }

    function watchDom() {
        new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", () => {
            clearTimeout(watchDom._resize);
            watchDom._resize = setTimeout(ensureHooks, 150);
        });
    }

    async function init() {
        drainEarlyQueue();
        watchDom();
        try {
            ingestState(await bg("getState"));
        } catch (err) {
            store.lastError = err.message;
        }
        enhanceAll();
        setInterval(tick, 1000);
    }

    let ticks = 0;

    function tick() {
        ticks += 1;
        const sweep = ticks % SWEEP_TICKS === 0;
        if (sweep) store.stats.sweeps += 1;
        eachRow((row, id) => {
            if (sweep) return paintOne(row, id, true);
            paintStatus(row, id);
            paintSeen(row, id);
            paintOnline(row, id);
            if (store.myDibCount && myDibFor(id)) paintCall(row, id);
        });
        applySort();
        checkHospitalAlerts();
        checkCallExpiry();
        if (ticks % BAR_TICKS === 0) renderBar();
        if (store.status.size + store.online.size > PRUNE_LIMIT) pruneStale();
    }

    function pruneStale() {
        if (registry.stale) scanRows();
        const keep = (id) => registry.byId.has(id) || store.members.has(id) || store.dibs.has(id) || store.busy.has(id);
        for (const id of store.status.keys()) {
            if (!keep(id)) store.status.delete(id);
        }
        for (const id of store.online.keys()) {
            if (!keep(id)) store.online.delete(id);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
})();
})(WTL_PAGE);
},
});
})();
