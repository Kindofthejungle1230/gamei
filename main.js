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

    allowedGatewayHosts: new Set([
        "portal.example",
        "regional.example"
    ])
});

const DEFAULT_GATEWAYS = Object.freeze({
    default: "https://portal.example/proxy?url=",
    regional: "https://regional.example/proxy?target="
});

const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", () => {
    loadThemeSettings();
    loadGatewaySettings();
    bindTabs();
    bindMirrorControls();
    bindGatewayControls();
    bindRouteForm();
    bindRequestForm();
    bindSettingsControls();

    renderQueue();
    runHealthChecks();
});

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

function bindTabs() {
    document.querySelectorAll("[data-view]").forEach((button) => {
        button.addEventListener("click", () => {
            activateView(button.dataset.view);
        });
    });
}

function activateView(viewName) {
    document.querySelectorAll("[data-view]").forEach((button) => {
        const active = button.dataset.view === viewName;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
    });

    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
        const active = panel.dataset.viewPanel === viewName;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
    });
}

/* -------------------------------------------------------------------------- */
/* Mirror health checks & Button Selection                                    */
/* -------------------------------------------------------------------------- */

function bindMirrorControls() {
    $("#refreshHealthButton").addEventListener("click", runHealthChecks);

    document.querySelectorAll("#mirrorButtonContainer .option-button").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("#mirrorButtonContainer .option-button").forEach(b => b.classList.remove("is-selected"));
            btn.classList.add("is-selected");
        });
    });

    $("#connectMirrorButton").addEventListener("click", () => {
        const selectedBtn = document.querySelector("#mirrorButtonContainer .option-button.is-selected");
        const health = selectedBtn.dataset.health;

        if (health !== "online") {
            setStatus(
                $("#mirrorStatus"),
                "The selected mirror is not confirmed online.",
                true
            );
            return;
        }

        setStatus(
            $("#mirrorStatus"),
            `Connected to ${selectedBtn.dataset.label}.`
        );
    });
}

function bindGatewayControls() {
    document.querySelectorAll("#gatewayButtonContainer .option-button").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("#gatewayButtonContainer .option-button").forEach(b => b.classList.remove("is-selected"));
            btn.classList.add("is-selected");
        });
    });
}

async function checkMirrorHealth(baseUrl, healthPath = "/health") {
    const endpoint = new URL(healthPath, baseUrl);
    const controller = new AbortController();
    const startedAt = performance.now();

    const timeoutId = window.setTimeout(
        () => controller.abort(),
        CONFIG.healthTimeoutMs
    );

    try {
        const response = await fetch(endpoint, {
            method: "HEAD",
            mode: "cors",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal
        });

        return {
            state: response.ok ? "online" : "offline",
            latency: Math.round(performance.now() - startedAt),
            detail: `${response.status} ${response.statusText}`.trim()
        };
    } catch (error) {
        if (error.name === "AbortError") {
            return {
                state: "offline",
                latency: null,
                detail: "Timeout"
            };
        }

        return {
            state: "unverified",
            latency: null,
            detail: "CORS or network policy blocked the check"
        };
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function runHealthChecks() {
    const buttons = [...document.querySelectorAll("#mirrorButtonContainer .option-button")];
    const list = $("#healthList");

    setStatus($("#mirrorStatus"), "Checking endpoint health…");
    list.replaceChildren();

    const results = await Promise.all(
        buttons.map(async (button) => ({
            button,
            result: await checkMirrorHealth(
                button.dataset.value,
                button.dataset.healthPath || "/health"
            )
        }))
    );

    results.forEach(({ button, result }) => {
        const label = button.dataset.label || button.textContent.trim().split(" — ")[0];

        button.dataset.health = result.state;
        button.dataset.latency = result.latency ?? "";

        button.textContent = result.latency
            ? `${label} — ${result.state} (${result.latency} ms)`
            : `${label} — ${result.state} (${result.detail})`;
    });

    for (const { button, result } of results) {
        const item = document.createElement("li");
        const labelElem = document.createElement("span");
        const state = document.createElement("strong");

        labelElem.textContent = button.dataset.label || button.textContent;
        state.textContent = result.latency
            ? `${result.state} · ${result.latency} ms`
            : `${result.state} · ${result.detail}`;

        state.className = result.state;
        item.append(labelElem, state);
        list.append(item);
    }

    setStatus($("#mirrorStatus"), "Endpoint health metrics refreshed.");
}

/* -------------------------------------------------------------------------- */
/* Authorized gateway routing                                                 */
/* -------------------------------------------------------------------------- */

function bindRouteForm() {
    $("#routeForm").addEventListener("submit", (event) => {
        event.preventDefault();

        const frame = $("#routeFrame");
        const status = $("#routeStatus");
        const input = $("#routeInput").value.trim();
        const selectedGatewayBtn = document.querySelector("#gatewayButtonContainer .option-button.is-selected");
        const gatewayName = selectedGatewayBtn ? selectedGatewayBtn.dataset.gateway : "default";

        try {
            const target = createRoutedTarget(input, gatewayName);

            frame.src = target;
            frame.hidden = false;

            setStatus(
                status,
                "Destination opened in the sandbox."
            );
        } catch (error) {
            frame.removeAttribute("src");
            frame.hidden = true;
            setStatus(status, error.message, true);
        }
    });
}

function createRoutedTarget(input, gatewayName) {
    if (!input || input.length > 1000) {
        throw new Error("Enter a destination shorter than 1,000 characters.");
    }

    const directUrl = parseApprovedUrl(input);

    if (directUrl) {
        return directUrl.href;
    }

    if (input.includes("://")) {
        throw new Error("Only approved HTTPS destinations are permitted.");
    }

    const searchUrl = new URL("https://search.example/");
    searchUrl.searchParams.set("q", input);

    return buildGatewayUrl(searchUrl, gatewayName);
}

function parseApprovedUrl(value) {
    let url;

    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (url.protocol !== "https:") {
        throw new Error("Only HTTPS destinations are permitted.");
    }

    if (url.username || url.password) {
        throw new Error("URLs containing credentials are not permitted.");
    }

    if (!CONFIG.allowedDirectHosts.has(url.hostname)) {
        throw new Error("That destination is not on the approved host list.");
    }

    return url;
}

function buildGatewayUrl(destinationUrl, gatewayName) {
    const gateways = getGatewaySettings();
    const prefix = gateways[gatewayName];

    if (!prefix) {
        throw new Error("The selected gateway is not configured.");
    }

    const gatewayUrl = new URL(prefix);

    if (!CONFIG.allowedGatewayHosts.has(gatewayUrl.hostname)) {
        throw new Error("The configured gateway is not approved.");
    }

    return `${gatewayUrl.href}${encodeURIComponent(destinationUrl.href)}`;
}

/* -------------------------------------------------------------------------- */
/* Theme settings                                                             */
/* -------------------------------------------------------------------------- */

function bindSettingsControls() {
    $("#saveSettingsButton").addEventListener("click", saveThemeSettings);
    $("#saveGatewayButton").addEventListener("click", saveGatewaySettings);
    $("#clearQueueButton").addEventListener("click", clearQueue);
}

function loadThemeSettings() {
    const settings = readJson(CONFIG.settingsStorageKey, {});

    if (isHexColor(settings.background)) {
        applyColor("--bg-color", settings.background);
        $("#bgColorPicker").value = settings.background;
    }

    if (isHexColor(settings.accent)) {
        applyColor("--accent-color", settings.accent);
        $("#accentColorPicker").value = settings.accent;
    }
}

function saveThemeSettings() {
    const background = $("#bgColorPicker").value;
    const accent = $("#accentColorPicker").value;

    if (!isHexColor(background) || !isHexColor(accent)) {
        setStatus($("#settingsStatus"), "Invalid color value.", true);
        return;
    }

    applyColor("--bg-color", background);
    applyColor("--accent-color", accent);

    writeJson(CONFIG.settingsStorageKey, {
        background,
        accent
    });

    setStatus($("#settingsStatus"), "Preferences saved.");
}

function applyColor(variable, value) {
    document.documentElement.style.setProperty(variable, value);
}

function isHexColor(value) {
    return /^#[0-9a-f]{6}$/i.test(value || "");
}

/* -------------------------------------------------------------------------- */
/* Gateway configuration                                                       */
/* -------------------------------------------------------------------------- */

function loadGatewaySettings() {
    const gateways = getGatewaySettings();

    $("#defaultGatewayInput").value = gateways.default;
    $("#regionalGatewayInput").value = gateways.regional;
}

function getGatewaySettings() {
    const saved = readJson(CONFIG.gatewayStorageKey, {});

    return {
        default: saved.default || DEFAULT_GATEWAYS.default,
        regional: saved.regional || DEFAULT_GATEWAYS.regional
    };
}

function saveGatewaySettings() {
    const values = {
        default: $("#defaultGatewayInput").value.trim(),
        regional: $("#regionalGatewayInput").value.trim()
    };

    try {
        Object.values(values).forEach(validateGatewayPrefix);
        writeJson(CONFIG.gatewayStorageKey, values);
        setStatus($("#gatewayStatus"), "Gateway configuration saved.");
    } catch (error) {
        setStatus($("#gatewayStatus"), error.message, true);
    }
}

function validateGatewayPrefix(prefix) {
    const url = new URL(prefix);

    if (url.protocol !== "https:") {
        throw new Error("Gateway prefixes must use HTTPS.");
    }

    if (!CONFIG.allowedGatewayHosts.has(url.hostname)) {
        throw new Error(`Gateway host is not approved: ${url.hostname}`);
    }

    if (!prefix.endsWith("=")) {
        throw new Error("Gateway prefixes must end with '='.");
    }
}

/* -------------------------------------------------------------------------- */
/* Request queue and input sanitization                                       */
/* -------------------------------------------------------------------------- */

function bindRequestForm() {
    $("#requestForm").addEventListener("submit", (event) => {
        event.preventDefault();

        const input = $("#gameTitle");
        const title = normalizeTitle(input.value);

        if (!title) {
            setStatus(
                $("#requestStatus"),
                "Enter a valid title.",
                true
            );
            return;
        }

        const requests = readRequests();

        requests.unshift({
            id: crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random()}`,
            title,
            createdAt: new Date().toISOString()
        });

        writeJson(CONFIG.requestStorageKey, requests.slice(0, 100));

        input.value = "";
        setStatus($("#requestStatus"), "Request queued.");
        renderQueue();
    });
}

function normalizeTitle(value) {
    return String(value)
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

function readRequests() {
    const requests = readJson(CONFIG.requestStorageKey, []);

    if (!Array.isArray(requests)) {
        return [];
    }

    return requests.filter((request) => (
        request &&
        typeof request.title === "string" &&
        typeof request.createdAt === "string"
    ));
}

function renderQueue() {
    const list = $("#requestQueue");
    const empty = $("#queueEmpty");
    const requests = readRequests();

    list.replaceChildren();
    empty.hidden = requests.length > 0;

    for (const request of requests) {
        const item = document.createElement("li");
        const title = document.createElement("span");
        const date = document.createElement("time");

        title.textContent = request.title;

        const parsedDate = new Date(request.createdAt);
        date.textContent = Number.isNaN(parsedDate.valueOf())
            ? "Unknown date"
            : parsedDate.toLocaleString();

        item.append(title, date);
        list.append(item);
    }
}

function clearQueue() {
    localStorage.removeItem(CONFIG.requestStorageKey);
    renderQueue();
    setStatus($("#requestStatus"), "Request queue cleared.");
}

/* -------------------------------------------------------------------------- */
/* Storage and status helpers                                                 */
/* -------------------------------------------------------------------------- */

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("error", isError);
}
