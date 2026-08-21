export function renderAdminPage({ bootstrapAdminToken = "" } = {}) {
  const bootstrapJson = JSON.stringify(bootstrapAdminToken || "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Relay Admin</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f6f4ee;
      --ink: #171916;
      --muted: #666b61;
      --line: #c9c3b5;
      --panel: #fffdf7;
      --panel-2: #ece8dd;
      --field: #ffffff;
      --green: #2f6f4e;
      --green-2: #d8ead5;
      --amber: #a25f18;
      --amber-2: #f4dfb9;
      --red: #a33b2f;
      --blue: #295e86;
      --black: #0e100d;
      --shadow: 0 18px 44px rgba(23, 25, 22, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(23,25,22,.04) 1px, transparent 1px),
        linear-gradient(180deg, rgba(23,25,22,.04) 1px, transparent 1px),
        var(--paper);
      background-size: 28px 28px;
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    button {
      border: 1px solid var(--black);
      background: var(--black);
      color: #fff;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 6px;
      cursor: pointer;
    }
    button.secondary { background: var(--panel); color: var(--ink); border-color: var(--line); }
    button.danger { background: var(--red); border-color: var(--red); }
    button.ghost { background: transparent; color: var(--ink); border-color: transparent; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    input, select, textarea {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--field);
      color: var(--ink);
      padding: 7px 9px;
      outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--green); box-shadow: 0 0 0 3px var(--green-2); }
    input[type="range"] { padding: 0; accent-color: var(--green); }
    input[type="checkbox"] { width: auto; min-height: 0; }
    textarea { min-height: 420px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; resize: vertical; }
    .shell { max-width: 1380px; margin: 0 auto; padding: 24px; }
    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      align-items: end;
      border-bottom: 2px solid var(--black);
      padding-bottom: 18px;
      margin-bottom: 18px;
    }
    .brand { display: flex; align-items: end; gap: 16px; }
    h1 { margin: 0; font: 700 clamp(26px, 4vw, 46px)/.95 Georgia, serif; letter-spacing: 0; }
    .stamp { border: 1px solid var(--black); padding: 7px 9px; font: 700 11px/1 ui-monospace, monospace; text-transform: uppercase; }
    .auth { display: grid; grid-template-columns: minmax(220px, 320px) auto; gap: 8px; align-items: end; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .notice { min-height: 28px; padding: 8px 0; color: var(--muted); }
    .notice.good { color: var(--green); }
    .notice.bad { color: var(--red); }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; align-items: start; }
    .rail, .work, .api-row, .json-panel {
      background: rgba(255, 253, 247, .94);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .rail { padding: 14px; position: sticky; top: 16px; }
    .work { padding: 14px; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    h2, h3 { margin: 0; font-size: 14px; letter-spacing: .02em; }
    .subtle { color: var(--muted); font-size: 12px; }
    .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 12px 0; }
    .metric { border: 1px solid var(--line); background: var(--panel-2); padding: 10px; border-radius: 6px; min-height: 70px; }
    .metric .value { margin-top: 6px; font: 700 24px/1 Georgia, serif; color: var(--green); }
    .segmented { display: grid; grid-template-columns: repeat(2, 1fr); border: 1px solid var(--black); border-radius: 6px; overflow: hidden; }
    .segmented button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); }
    .segmented button.active { background: var(--black); color: #fff; }
    .field-grid { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; align-items: end; }
    .field { min-width: 0; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
    label { display: block; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
    .api-list { display: grid; gap: 10px; }
    .api-row { padding: 12px; box-shadow: none; }
    .api-row.disabled { opacity: .62; }
    .api-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .api-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); font-size: 12px; }
    .pill.on { color: var(--green); border-color: var(--green); background: var(--green-2); }
    .row-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .work-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border: 1px solid var(--black);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .work-tabs button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); }
    .work-tabs button.active { background: var(--black); color: #fff; }
    .tab-panel { min-width: 0; }
    .traffic-board { display: grid; grid-template-columns: 1.05fr .95fr; gap: 10px; margin-bottom: 14px; }
    .overview-grid { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .range-tabs { display: inline-grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    .range-tabs button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); min-width: 72px; }
    .range-tabs button.active { background: var(--green); color: #fff; }
    .board-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      padding: 10px;
      min-width: 0;
    }
    .board-panel h3 { margin-bottom: 8px; }
    .log-list {
      display: grid;
      gap: 7px;
      max-height: 430px;
      overflow: auto;
      padding-right: 4px;
    }
    .log-pager {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }
    .pager-buttons { display: flex; gap: 6px; }
    .usage-list, .compare-list { display: grid; gap: 7px; }
    .chart {
      display: grid;
      grid-template-columns: repeat(var(--bars), minmax(10px, 1fr));
      gap: 6px;
      align-items: end;
      min-height: 190px;
      border: 1px solid rgba(14,16,13,.12);
      border-radius: 6px;
      background: rgba(255,253,247,.72);
      padding: 10px;
    }
    .bar-wrap { display: grid; grid-template-rows: 1fr auto; gap: 6px; min-width: 0; height: 170px; }
    .bar {
      align-self: end;
      min-height: 3px;
      border-radius: 4px 4px 2px 2px;
      background: linear-gradient(180deg, var(--green), var(--blue));
    }
    .bar-label { color: var(--muted); font-size: 10px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .heatmap-shell {
      border: 1px solid rgba(14,16,13,.12);
      border-radius: 6px;
      background: rgba(255,253,247,.72);
      padding: 12px;
      overflow-x: auto;
    }
    .heatmap-track {
      width: max-content;
      min-width: 100%;
    }
    .heatmap-months {
      display: grid;
      grid-template-columns: repeat(var(--weeks), 12px);
      gap: 4px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 11px;
    }
    .heatmap-months span {
      grid-column: var(--month-column) / span 4;
      min-width: 0;
      white-space: nowrap;
    }
    .heatmap {
      display: grid;
      grid-template-rows: repeat(7, 12px);
      grid-auto-flow: column;
      grid-auto-columns: 12px;
      gap: 4px;
      min-height: 108px;
    }
    .heat-cell {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      border: 1px solid rgba(14,16,13,.08);
      background: #ebe6db;
    }
    .heat-cell.level-1 { background: #c9dcc9; }
    .heat-cell.level-2 { background: #8fbc91; }
    .heat-cell.level-3 { background: #4f8a61; }
    .heat-cell.level-4 { background: #255f46; }
    .heat-legend {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 11px;
    }
    .call-row, .usage-row {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) auto;
      gap: 8px;
      align-items: center;
      border: 1px solid rgba(14,16,13,.12);
      border-radius: 6px;
      background: rgba(255,253,247,.72);
      padding: 8px;
    }
    .call-row.compact { min-height: 58px; }
    .call-row { cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease; }
    .call-row:hover { transform: translateY(-1px); border-color: var(--green); background: var(--panel); }
    .call-main, .usage-main { min-width: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .token { font-weight: 700; color: var(--blue); white-space: nowrap; }
    .result { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
    .result.success { color: var(--green); }
    .result.failure { color: var(--red); }
    .log-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 18px;
      background: rgba(14, 16, 13, .42);
    }
    .dialog {
      width: min(820px, 100%);
      max-height: min(760px, 92vh);
      overflow: auto;
      border: 1px solid var(--black);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 28px 80px rgba(14,16,13,.25);
      padding: 14px;
    }
    .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 12px 0; }
    .detail-cell { border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); padding: 9px; min-width: 0; }
    .response-box {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      min-height: 120px;
      max-height: 300px;
      overflow: auto;
      padding: 10px;
    }
    .detail-tabs { display: inline-grid; grid-template-columns: repeat(2, 1fr); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
    .detail-tabs button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); }
    .detail-tabs button.active { background: var(--green); color: #fff; }
    .json-box {
      white-space: pre-wrap;
      overflow: auto;
      max-height: 430px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      padding: 10px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .checkline { display: flex; align-items: center; gap: 7px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .slider-row { display: grid; grid-template-columns: 1fr 42px; gap: 8px; align-items: center; }
    .slider-row output {
      text-align: right;
      font: 700 14px/1 ui-monospace, monospace;
      color: var(--green);
    }
    .tabs { display: inline-grid; grid-template-columns: repeat(2, 1fr); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    .tabs button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); }
    .tabs button.active { background: var(--green); color: #fff; }
    .json-panel { padding: 12px; box-shadow: none; }
    .hidden { display: none !important; }
    .divider { height: 1px; background: var(--line); margin: 14px 0; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .rail { position: static; }
      .field-grid { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .traffic-board, .overview-grid { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      .topbar { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .shell { padding: 14px; }
      .auth { grid-template-columns: 1fr; }
      .field-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div class="brand">
        <h1>Codex Relay Admin</h1>
        <div class="stamp">runtime desk</div>
      </div>
      <div class="auth">
        <div>
          <label for="admin-key">Admin Key</label>
          <input id="admin-key" type="password" autocomplete="off">
        </div>
        <button id="connect">Connect</button>
      </div>
    </section>

    <div class="toolbar">
      <button id="save">Save + Reload</button>
      <button id="reload" class="secondary">Reload File</button>
      <button id="refresh" class="secondary">Refresh</button>
      <div class="tabs">
        <button id="quick-tab" class="active">Quick</button>
        <button id="json-tab">JSON</button>
      </div>
    </div>
    <div id="notice" class="notice">Idle</div>

    <section class="layout">
      <aside class="rail">
        <div class="section-title">
          <h2>Codex Provider</h2>
          <span id="codex-state" class="pill">unknown</span>
        </div>
        <div class="segmented">
          <button id="provider-openai">openai</button>
          <button id="provider-relay">relay</button>
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button id="apply-provider" class="secondary">Apply Provider</button>
        </div>
        <div class="divider"></div>
        <div class="section-title">
          <h2>Secrets</h2>
          <button id="save-secrets" class="secondary">Save</button>
        </div>
        <div id="secret-list"></div>
        <div class="divider"></div>
        <div class="section-title"><h2>Runtime</h2></div>
        <div class="metrics">
          <div class="metric"><div class="subtle">status</div><div id="metric-status" class="value">-</div></div>
          <div class="metric"><div class="subtle">deployments</div><div id="metric-deployments" class="value">-</div></div>
          <div class="metric"><div class="subtle">healthy</div><div id="metric-healthy" class="value">-</div></div>
          <div class="metric"><div class="subtle">attempts</div><div id="metric-attempts" class="value">-</div></div>
        </div>
        <div class="divider"></div>
        <div class="section-title">
          <h2>Routes</h2>
          <button id="add-model" class="ghost">Add Route</button>
        </div>
        <div class="subtle" style="margin-bottom:8px">Codex model name mapping</div>
        <select id="model-select"></select>
      </aside>

      <section class="work">
        <div id="quick-panel">
          <div class="work-tabs">
            <button id="overview-work-tab" class="active">Overview</button>
            <button id="logs-work-tab">Logs</button>
            <button id="apis-work-tab">APIs</button>
          </div>
          <div id="overview-panel" class="tab-panel">
          <div class="section-title">
            <h2>Overview</h2>
            <span class="subtle">model comparison and runtime shape</span>
          </div>
          <div id="overview-board"></div>
          </div>
          <div id="logs-panel" class="tab-panel hidden">
          <div class="section-title">
            <h2>Runtime Logs</h2>
            <span class="subtle">click a row for detail</span>
          </div>
          <div id="log-list" class="log-list"></div>
          </div>
          <div id="apis-panel" class="tab-panel hidden">
          <div class="section-title">
            <h2>APIs</h2>
            <div class="row-actions">
              <button id="enable-all-apis" class="secondary">Enable All</button>
              <button id="add-api" class="secondary">Add API</button>
            </div>
          </div>
          <div id="api-list" class="api-list"></div>
          </div>
        </div>
        <div id="json-panel" class="json-panel hidden">
          <div class="section-title">
            <h2>Detailed Config</h2>
            <button id="format-json" class="secondary">Format</button>
          </div>
          <textarea id="json-editor" spellcheck="false"></textarea>
        </div>
      </section>
    </section>
  </main>
  <div id="call-modal" class="modal hidden">
    <div class="dialog">
      <div class="section-title">
        <h2 id="call-modal-title">Call Detail</h2>
        <button id="close-call-detail" class="secondary">Close</button>
      </div>
      <div class="detail-tabs">
        <button id="call-summary-tab" class="active">Summary</button>
        <button id="call-json-tab">JSON</button>
      </div>
      <div id="call-detail"></div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const bootstrapAdminToken = ${bootstrapJson};
    let adminToken = bootstrapAdminToken || localStorage.getItem("codexRelayAdminKey") || "";
    let config = null;
    let selectedModel = "";
    let selectedProvider = "";
    let view = "quick";
    let workView = "overview";
    let usageRange = "week";
    let logPage = 0;
    let logPageSize = 20;
    let logTotal = 0;
    let logCalls = [];
    let selectedCallDetail = null;
    let callDetailView = "summary";
    let runtimeStatus = { deployments: [], recent_calls: [] };

    $("admin-key").value = adminToken;
    if (bootstrapAdminToken) {
      localStorage.setItem("codexRelayAdminKey", bootstrapAdminToken);
      document.querySelector(".auth").classList.add("hidden");
    }

    function notice(text, kind = "") {
      const element = $("notice");
      element.textContent = text;
      element.className = "notice " + kind;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "authorization": "Bearer " + adminToken,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      if (!response.ok) {
        const message = body?.error?.message || body || response.statusText;
        throw new Error(message);
      }
      return body;
    }

    function models() {
      return Object.keys(config?.models || {});
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function currentModelConfig() {
      if (!selectedModel || !config.models[selectedModel]) {
        selectedModel = models()[0] || "codex";
        config.models[selectedModel] ||= { aliases: ["gpt-5-codex"], deployments: [] };
      }
      return config.models[selectedModel];
    }

    function syncEditorFromConfig() {
      $("json-editor").value = JSON.stringify(config, null, 2);
    }

    function syncConfigFromEditor() {
      if (view === "json") {
        config = JSON.parse($("json-editor").value);
      }
    }

    function renderMetrics(status) {
      const deployments = status.deployments || [];
      $("metric-status").textContent = status.status || "-";
      $("metric-deployments").textContent = deployments.length;
      $("metric-healthy").textContent = deployments.filter((item) => item.status === "healthy").length;
      $("metric-attempts").textContent = deployments.reduce((sum, item) => sum + item.attempts, 0);
    }

    function formatTime(value) {
      if (!value) return "never";
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }

    function formatTokens(usage) {
      if (!usage) return "0";
      return String(usage.total_tokens ?? 0);
    }

    function callTitle(item) {
      return item.upstream_model || item.requested_model || item.deployment_id || "-";
    }

    function modelStats() {
      const usageModels = runtimeStatus.usage?.[usageRange]?.models;
      if (usageModels) {
        return Object.entries(usageModels).map(([model, usage]) => {
          const matching = (runtimeStatus.deployments || []).filter((item) => item.model === model);
          return {
            model,
            deployments: matching.length,
            healthy: matching.filter((item) => item.status === "healthy").length,
            successes: usage.calls - usage.failures,
            failures: usage.failures,
            tokens: usage.total_tokens,
            calls: usage.calls,
            avgLatency: usage.avg_latency_ms
          };
        }).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
      }
      const stats = new Map();
      for (const deployment of runtimeStatus.deployments || []) {
        const key = deployment.model || "-";
        const usage = deployment.token_usage || {};
        const current = stats.get(key) || {
          model: key,
          deployments: 0,
          healthy: 0,
          successes: 0,
          failures: 0,
          tokens: 0,
          calls: 0,
          latencyTotal: 0,
          latencyCount: 0
        };
        current.deployments += 1;
        current.healthy += deployment.status === "healthy" ? 1 : 0;
        current.successes += deployment.successes || 0;
        current.failures += deployment.failures || 0;
        current.tokens += usage.total_tokens || 0;
        current.calls += usage.requests || 0;
        stats.set(key, current);
      }
      for (const call of runtimeStatus.recent_calls || []) {
        const key = call.upstream_model || call.requested_model || "-";
        const current = stats.get(key) || {
          model: key,
          deployments: 0,
          healthy: 0,
          successes: 0,
          failures: 0,
          tokens: 0,
          calls: 0,
          latencyTotal: 0,
          latencyCount: 0
        };
        if (Number.isFinite(call.duration_ms)) {
          current.latencyTotal += call.duration_ms;
          current.latencyCount += 1;
        }
        stats.set(key, current);
      }
      return [...stats.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
    }

    function selectedUsage() {
      const usage = runtimeStatus.usage?.[usageRange];
      if (usage) {
        return usage;
      }
      const deployments = runtimeStatus.deployments || [];
      const calls = runtimeStatus.recent_calls || [];
      const total = deployments.reduce((acc, item) => {
        const itemUsage = item.token_usage || {};
        acc.total_tokens += itemUsage.total_tokens || 0;
        acc.calls += itemUsage.requests || 0;
        return acc;
      }, { total_tokens: 0, calls: 0, failures: calls.filter((item) => item.result === "failure").length, avg_latency_ms: 0 });
      const latencyCalls = calls.filter((item) => Number.isFinite(item.duration_ms));
      total.avg_latency_ms = latencyCalls.length
        ? Math.round(latencyCalls.reduce((sum, item) => sum + item.duration_ms, 0) / latencyCalls.length)
        : 0;
      return { total, buckets: [] };
    }

    function renderTokenChart(buckets) {
      const safeBuckets = buckets?.length ? buckets : [{ date: "today", total_tokens: 0 }];
      const max = Math.max(1, ...safeBuckets.map((item) => item.total_tokens || 0));
      return '<div class="chart" style="--bars:' + safeBuckets.length + '">' +
        safeBuckets.map((item) => {
          const height = Math.max(3, Math.round(((item.total_tokens || 0) / max) * 140));
          const label = item.date.slice(5);
          return '<div class="bar-wrap" title="' + escapeHtml(item.date + ' · ' + (item.total_tokens || 0) + ' tokens') + '">' +
            '<div class="bar" style="height:' + height + 'px"></div>' +
            '<div class="bar-label">' + escapeHtml(label) + '</div>' +
          '</div>';
        }).join("") +
      '</div>';
    }

    function monthLabel(dateText) {
      const date = new Date(dateText + "T00:00:00Z");
      return date.toLocaleString(undefined, { month: "short" });
    }

    function heatLevel(value, max) {
      if (!value) return 0;
      const ratio = value / Math.max(1, max);
      if (ratio >= .75) return 4;
      if (ratio >= .45) return 3;
      if (ratio >= .18) return 2;
      return 1;
    }

    function renderTokenHeatmap(buckets) {
      const safeBuckets = buckets?.length ? buckets : [];
      const max = Math.max(1, ...safeBuckets.map((item) => item.total_tokens || 0));
      const leading = safeBuckets[0]?.date
        ? new Date(safeBuckets[0].date + "T00:00:00Z").getUTCDay()
        : 0;
      const weekCount = Math.max(1, Math.ceil((leading + safeBuckets.length) / 7));
      const cells = Array.from({ length: leading }, () => '<span class="heat-cell" aria-hidden="true"></span>');
      for (const item of safeBuckets) {
        const tokens = item.total_tokens || 0;
        cells.push(
          '<span class="heat-cell level-' + heatLevel(tokens, max) + '" title="' +
            escapeHtml(item.date + ' · ' + tokens + ' tokens · ' + (item.calls || 0) + ' calls') +
          '"></span>'
        );
      }
      const monthLabels = safeBuckets
        .filter((item, index) => index === 0 || item.date.endsWith("-01"))
        .map((item) => {
          const index = safeBuckets.indexOf(item);
          const column = Math.floor((leading + index) / 7) + 1;
          return '<span style="--month-column:' + column + '">' + escapeHtml(monthLabel(item.date)) + '</span>';
        })
        .join("");
      return '<div class="heatmap-shell">' +
        '<div class="heatmap-track" style="--weeks:' + weekCount + '">' +
          '<div class="heatmap-months">' + monthLabels + '</div>' +
          '<div class="heatmap">' + cells.join("") + '</div>' +
          '<div class="heat-legend"><span>Less</span><span class="heat-cell"></span><span class="heat-cell level-1"></span><span class="heat-cell level-2"></span><span class="heat-cell level-3"></span><span class="heat-cell level-4"></span><span>More</span></div>' +
        '</div>' +
      '</div>';
    }

    function renderTokenVisual(buckets) {
      return usageRange === "week" ? renderTokenChart(buckets) : renderTokenHeatmap(buckets);
    }

    function setUsageRange(range) {
      usageRange = range;
      renderDashboard();
    }

    function statusForDeployment(id) {
      return (runtimeStatus.deployments || []).find((item) => item.id === id) || {};
    }

    function renderDashboard() {
      const calls = logCalls.length ? logCalls : (runtimeStatus.recent_calls || []);
      const deployments = runtimeStatus.deployments || [];
      const usage = selectedUsage();
      const totals = usage.total || {};
      const comparisonHtml = modelStats().map((item) => {
        const avg = item.avgLatency ?? (item.latencyCount ? Math.round(item.latencyTotal / item.latencyCount) : 0);
        return '<div class="usage-row">' +
          '<div class="usage-main">' +
            '<strong>' + escapeHtml(item.model) + '</strong>' +
            '<div class="subtle mono">' + item.healthy + '/' + item.deployments + ' healthy · ' + item.successes + ' ok · ' + item.failures + ' fail · ' + avg + 'ms avg</div>' +
          '</div>' +
          '<div class="token">' + item.tokens + ' tok</div>' +
        '</div>';
      }).join("") || '<div class="subtle">No model data yet</div>';
      $("overview-board").innerHTML =
        '<div class="section-title"><div class="range-tabs">' +
          '<button class="' + (usageRange === "week" ? "active" : "") + '" onclick="setUsageRange(\\'week\\')">Week</button>' +
          '<button class="' + (usageRange === "month" ? "active" : "") + '" onclick="setUsageRange(\\'month\\')">Month</button>' +
          '<button class="' + (usageRange === "year" ? "active" : "") + '" onclick="setUsageRange(\\'year\\')">Year</button>' +
        '</div><span class="subtle">persistent usage</span></div>' +
        '<div class="overview-grid">' +
          '<div class="metric"><div class="subtle">tokens</div><div class="value">' + (totals.total_tokens || 0) + '</div></div>' +
          '<div class="metric"><div class="subtle">calls</div><div class="value">' + (totals.calls || 0) + '</div></div>' +
          '<div class="metric"><div class="subtle">avg latency</div><div class="value">' + (totals.avg_latency_ms || 0) + 'ms</div></div>' +
          '<div class="metric"><div class="subtle">failures</div><div class="value">' + (totals.failures || 0) + '</div></div>' +
        '</div>' +
        '<div class="board-panel"><div class="section-title"><h3>Token Activity</h3><span class="subtle">' + usageRange + '</span></div>' + renderTokenVisual(usage.buckets) + '</div>' +
        '<div class="divider"></div>' +
        '<div class="board-panel"><div class="section-title"><h3>Model Comparison</h3><span class="subtle">tokens, health, latency</span></div><div class="compare-list">' + comparisonHtml + '</div></div>';

      const logHtml = calls.map((item, index) => (
        '<div class="call-row compact" onclick="showCallDetail(' + index + ')">' +
          '<div class="call-main">' +
            '<strong>' + escapeHtml(callTitle(item)) + '</strong>' +
            '<div class="subtle mono">' + escapeHtml(item.deployment_id || "-") + ' · ' + escapeHtml(item.provider || "-") + '</div>' +
            '<div class="hint">' + formatTime(item.at) + '</div>' +
          '</div>' +
          '<div><div class="result ' + escapeHtml(item.result || "success") + '">' + escapeHtml(item.result || "success") + '</div><div class="token">' + formatTokens(item.usage) + ' tok</div></div>' +
        '</div>'
      )).join("") || '<div class="subtle">No calls yet</div>';
      const totalPages = Math.max(1, Math.ceil((logTotal || calls.length) / logPageSize));
      const from = calls.length ? logPage * logPageSize + 1 : 0;
      const to = calls.length ? logPage * logPageSize + calls.length : 0;
      const pagerHtml =
        '<div class="log-pager">' +
          '<span class="subtle">Page ' + (logPage + 1) + '/' + totalPages + ' · ' + from + '-' + to + ' of ' + (logTotal || calls.length) + '</span>' +
          '<div class="pager-buttons">' +
            '<button class="secondary" onclick="loadLogPage(' + (logPage - 1) + ')" ' + (logPage <= 0 ? "disabled" : "") + '>Prev</button>' +
            '<button class="secondary" onclick="loadLogPage(' + (logPage + 1) + ')" ' + (logPage + 1 >= totalPages ? "disabled" : "") + '>Next</button>' +
          '</div>' +
        '</div>';
      const usageHtml = deployments.map((item) => {
        const usage = item.token_usage || {};
        return '<div class="usage-row">' +
          '<div class="usage-main">' +
            '<strong>' + escapeHtml(item.id) + '</strong>' +
            '<div class="subtle mono">' + escapeHtml(item.model) + ' · ' + escapeHtml(item.status) + '</div>' +
          '</div>' +
          '<div class="token">' + (usage.total_tokens || 0) + ' tok</div>' +
        '</div>';
      }).join("") || '<div class="subtle">No deployments</div>';
      $("log-list").innerHTML = logHtml + pagerHtml +
        '<div class="board-panel"><h3>Token Totals</h3><div class="usage-list">' + usageHtml + '</div></div>';
    }

    function showCallDetail(index) {
      const item = (logCalls.length ? logCalls : runtimeStatus.recent_calls || [])[index];
      if (!item) return;
      showCallRecord(item, "Call Detail");
    }

    function showCallRecord(item, title = "Call Detail") {
      selectedCallDetail = item;
      callDetailView = "summary";
      $("call-modal-title").textContent = title;
      renderCallDetail();
      $("call-modal").classList.remove("hidden");
    }

    function renderCallDetail() {
      const item = selectedCallDetail;
      if (!item) return;
      const usage = item.usage || {};
      $("call-summary-tab").classList.toggle("active", callDetailView === "summary");
      $("call-json-tab").classList.toggle("active", callDetailView === "json");
      if (callDetailView === "json") {
        $("call-detail").innerHTML = '<pre class="json-box">' + escapeHtml(JSON.stringify(item, null, 2)) + '</pre>';
        return;
      }
      $("call-detail").innerHTML =
        '<div class="detail-grid">' +
          '<div class="detail-cell"><label>result</label><div class="result ' + escapeHtml(item.result || "success") + '">' + escapeHtml(item.result || "success") + '</div></div>' +
          '<div class="detail-cell"><label>deployment</label><div class="mono">' + escapeHtml(item.deployment_id || "-") + '</div></div>' +
          '<div class="detail-cell"><label>provider</label><div>' + escapeHtml(item.provider || "-") + '</div></div>' +
          '<div class="detail-cell"><label>requested model</label><div class="mono">' + escapeHtml(item.requested_model || "-") + '</div></div>' +
          '<div class="detail-cell"><label>upstream model</label><div class="mono">' + escapeHtml(item.upstream_model || "-") + '</div></div>' +
          '<div class="detail-cell"><label>duration</label><div>' + escapeHtml(item.duration_ms ?? "-") + ' ms</div></div>' +
          '<div class="detail-cell"><label>input tokens</label><div>' + (usage.input_tokens || 0) + '</div></div>' +
          '<div class="detail-cell"><label>output tokens</label><div>' + (usage.output_tokens || 0) + '</div></div>' +
          '<div class="detail-cell"><label>total tokens</label><div>' + (usage.total_tokens || 0) + '</div></div>' +
        '</div>' +
        (item.error ? '<div class="detail-cell"><label>error</label><div>' + escapeHtml(item.error.kind || item.error.code || "-") + '</div><div class="hint">' + escapeHtml(item.error.message || "") + '</div></div>' : '') +
        '<label style="margin-top:12px">response preview</label>' +
        '<div class="response-box">' + escapeHtml(item.response_text || "No response text captured.") + '</div>';
    }

    async function loadLogPage(page = 0) {
      const safePage = Math.max(0, page);
      const payload = await api("/admin/calls?offset=" + (safePage * logPageSize) + "&limit=" + logPageSize);
      logPage = Math.floor((payload.offset || 0) / (payload.limit || logPageSize));
      logPageSize = payload.limit || logPageSize;
      logTotal = payload.total || 0;
      logCalls = payload.calls || [];
      renderDashboard();
    }

    function setWorkView(nextView) {
      workView = nextView;
      $("overview-work-tab").classList.toggle("active", workView === "overview");
      $("logs-work-tab").classList.toggle("active", workView === "logs");
      $("apis-work-tab").classList.toggle("active", workView === "apis");
      $("overview-panel").classList.toggle("hidden", workView !== "overview");
      $("logs-panel").classList.toggle("hidden", workView !== "logs");
      $("apis-panel").classList.toggle("hidden", workView !== "apis");
      if (workView === "logs") {
        loadLogPage(logPage).catch((error) => notice(error.message, "bad"));
      }
    }

    function renderCodex(codex) {
      const current = codex?.model_provider || "openai";
      selectedProvider = selectedProvider || current;
      $("codex-state").textContent = current;
      $("codex-state").className = "pill " + (current === "relay" ? "on" : "");
      $("provider-openai").classList.toggle("active", selectedProvider === "openai");
      $("provider-relay").classList.toggle("active", selectedProvider === "relay");
    }

    function renderSecrets(env) {
      const keys = (env?.keys || []).filter((item) => !item.internal);
      $("secret-list").innerHTML = keys.map((item) => (
        '<div class="field" style="margin-bottom:8px">' +
          '<label>' + item.name + ' · ' + item.source + '</label>' +
          '<input class="secret-input" data-name="' + item.name + '" type="password" placeholder="' + (item.configured ? "configured" : "missing") + '">' +
        '</div>'
      )).join("") || '<div class="subtle">No env references yet</div>';
    }

    function renderModelSelect() {
      const select = $("model-select");
      select.innerHTML = models().map((name) => '<option value="' + name + '">' + name + '</option>').join("");
      select.value = selectedModel;
    }

    function setDeployment(index, field, value, rerender = false) {
      const deployment = currentModelConfig().deployments[index];
      if (["priority", "weight"].includes(field)) {
        deployment[field] = Number(value);
      } else if (field === "enabled") {
        deployment.enabled = value;
      } else {
        deployment[field] = value;
      }
      syncEditorFromConfig();
      if (rerender) {
        renderApis();
      }
    }

    function onlyDeployment(index) {
      currentModelConfig().deployments.forEach((deployment, currentIndex) => {
        deployment.enabled = currentIndex === index;
      });
      syncEditorFromConfig();
      renderApis();
    }

    function enableAllDeployments() {
      currentModelConfig().deployments.forEach((deployment) => {
        deployment.enabled = true;
      });
      syncEditorFromConfig();
      renderApis();
      notice("All APIs enabled for " + selectedModel, "good");
    }

    function removeDeployment(index) {
      currentModelConfig().deployments.splice(index, 1);
      syncEditorFromConfig();
      renderApis();
    }

    function input(value, oninput, type = "text") {
      return '<input type="' + type + '" value="' + escapeHtml(value) + '" oninput="' + oninput + '">';
    }

    function slider(value, oninput, min, max) {
      const numeric = Number(value);
      const safeValue = Number.isFinite(numeric) ? numeric : min;
      return '<div class="slider-row">' +
        '<input type="range" min="' + min + '" max="' + max + '" value="' + safeValue + '" oninput="this.nextElementSibling.textContent = this.value; ' + oninput + '">' +
        '<output>' + safeValue + '</output>' +
      '</div>';
    }

    function renderApis() {
      const list = $("api-list");
      const deployments = currentModelConfig().deployments;
      list.innerHTML = deployments.map((item, index) => {
        const enabled = item.enabled !== false;
        const live = statusForDeployment(item.id);
        const usage = live.token_usage || {};
        const last = live.last_request;
        return '<article class="api-row ' + (enabled ? "" : "disabled") + '">' +
          '<div class="api-head">' +
            '<div class="api-name"><strong>' + escapeHtml(item.id) + '</strong><span class="pill ' + (enabled ? "on" : "") + '">' + (enabled ? "enabled" : "disabled") + '</span><span class="pill">' + escapeHtml(live.status || "new") + '</span></div>' +
            '<div class="row-actions">' +
              '<button class="secondary" onclick="onlyDeployment(' + index + ')">Only This</button>' +
              '<button class="secondary" onclick="testDeployment(' + index + ')">Test</button>' +
              '<button class="secondary" onclick="setDeployment(' + index + ', \\'enabled\\', ' + (!enabled) + ', true)">' + (enabled ? "Disable" : "Enable") + '</button>' +
              '<button class="danger" onclick="removeDeployment(' + index + ')">Remove</button>' +
            '</div>' +
          '</div>' +
          '<div class="field-grid">' +
            '<div class="field"><label>API</label>' + input(item.api_key, "setDeployment(" + index + ", 'api_key', this.value)", "password") + '</div>' +
            '<div class="field"><label>model_provider</label>' + input(item.provider || "", "setDeployment(" + index + ", 'provider', this.value)") + '</div>' +
            '<div class="field"><label>base_url</label>' + input(item.base_url || "", "setDeployment(" + index + ", 'base_url', this.value)") + '</div>' +
            '<div class="field"><label>model</label>' + input(item.model || "", "setDeployment(" + index + ", 'model', this.value)") + '</div>' +
            '<div class="field"><label>id</label>' + input(item.id || "", "setDeployment(" + index + ", 'id', this.value)") + '</div>' +
            '<div class="field"><label>priority</label>' + slider(item.priority ?? 100, "setDeployment(" + index + ", 'priority', this.value)", 1, 100) + '<div class="hint">smaller runs first</div></div>' +
            '<div class="field"><label>weight</label>' + slider(item.weight ?? 1, "setDeployment(" + index + ", 'weight', this.value)", 1, 20) + '<div class="hint">same priority share</div></div>' +
            '<div class="field"><label>tokens</label><div class="token">' + (usage.total_tokens || 0) + '</div><div class="hint">' + (usage.requests || 0) + ' successful calls</div></div>' +
            '<div class="field"><label>last model</label><div class="mono">' + escapeHtml(last?.upstream_model || "-") + '</div><div class="hint">' + formatTime(last?.at) + '</div></div>' +
          '</div>' +
        '</article>';
      }).join("") || '<div class="api-row">No APIs</div>';
    }

    function renderAll(payload) {
      config = payload.config;
      runtimeStatus = payload.status || { deployments: [], recent_calls: [] };
      logPage = 0;
      logCalls = runtimeStatus.recent_calls || [];
      logTotal = Math.max(logTotal, logCalls.length);
      selectedModel = selectedModel && config.models[selectedModel] ? selectedModel : models()[0];
      renderMetrics(runtimeStatus);
      renderCodex(payload.codex || {});
      renderSecrets(payload.env || {});
      renderModelSelect();
      renderDashboard();
      renderApis();
      syncEditorFromConfig();
    }

    async function refresh() {
      const payload = await api("/admin/config");
      renderAll(payload);
      notice("Loaded " + payload.config_path, "good");
    }

    function providerNotice(codex) {
      const threads = codex.threads;
      const suffix = threads?.exists
        ? " · threads updated " + threads.updated + "/" + threads.total
        : " · thread state not found";
      return "Codex model_provider = " + codex.model_provider + suffix;
    }

    async function syncCodexProvider() {
      const payload = await api("/admin/codex-config", {
        method: "POST",
        body: JSON.stringify({ model_provider: selectedProvider })
      });
      renderCodex(payload.codex);
      return payload.codex;
    }

    async function save(options = {}) {
      syncConfigFromEditor();
      const payload = await api("/admin/config", {
        method: "PUT",
        body: JSON.stringify({ config })
      });
      renderAll(payload);
      let codex = null;
      if (options.syncProvider !== false) {
        codex = await syncCodexProvider();
      }
      if (!options.quiet) {
        notice(
          "Saved and reloaded at " + payload.reloaded_at + (codex ? " · " + providerNotice(codex) : ""),
          "good"
        );
      }
      return payload;
    }

    async function runDeploymentTest(index) {
      const deployment = currentModelConfig().deployments[index];
      if (!deployment) return;
      notice("Saving current config before test...", "");
      await save({ quiet: true, syncProvider: false });
      notice("Testing " + deployment.id + "...", "");
      const result = await api("/admin/test-deployment", {
        method: "POST",
        body: JSON.stringify({
          deployment_id: deployment.id,
          input: "Reply with OK in one short sentence."
        })
      });
      runtimeStatus = result.status || runtimeStatus;
      logPage = 0;
      logCalls = runtimeStatus.recent_calls || logCalls;
      logTotal = Math.max(logTotal, logCalls.length);
      renderMetrics(runtimeStatus);
      renderDashboard();
      renderApis();
      showCallRecord({
        result: result.ok ? "success" : "failure",
        deployment_id: result.deployment_id,
        provider: result.provider,
        request_id: result.request_id,
        requested_model: result.model,
        upstream_model: result.model,
        duration_ms: result.duration_ms,
        usage: result.usage || null,
        response_text: result.response_text,
        error: result.error || null,
        at: new Date().toISOString()
      }, "Test Result");
      notice(
        (result.ok ? "Test passed: " : "Test failed: ") + deployment.id + " · " + (result.duration_ms ?? "-") + "ms",
        result.ok ? "good" : "bad"
      );
    }

    async function reloadFile() {
      await api("/admin/reload", { method: "POST" });
      await refresh();
      notice("Reloaded from file", "good");
    }

    async function saveSecrets() {
      const values = {};
      document.querySelectorAll(".secret-input").forEach((input) => {
        if (input.value) {
          values[input.dataset.name] = input.value;
        }
      });
      if (Object.keys(values).length === 0) {
        notice("No secret changes", "bad");
        return;
      }
      await api("/admin/env", {
        method: "PUT",
        body: JSON.stringify({ values })
      });
      await refresh();
      notice("Secrets saved and runtime reloaded", "good");
    }

    function addApi() {
      const model = currentModelConfig();
      const index = model.deployments.length + 1;
      model.deployments.push({
        id: selectedModel + "-api-" + index,
        provider: "openai-compatible",
        base_url: "https://api.openai.com/v1",
        model: model.aliases?.[0] || selectedModel,
        api_key: "env:UPSTREAM_API_KEY_" + index,
        priority: 10,
        weight: 1,
        enabled: true
      });
      syncEditorFromConfig();
      renderApis();
    }

    function addModel() {
      let name = prompt("Route name used by Codex", "codex");
      if (!name) return;
      name = name.trim();
      if (!name) return;
      config.models[name] ||= { aliases: ["gpt-5-codex"], deployments: [] };
      selectedModel = name;
      renderModelSelect();
      renderApis();
      syncEditorFromConfig();
    }

    async function applyProvider() {
      const codex = await syncCodexProvider();
      notice(providerNotice(codex), "good");
    }

    $("connect").onclick = async () => {
      adminToken = $("admin-key").value.trim();
      localStorage.setItem("codexRelayAdminKey", adminToken);
      try { await refresh(); } catch (error) { notice(error.message, "bad"); }
    };
    $("refresh").onclick = () => refresh().catch((error) => notice(error.message, "bad"));
    $("save").onclick = () => save().catch((error) => notice(error.message, "bad"));
    $("reload").onclick = () => reloadFile().catch((error) => notice(error.message, "bad"));
    $("save-secrets").onclick = () => saveSecrets().catch((error) => notice(error.message, "bad"));
    $("add-api").onclick = addApi;
    $("enable-all-apis").onclick = enableAllDeployments;
    $("add-model").onclick = addModel;
    $("overview-work-tab").onclick = () => setWorkView("overview");
    $("logs-work-tab").onclick = () => setWorkView("logs");
    $("apis-work-tab").onclick = () => setWorkView("apis");
    $("model-select").onchange = (event) => {
      selectedModel = event.target.value;
      renderDashboard();
      renderApis();
    };
    $("provider-openai").onclick = () => { selectedProvider = "openai"; renderCodex({ model_provider: $("codex-state").textContent }); };
    $("provider-relay").onclick = () => { selectedProvider = "relay"; renderCodex({ model_provider: $("codex-state").textContent }); };
    $("apply-provider").onclick = () => applyProvider().catch((error) => notice(error.message, "bad"));
    $("quick-tab").onclick = () => {
      view = "quick";
      $("quick-tab").classList.add("active");
      $("json-tab").classList.remove("active");
      $("quick-panel").classList.remove("hidden");
      $("json-panel").classList.add("hidden");
    };
    $("json-tab").onclick = () => {
      view = "json";
      syncEditorFromConfig();
      $("json-tab").classList.add("active");
      $("quick-tab").classList.remove("active");
      $("json-panel").classList.remove("hidden");
      $("quick-panel").classList.add("hidden");
    };
    $("format-json").onclick = () => {
      try {
        $("json-editor").value = JSON.stringify(JSON.parse($("json-editor").value), null, 2);
        notice("JSON formatted", "good");
      } catch (error) {
        notice(error.message, "bad");
      }
    };

    window.setDeployment = setDeployment;
    window.testDeployment = (index) => runDeploymentTest(index).catch((error) => notice(error.message, "bad"));
    window.onlyDeployment = onlyDeployment;
    window.enableAllDeployments = enableAllDeployments;
    window.removeDeployment = removeDeployment;
    window.showCallDetail = showCallDetail;
    window.setUsageRange = setUsageRange;
    window.loadLogPage = (page) => loadLogPage(page).catch((error) => notice(error.message, "bad"));
    $("close-call-detail").onclick = () => $("call-modal").classList.add("hidden");
    $("call-summary-tab").onclick = () => { callDetailView = "summary"; renderCallDetail(); };
    $("call-json-tab").onclick = () => { callDetailView = "json"; renderCallDetail(); };
    $("call-modal").onclick = (event) => {
      if (event.target.id === "call-modal") {
        $("call-modal").classList.add("hidden");
      }
    };

    if (adminToken) {
      refresh().catch((error) => notice(error.message, "bad"));
    }
  </script>
</body>
</html>`;
}
