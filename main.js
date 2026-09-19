const CONFIG = Object.freeze({
    healthTimeoutMs: 3000,
    requestStorageKey: "portal_request_queue",
    settingsStorageKey: "portal_settings",
    gatewayStorageKey: "portal_gateways",
    allowedDirectHosts: new Set([
        "mirror-alpha.example.com",
        "mirror-beta.example.com",
        "mirror-gamma.example.com"
    ]),
    allowedGatewayHosts: new Set(["portal.example", "regional.example"])
});

const DEFAULT_GATEWAYS = Object.freeze({
    default: "https://portal.example/proxy?url=",
    regional: "https://regional.example/proxy?target="
});

const state = { mirror: null, gateway: "default" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

window.addEventListener("DOMContentLoaded", () => {
    loadThemeSettings();
    loadGatewaySettings();
    bindTabs();
    bindMirrorControls();
    bindGatewayControls();
    bindRouteForm();
    bindRequestForm();
    bindSettingsControls();
    initializeMirrorSelection();
    initializeGatewaySelection();
    renderQueue();
    runHealthChecks();
});

function bindTabs() {
    $$('[data-view]').forEach((button) => {
        button.addEventListener("click", () => activateView(button.dataset.view));
    });
}

function activateView(viewName) {
    $$('[data-view]').forEach((button) => {
        const active = button.dataset.view === viewName;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
    });
    $$('[data-view-panel]').forEach((panel) => {
        const active = panel.dataset.viewPanel === viewName;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
    });
}

function initializeMirrorSelection() {
    const buttons = $$("#mirrorButtonContainer .option-button");
    const saved = localStorage.getItem("portal_active_mirror");
    const initial = buttons.find((button) => button.dataset.value === saved) || buttons.find((button) => button.classList.contains("is-selected")) || buttons[0];
    selectMirror(initial, false);
}

function bindMirrorControls() {
    $("#refreshHealthButton")?.addEventListener("click", runHealthChecks);
    $$("#mirrorButtonContainer .option-button").forEach((button, index, buttons) => {
        button.addEventListener("click", () => selectMirror(button));
        button.addEventListener("keydown", (event) => handleRadioKeys(event, buttons, index, selectMirror));
    });
    $("#connectMirrorButton")?.addEventListener("click", () => {
        if (!state.mirror) return setStatus($("#mirrorStatus"), "Select a mirror first.", true);
        const selected = $("#mirrorButtonContainer .option-button.is-selected");
        if (selected?.dataset.health !== "online") return setStatus($("#mirrorStatus"), "The selected mirror is not confirmed online.", true);
        setStatus($("#mirrorStatus"), `Connected to ${state.mirror.label}.`);
    });
}

function selectMirror(button, announce = true) {
    if (!button) return;
    const buttons = $$("#mirrorButtonContainer .option-button");
    buttons.forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-selected", active);
        item.setAttribute("aria-checked", String(active));
        item.tabIndex = active ? 0 : -1;
    });
    state.mirror = {
        url: button.dataset.value,
        label: button.dataset.label,
        healthPath: button.dataset.healthPath || "/health"
    };
    localStorage.setItem("portal_active_mirror", state.mirror.url);
    if (announce) setStatus($("#mirrorStatus"), `${state.mirror.label} selected.`);
}

function initializeGatewaySelection() {
    const buttons = $$("#gatewayButtonContainer .option-button");
    const saved = localStorage.getItem("portal_active_gateway");
    const initial = buttons.find((button) => button.dataset.gateway === saved) || buttons.find((button) => button.classList.contains("is-selected")) || buttons[0];
    selectGateway(initial, false);
}

function bindGatewayControls() {
    $$("#gatewayButtonContainer .option-button").forEach((button, index, buttons) => {
        button.addEventListener("click", () => selectGateway(button));
        button.addEventListener("keydown", (event) => handleRadioKeys(event, buttons, index, selectGateway));
    });
}

function selectGateway(button, announce = true) {
    if (!button) return;
    const buttons = $$("#gatewayButtonContainer .option-button");
    buttons.forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-selected", active);
        item.setAttribute("aria-checked", String(active));
        item.tabIndex = active ? 0 : -1;
    });
    state.gateway = button.dataset.gateway || "default";
    localStorage.setItem("portal_active_gateway", state.gateway);
    if (announce) setStatus($("#routeStatus"), `${button.querySelector(".option-title")?.textContent || "Gateway"} selected.`);
}

function handleRadioKeys(event, buttons, index, select) {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const nextIndex = (index + (forward ? 1 : -1) + buttons.length) % buttons.length;
    select(buttons[nextIndex]);
    buttons[nextIndex].focus();
}

async function checkMirrorHealth(baseUrl, healthPath = "/health") {
    const controller = new AbortController();
    const startedAt = performance.now();
    const timeoutId = window.setTimeout(() => controller.abort(), CONFIG.healthTimeoutMs);
    try {
        const response = await fetch(new URL(healthPath, baseUrl), {
            method: "HEAD", mode: "cors", cache: "no-store", credentials: "omit", signal: controller.signal
        });
        return { state: response.ok ? "online" : "offline", latency: Math.round(performance.now() - startedAt), detail: `${response.status} ${response.statusText}`.trim() };
    } catch (error) {
        return { state: error.name === "AbortError" ? "offline" : "unverified", latency: null, detail: error.name === "AbortError" ? "Timeout" : "CORS or network policy blocked the check" };
    } finally { window.clearTimeout(timeoutId); }
}

async function runHealthChecks() {
    const buttons = $$("#mirrorButtonContainer .option-button");
    const list = $("#healthList");
    if (!list || !buttons.length) return;
    setStatus($("#mirrorStatus"), "Checking endpoint health…");
    list.replaceChildren();
    const results = await Promise.all(buttons.map(async (button) => ({ button, result: await checkMirrorHealth(button.dataset.value, button.dataset.healthPath || "/health") })));
    let online = 0;
    results.forEach(({ button, result }) => {
        button.dataset.health = result.state;
        button.dataset.latency = result.latency ?? "";
        if (result.state === "online") online++;
        const item = document.createElement("li");
        const label = document.createElement("span");
        const status = document.createElement("strong");
        label.textContent = button.dataset.label;
        status.textContent = result.latency === null ? `${result.state} · ${result.detail}` : `${result.state} · ${result.latency} ms`;
        status.className = result.state;
        item.append(label, status);
        list.append(item);
    });
    setStatus($("#mirrorStatus"), `${online} of ${results.length} endpoints online.`);
}

function bindRouteForm() {
    $("#routeForm")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = $("#routeInput").value.trim();
        const frame = $("#routeFrame");
        if (!input) return setStatus($("#routeStatus"), "Enter a destination or search query.", true);
        try {
            frame.src = createRoutedTarget(input, state.gateway);
            frame.hidden = false;
            setStatus($("#routeStatus"), "Destination opened in the sandbox.");
        } catch (error) {
            frame.removeAttribute("src");
            frame.hidden = true;
            setStatus($("#routeStatus"), error.message, true);
        }
    });
}

function createRoutedTarget(input, gatewayName) {
    if (!input || input.length > 1000) throw new Error("Enter a destination shorter than 1,000 characters.");
    const directUrl = parseApprovedUrl(input);
    if (directUrl) return directUrl.href;
    if (input.includes("://")) throw new Error("Only approved HTTPS destinations are permitted.");
    const searchUrl = new URL("https://search.example/");
    searchUrl.searchParams.set("q", input);
    return buildGatewayUrl(searchUrl, gatewayName);
}

function parseApprovedUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:") throw new Error("Only HTTPS destinations are permitted.");
    if (url.username || url.password) throw new Error("URLs containing credentials are not permitted.");
    if (!CONFIG.allowedDirectHosts.has(url.hostname)) throw new Error("That destination is not on the approved host list.");
    return url;
}

function buildGatewayUrl(destinationUrl, gatewayName) {
    const prefix = getGatewaySettings()[gatewayName];
    if (!prefix) throw new Error("The selected gateway is not configured.");
    const gatewayUrl = new URL(prefix);
    if (!CONFIG.allowedGatewayHosts.has(gatewayUrl.hostname)) throw new Error("The configured gateway is not approved.");
    return `${gatewayUrl.href}${encodeURIComponent(destinationUrl.href)}`;
}

function bindSettingsControls() {
    $("#saveSettingsButton")?.addEventListener("click", saveThemeSettings);
    $("#saveGatewayButton")?.addEventListener("click", saveGatewaySettings);
    $("#clearQueueButton")?.addEventListener("click", clearQueue);
}

function loadThemeSettings() {
    const settings = readJson(CONFIG.settingsStorageKey, {});
    if (isHexColor(settings.background)) { applyColor("--bg-color", settings.background); $("#bgColorPicker").value = settings.background; }
    if (isHexColor(settings.accent)) { applyColor("--accent-color", settings.accent); $("#accentColorPicker").value = settings.accent; }
}

function saveThemeSettings() {
    const background = $("#bgColorPicker").value;
    const accent = $("#accentColorPicker").value;
    if (!isHexColor(background) || !isHexColor(accent)) return setStatus($("#settingsStatus"), "Invalid color value.", true);
    applyColor("--bg-color", background);
    applyColor("--accent-color", accent);
    writeJson(CONFIG.settingsStorageKey, { background, accent });
    setStatus($("#settingsStatus"), "Preferences saved.");
}

function applyColor(variable, value) { document.documentElement.style.setProperty(variable, value); }
function isHexColor(value) { return /^#[0-9a-f]{6}$/i.test(value || ""); }

function loadGatewaySettings() {
    const gateways = getGatewaySettings();
    $("#defaultGatewayInput").value = gateways.default;
    $("#regionalGatewayInput").value = gateways.regional;
}

function getGatewaySettings() {
    const saved = readJson(CONFIG.gatewayStorageKey, {});
    return { default: saved.default || DEFAULT_GATEWAYS.default, regional: saved.regional || DEFAULT_GATEWAYS.regional };
}

function saveGatewaySettings() {
    const values = { default: $("#defaultGatewayInput").value.trim(), regional: $("#regionalGatewayInput").value.trim() };
    try { Object.values(values).forEach(validateGatewayPrefix); writeJson(CONFIG.gatewayStorageKey, values); setStatus($("#gatewayStatus"), "Gateway configuration saved."); }
    catch (error) { setStatus($("#gatewayStatus"), error.message, true); }
}

function validateGatewayPrefix(prefix) {
    const url = new URL(prefix);
    if (url.protocol !== "https:") throw new Error("Gateway prefixes must use HTTPS.");
    if (!CONFIG.allowedGatewayHosts.has(url.hostname)) throw new Error(`Gateway host is not approved: ${url.hostname}`);
    if (!prefix.endsWith("=")) throw new Error("Gateway prefixes must end with '='.");
}

function bindRequestForm() {
    $("#requestForm")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = $("#gameTitle");
        const title = normalizeTitle(input.value);
        if (!title) return setStatus($("#requestStatus"), "Enter a valid title.", true);
        const requests = readRequests();
        requests.unshift({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, title, createdAt: new Date().toISOString() });
        writeJson(CONFIG.requestStorageKey, requests.slice(0, 100));
        input.value = "";
        setStatus($("#requestStatus"), "Request queued.");
        renderQueue();
    });
}

function normalizeTitle(value) { return String(value).normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120); }

function readRequests() {
    const requests = readJson(CONFIG.requestStorageKey, []);
    return Array.isArray(requests) ? requests.filter((request) => request && typeof request.title === "string" && typeof request.createdAt === "string") : [];
}

function renderQueue() {
    const list = $("#requestQueue");
    const empty = $("#queueEmpty");
    if (!list || !empty) return;
    const requests = readRequests();
    list.replaceChildren();
    empty.hidden = requests.length > 0;
    requests.forEach((request) => {
        const item = document.createElement("li");
        const title = document.createElement("span");
        const date = document.createElement("time");
        title.textContent = request.title;
        const parsedDate = new Date(request.createdAt);
        date.textContent = Number.isNaN(parsedDate.valueOf()) ? "Unknown date" : parsedDate.toLocaleString();
        item.append(title, date);
        list.append(item);
    });
}

function clearQueue() { localStorage.removeItem(CONFIG.requestStorageKey); renderQueue(); setStatus($("#requestStatus"), "Request queue cleared."); }
function readJson(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function setStatus(element, message, isError = false) { if (!element) return; element.textContent = message; element.classList.toggle("error", isError); }
