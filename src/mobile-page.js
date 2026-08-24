export function renderMobilePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Codex LAN Desk</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f5f0e5;
      --ink: #131612;
      --muted: #687066;
      --line: #c8bead;
      --panel: #fffdf7;
      --panel-2: #e9e2d2;
      --field: #ffffff;
      --black: #11130f;
      --green: #216548;
      --green-soft: #dcead8;
      --blue: #245e7c;
      --blue-soft: #dcebf0;
      --amber: #9b5d16;
      --amber-soft: #fff0ce;
      --red: #a33a2d;
      --red-soft: #f6ded9;
      --shadow: 0 18px 42px rgba(19, 22, 18, .12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(17,19,15,.045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(17,19,15,.045) 1px, transparent 1px),
        var(--paper);
      background-size: 24px 24px;
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    button {
      min-height: 40px;
      border: 1px solid var(--black);
      border-radius: 7px;
      background: var(--black);
      color: #fff;
      padding: 0 13px;
      cursor: pointer;
      touch-action: manipulation;
    }
    button.secondary { background: var(--panel); color: var(--ink); border-color: var(--line); }
    button.danger { background: var(--red); border-color: var(--red); }
    button:disabled { opacity: .46; cursor: not-allowed; }
    input, select, textarea {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--field);
      color: var(--ink);
      padding: 9px 10px;
      outline: none;
    }
    textarea { min-height: 118px; resize: vertical; }
    textarea.compact { min-height: 88px; }
    input:focus, select:focus, textarea:focus {
      border-color: var(--green);
      box-shadow: 0 0 0 3px var(--green-soft);
    }
    .shell {
      width: min(960px, 100%);
      margin: 0 auto;
      padding: max(16px, env(safe-area-inset-top)) 14px max(18px, env(safe-area-inset-bottom));
    }
    .top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: end;
      border-bottom: 2px solid var(--black);
      padding: 6px 0 14px;
      margin-bottom: 14px;
    }
    h1 {
      margin: 0;
      font: 760 clamp(29px, 10vw, 48px)/.9 Georgia, "Times New Roman", serif;
      letter-spacing: 0;
    }
    h2, h3 { margin: 0; font-size: 14px; }
    label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .stamp {
      align-self: center;
      border: 1px solid var(--black);
      padding: 7px 8px;
      font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,253,247,.96);
      box-shadow: var(--shadow);
      padding: 13px;
      margin-bottom: 12px;
    }
    .login-card { margin-top: 18vh; }
    .grid { display: grid; gap: 10px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .toolbar > button { flex: 1 1 auto; }
    .split-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 10px;
    }
    .subtle { color: var(--muted); font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      max-width: 100%;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-2);
      color: var(--muted);
      padding: 0 8px;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pill.on { border-color: rgba(33,101,72,.4); background: var(--green-soft); color: var(--green); }
    .pill.mid { border-color: rgba(36,94,124,.35); background: var(--blue-soft); color: var(--blue); }
    .pill.warn { border-color: rgba(155,93,22,.35); background: var(--amber-soft); color: var(--amber); }
    .pill.bad { border-color: rgba(163,58,45,.35); background: var(--red-soft); color: var(--red); }
    .notice {
      min-height: 26px;
      color: var(--muted);
      padding: 4px 0 8px;
    }
    .notice.good { color: var(--green); }
    .notice.bad { color: var(--red); }
    .meta-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .metric {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel-2);
      padding: 9px;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font: 750 17px/1.05 Georgia, "Times New Roman", serif;
      color: var(--green);
      overflow-wrap: anywhere;
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .tabs button {
      background: var(--panel);
      color: var(--ink);
      border-color: var(--line);
    }
    .tabs button.active {
      background: var(--black);
      color: #fff;
      border-color: var(--black);
    }
    .status-list, .session-list, .process-list, .job-list, .timeline, .approvals { display: grid; gap: 8px; }
    .row {
      border: 1px solid rgba(17,19,15,.13);
      border-left: 4px solid var(--blue);
      border-radius: 8px;
      background: rgba(255,253,247,.84);
      padding: 10px;
      cursor: pointer;
    }
    .row.active { border-color: var(--green); border-left-color: var(--green); background: var(--panel); }
    .row.warn { border-left-color: var(--amber); }
    .row.bad { border-left-color: var(--red); }
    .row-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
    .row-title {
      min-width: 0;
      font-weight: 750;
      overflow: hidden;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .row-meta {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .status-bar {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .status-cell {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px;
      background: var(--panel-2);
      min-width: 0;
    }
    .status-cell strong {
      display: block;
      margin-top: 4px;
      overflow-wrap: anywhere;
    }
    .detail-grid { display: grid; gap: 12px; }
    .composer {
      position: sticky;
      bottom: max(10px, env(safe-area-inset-bottom));
      z-index: 5;
    }
    .command-box {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      margin-top: 12px;
      background: var(--panel);
    }
    .followup {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .approval {
      border: 1px solid rgba(155,93,22,.45);
      border-left: 4px solid var(--amber);
      border-radius: 8px;
      background: #fff8ea;
      padding: 10px;
    }
    .approval .toolbar > button { min-height: 34px; }
    .event {
      border: 1px solid rgba(17,19,15,.12);
      border-radius: 8px;
      background: #fff;
      padding: 10px;
      overflow: hidden;
    }
    .event.final {
      border-top: 3px solid var(--green);
      background: var(--green-soft);
    }
    .event-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 6px;
    }
    .event pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      max-height: 260px;
      overflow: auto;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .hidden { display: none !important; }
    @media (min-width: 800px) {
      .wide-grid { display: grid; grid-template-columns: .9fr 1.1fr; gap: 12px; align-items: start; }
      .composer { position: static; }
      .detail-grid { grid-template-columns: .9fr 1.1fr; align-items: start; }
    }
    @media (max-width: 520px) {
      .meta-strip, .status-bar { grid-template-columns: 1fr 1fr; }
      .top { grid-template-columns: 1fr; }
      .stamp { width: max-content; }
      .split-toolbar { grid-template-columns: 1fr; }
      .toolbar > button { flex-basis: 100%; }
      .tabs { grid-template-columns: 1fr 1fr 1fr; }
    }
    @media (max-width: 380px) {
      .meta-strip, .status-bar { grid-template-columns: 1fr; }
      .tabs { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="top">
      <h1>Codex LAN Desk</h1>
      <div class="stamp" id="top-stamp">LAN control</div>
    </section>

    <section id="login-view" class="panel login-card">
      <div class="section-title">
        <h2>登录</h2>
        <span class="pill">account</span>
      </div>
      <div class="grid">
        <div>
          <label for="username">Username</label>
          <input id="username" autocomplete="username">
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password">
        </div>
        <button id="login">Enter</button>
      </div>
    </section>

    <section id="app-view" class="hidden">
      <div class="notice" id="notice">Idle</div>
      <div class="meta-strip">
        <div class="metric"><span class="subtle">user</span><strong id="me-user">-</strong></div>
        <div class="metric"><span class="subtle">api</span><strong id="me-api">-</strong></div>
        <div class="metric"><span class="subtle">sessions</span><strong id="me-processes">0</strong></div>
        <div class="metric"><span class="subtle">sandbox</span><strong id="me-sandbox">-</strong></div>
      </div>

      <nav class="tabs" aria-label="mobile workbench">
        <button data-tab="sessions" class="active">Sessions</button>
        <button data-tab="live">Live</button>
        <button data-tab="quick">Quick</button>
      </nav>

      <section id="status-panel" class="panel">
        <div class="section-title">
          <h2>API State</h2>
          <button id="refresh-status" class="secondary">Refresh</button>
        </div>
        <div class="status-bar">
          <div class="status-cell"><span class="subtle">health</span><strong id="api-health">-</strong></div>
          <div class="status-cell"><span class="subtle">deployments</span><strong id="api-deployments">-</strong></div>
          <div class="status-cell"><span class="subtle">models</span><strong id="api-models">-</strong></div>
        </div>
        <div id="deployment-list" class="status-list"></div>
      </section>

      <section id="tab-sessions">
        <div class="wide-grid">
          <section class="panel">
            <div class="section-title">
              <h2>Computer Sessions</h2>
              <span class="pill mid" id="session-total">0</span>
            </div>
            <div class="grid">
              <div class="split-toolbar">
                <div>
                  <label for="session-search">Search</label>
                  <input id="session-search" placeholder="title, cwd, model">
                </div>
                <button id="search-sessions" class="secondary">Search</button>
              </div>
              <div>
                <label for="session-sort">Sort</label>
                <select id="session-sort">
                  <option value="recent">recent</option>
                  <option value="requests">requests</option>
                  <option value="tokens">tokens</option>
                  <option value="rpm">rpm</option>
                </select>
              </div>
              <div id="session-list" class="session-list"></div>
            </div>
          </section>

          <section class="panel">
            <div class="section-title">
              <h2>Background</h2>
              <button id="new-process" class="secondary">New</button>
            </div>
            <div class="grid">
              <div>
                <label for="workspace">Workspace</label>
                <select id="workspace"></select>
              </div>
              <div id="process-list" class="process-list"></div>
            </div>
          </section>
        </div>
      </section>

      <section id="tab-live" class="hidden">
        <section id="process-detail" class="panel hidden">
          <div class="section-title">
            <div>
              <h2 id="process-title">Session</h2>
              <div id="process-meta" class="subtle mono"></div>
            </div>
            <span id="process-status" class="pill">idle</span>
          </div>
          <div class="detail-grid">
            <section>
              <div id="process-approvals" class="approvals hidden"></div>
              <div id="process-final" class="event final hidden"></div>
              <div class="composer command-box">
                <div class="grid">
                  <div>
                    <label for="process-command">Command</label>
                    <textarea id="process-command" class="compact" placeholder="在手机上给这个电脑后台会话下达命令"></textarea>
                  </div>
                  <div class="toolbar">
                    <button id="send-process-command">Send</button>
                    <button id="interrupt-process" class="secondary">Interrupt</button>
                    <button id="stop-process" class="danger">Stop</button>
                  </div>
                </div>
              </div>
            </section>
            <section>
              <div id="process-timeline" class="timeline"></div>
            </section>
          </div>
        </section>
        <section id="process-empty" class="panel">
          <div class="section-title">
            <h2>No Active Session</h2>
            <span class="pill">idle</span>
          </div>
          <div class="subtle">Idle</div>
        </section>
      </section>

      <section id="tab-quick" class="hidden">
        <div class="wide-grid">
          <section class="panel composer">
            <div class="section-title">
              <h2>Quick Run</h2>
              <button id="logout" class="secondary">Logout</button>
            </div>
            <div class="grid">
              <div>
                <label for="backend">Backend</label>
                <select id="backend">
                  <option value="app-server">app-server</option>
                  <option value="exec">exec</option>
                </select>
              </div>
              <div>
                <label for="prompt">Prompt</label>
                <textarea id="prompt" placeholder="告诉 Codex 要做什么"></textarea>
              </div>
              <div class="toolbar">
                <button id="run">Run Codex</button>
                <button id="interrupt" class="danger" disabled>Interrupt</button>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="section-title">
              <h2>Runs</h2>
              <button id="refresh" class="secondary">Refresh</button>
            </div>
            <div id="job-list" class="job-list"></div>
          </section>
        </div>

        <section id="job-detail" class="panel hidden">
          <div class="section-title">
            <div>
              <h2 id="job-title">Run</h2>
              <div id="job-meta" class="subtle mono"></div>
            </div>
            <span id="job-status" class="pill">idle</span>
          </div>
          <div id="job-approvals" class="approvals hidden"></div>
          <div id="job-final" class="event final hidden"></div>
          <div id="followup-panel" class="followup hidden">
            <div>
              <label for="followup">Follow Up</label>
              <textarea id="followup" class="compact" placeholder="继续这个 Codex thread"></textarea>
            </div>
            <div class="toolbar">
              <button id="continue-run">Continue</button>
            </div>
          </div>
          <div id="job-timeline" class="timeline"></div>
        </section>
      </section>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const tokenKey = "codexRelayMobileToken";
    let token = localStorage.getItem(tokenKey) || "";
    let me = null;
    let apiStatus = null;
    let sessions = [];
    let processes = [];
    let jobs = [];
    let selectedProcess = null;
    let selectedJob = null;
    let processStreamAbort = null;
    let jobStreamAbort = null;
    let processLastSequence = 0;
    let jobLastSequence = 0;
    let activeTab = "sessions";

    function notice(text, kind = "") {
      const element = $("notice");
      if (!element) return;
      element.textContent = text;
      element.className = "notice " + kind;
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function statusClass(status) {
      if (["healthy", "ready", "completed", "running", "queued"].includes(status)) return "on";
      if (["starting", "cancelling"].includes(status)) return "warn";
      if (["failed", "cancelled", "stopped", "disabled", "cooling_down", "degraded"].includes(status)) return "bad";
      return "";
    }

    function time(value) {
      if (!value) return "-";
      try {
        return new Date(value).toLocaleString([], {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
      } catch {
        return value;
      }
    }

    function shortPath(value) {
      const text = String(value || "");
      if (text.length <= 54) return text || "-";
      return "..." + text.slice(-51);
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "authorization": "Bearer " + token,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      if (!response.ok) {
        const error = new Error(body?.error?.message || body || response.statusText);
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function showLogin() {
      $("login-view").classList.remove("hidden");
      $("app-view").classList.add("hidden");
    }

    function showApp() {
      $("login-view").classList.add("hidden");
      $("app-view").classList.remove("hidden");
    }

    function setTab(tab) {
      activeTab = tab;
      for (const button of document.querySelectorAll("[data-tab]")) {
        button.classList.toggle("active", button.dataset.tab === tab);
      }
      $("tab-sessions").classList.toggle("hidden", tab !== "sessions");
      $("tab-live").classList.toggle("hidden", tab !== "live");
      $("tab-quick").classList.toggle("hidden", tab !== "quick");
      if (tab === "live") renderProcessDetail();
      if (tab === "quick") renderJobDetail();
    }

    function renderWorkspaceOptions() {
      const roots = me?.options?.workspace_roots || [];
      $("workspace").innerHTML = roots.map((root) =>
        '<option value="' + escapeHtml(root) + '">' + escapeHtml(root) + '</option>'
      ).join("");
    }

    async function login() {
      const username = $("username").value.trim();
      const password = $("password").value;
      $("login").disabled = true;
      try {
        const response = await fetch("/mobile/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body?.error?.message || response.statusText);
        }
        token = body.api_token;
        localStorage.setItem(tokenKey, token);
        await loadDashboard();
        notice("Ready", "good");
      } catch (error) {
        alert(error.message || String(error));
      } finally {
        $("login").disabled = false;
      }
    }

    async function loadDashboard() {
      await loadMe();
      showApp();
      const results = await Promise.allSettled([
        loadStatus(),
        loadSessions(),
        loadProcesses(),
        loadJobs()
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        notice(failed.reason?.message || String(failed.reason), "bad");
      }
    }

    async function loadMe() {
      me = await api("/mobile/api/me");
      $("top-stamp").textContent = me.profile?.username || "LAN control";
      $("me-user").textContent = me.profile?.username || "-";
      $("me-processes").textContent = String(me.active_session_processes || 0);
      $("me-sandbox").textContent = me.options?.default_sandbox || "-";
      $("backend").value = me.options?.execution_backend || "app-server";
      renderWorkspaceOptions();
    }

    async function loadStatus() {
      apiStatus = await api("/mobile/api/status");
      renderStatus();
    }

    function renderStatus() {
      const deployments = apiStatus?.deployments || [];
      const healthy = deployments.filter((item) => item.status === "healthy").length;
      $("me-api").textContent = apiStatus?.status || "-";
      $("api-health").textContent = apiStatus?.status || "-";
      $("api-deployments").textContent = healthy + "/" + deployments.length;
      $("api-models").textContent = (apiStatus?.models || []).join(", ") || "-";
      $("deployment-list").innerHTML = deployments.slice(0, 8).map((deployment) =>
        '<article class="row ' + statusClass(deployment.status) + '">' +
          '<div class="row-head"><div class="row-title">' + escapeHtml(deployment.id) + '</div><span class="pill ' + statusClass(deployment.status) + '">' + escapeHtml(deployment.status) + '</span></div>' +
          '<div class="row-meta mono">' + escapeHtml(deployment.provider || "-") + ' · ' + escapeHtml(deployment.model || "-") + ' · ' + escapeHtml(deployment.base_url || "-") + '</div>' +
        '</article>'
      ).join("") || '<div class="subtle">No deployments</div>';
    }

    async function loadSessions() {
      const query = encodeURIComponent($("session-search")?.value || "");
      const sort = encodeURIComponent($("session-sort")?.value || "recent");
      const payload = await api("/mobile/api/sessions?q=" + query + "&sort=" + sort + "&limit=40");
      sessions = payload.sessions || [];
      processes = payload.processes || processes;
      renderSessions();
      renderProcesses();
    }

    function renderSessions() {
      $("session-total").textContent = String(sessions.length);
      $("session-list").innerHTML = sessions.map((session, index) =>
        '<article class="row session-row" data-index="' + index + '">' +
          '<div class="row-head"><div class="row-title">' + escapeHtml(session.title || session.id) + '</div><span class="pill mid">' + escapeHtml(session.request_count || 0) + ' req</span></div>' +
          '<div class="row-meta">' + escapeHtml(session.preview || session.first_user_message || session.id) + '</div>' +
          '<div class="row-meta mono">' + escapeHtml(time(session.last_active_at)) + ' · ' + escapeHtml(shortPath(session.cwd)) + '</div>' +
        '</article>'
      ).join("") || '<div class="subtle">No sessions found</div>';
      for (const row of document.querySelectorAll(".session-row")) {
        row.onclick = () => startSessionFromIndex(Number(row.dataset.index));
      }
    }

    async function loadProcesses() {
      const payload = await api("/mobile/api/session-processes");
      processes = payload.processes || [];
      renderProcesses();
      if (selectedProcess) {
        const found = processes.find((item) => item.id === selectedProcess.id);
        if (found) selectedProcess = { ...selectedProcess, ...found };
      }
      renderProcessDetail();
    }

    function renderProcesses() {
      $("process-list").innerHTML = processes.map((process, index) =>
        '<article class="row process-row ' + (selectedProcess?.id === process.id ? "active " : "") + statusClass(process.status) + '" data-index="' + index + '">' +
          '<div class="row-head"><div class="row-title">' + escapeHtml(process.title || process.thread_id || process.id) + '</div><span class="pill ' + statusClass(process.status) + '">' + escapeHtml(process.status) + '</span></div>' +
          '<div class="row-meta mono">' + escapeHtml(process.thread_id || "new thread") + ' · ' + escapeHtml(shortPath(process.cwd)) + '</div>' +
        '</article>'
      ).join("") || '<div class="subtle">No background sessions</div>';
      for (const row of document.querySelectorAll(".process-row")) {
        row.onclick = () => {
          const process = processes[Number(row.dataset.index)];
          if (process) selectProcess(process.id);
        };
      }
    }

    async function startSessionFromIndex(index) {
      const session = sessions[index];
      if (!session) return;
      try {
        notice("Starting background session...", "");
        const process = await api("/mobile/api/session-processes", {
          method: "POST",
          body: JSON.stringify({
            thread_id: session.id,
            cwd: session.cwd || $("workspace").value,
            title: session.title || session.id,
            model: session.model || null
          })
        });
        await loadProcesses();
        setTab("live");
        await selectProcess(process.id);
        notice("Background session connected", "good");
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function startEmptyProcess() {
      try {
        notice("Starting new background session...", "");
        const process = await api("/mobile/api/session-processes", {
          method: "POST",
          body: JSON.stringify({
            cwd: $("workspace").value,
            title: "Mobile background session"
          })
        });
        await loadProcesses();
        setTab("live");
        await selectProcess(process.id);
        notice("Background session started", "good");
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function selectProcess(id, options = {}) {
      if (processStreamAbort) {
        processStreamAbort.abort();
        processStreamAbort = null;
      }
      selectedProcess = await api("/mobile/api/session-processes/" + encodeURIComponent(id));
      const events = selectedProcess.events || [];
      processLastSequence = events.length ? events[events.length - 1].sequence : 0;
      renderProcesses();
      renderProcessDetail();
      if (options.stream !== false && !["failed", "stopped"].includes(selectedProcess.status)) {
        streamProcess(id);
      }
    }

    function renderProcessApprovals() {
      const approvals = selectedProcess?.pending_approvals || [];
      $("process-approvals").classList.toggle("hidden", approvals.length === 0);
      $("process-approvals").innerHTML = approvals.map((approval) =>
        '<article class="approval">' +
          '<div class="event-head"><span>' + escapeHtml(approval.type || "approval") + '</span><span>' + escapeHtml(time(approval.created_at)) + '</span></div>' +
          '<pre>' + escapeHtml(approvalTitle(approval)) + '</pre>' +
          '<div class="toolbar">' +
            '<button data-process-approval="' + escapeHtml(approval.id) + '" data-decision="accept">Accept</button>' +
            '<button class="secondary" data-process-approval="' + escapeHtml(approval.id) + '" data-decision="decline">Decline</button>' +
            '<button class="danger" data-process-approval="' + escapeHtml(approval.id) + '" data-decision="cancel">Cancel</button>' +
          '</div>' +
        '</article>'
      ).join("");
      for (const button of document.querySelectorAll("[data-process-approval]")) {
        button.onclick = () => resolveProcessApproval(button.dataset.processApproval, button.dataset.decision);
      }
    }

    function renderProcessDetail() {
      const hasProcess = Boolean(selectedProcess);
      $("process-detail").classList.toggle("hidden", !hasProcess);
      $("process-empty").classList.toggle("hidden", hasProcess);
      if (!hasProcess) return;
      $("process-title").textContent = selectedProcess.title || "Session";
      $("process-meta").textContent = (selectedProcess.thread_id || "new thread") + " · " + (selectedProcess.cwd || "-");
      $("process-status").textContent = selectedProcess.status;
      $("process-status").className = "pill " + statusClass(selectedProcess.status);
      const ready = selectedProcess.status === "ready";
      const running = selectedProcess.status === "running";
      $("send-process-command").disabled = !ready;
      $("interrupt-process").disabled = !running;
      $("stop-process").disabled = ["failed", "stopped"].includes(selectedProcess.status);
      if (selectedProcess.final_response) {
        $("process-final").classList.remove("hidden");
        $("process-final").innerHTML =
          '<div class="event-head"><span>latest response</span><span>' + escapeHtml(time(selectedProcess.updated_at)) + '</span></div>' +
          '<pre>' + escapeHtml(selectedProcess.final_response) + '</pre>';
      } else {
        $("process-final").classList.add("hidden");
      }
      renderProcessApprovals();
      const events = selectedProcess.events || [];
      $("process-timeline").innerHTML = events.slice(-90).reverse().map((event) =>
        '<article class="event">' +
          '<div class="event-head"><span>' + escapeHtml(event.type) + '</span><span>#' + escapeHtml(event.sequence) + ' · ' + escapeHtml(time(event.at)) + '</span></div>' +
          '<pre>' + escapeHtml(eventText(event)) + '</pre>' +
        '</article>'
      ).join("") || '<div class="subtle">Waiting for events...</div>';
    }

    function applyProcessEvent(event) {
      if (!selectedProcess) return;
      selectedProcess.events ||= [];
      if (!selectedProcess.events.some((item) => item.sequence === event.sequence)) {
        selectedProcess.events.push(event);
      }
      processLastSequence = Math.max(processLastSequence, Number(event.sequence) || 0);
      if (event.type === "codex_event") {
        const threadId = extractThreadId(event.payload);
        if (threadId && !selectedProcess.thread_id) selectedProcess.thread_id = threadId;
        const message = extractAgentMessage(event.payload);
        if (message) {
          selectedProcess.final_response = isAgentMessageDelta(event.payload)
            ? (selectedProcess.final_response || "") + message
            : message;
        }
      }
      if (event.type === "session_ready") selectedProcess.status = "ready";
      if (event.type === "command_running") selectedProcess.status = "running";
      if (event.type === "command_completed") selectedProcess.status = "ready";
      if (event.type === "command_failed") selectedProcess.status = "ready";
      if (event.type === "session_stopped") selectedProcess.status = "stopped";
      if (event.type === "session_failed") {
        selectedProcess.status = "failed";
        selectedProcess.error = event.payload?.error || selectedProcess.error;
      }
      if (event.type === "approval_requested") {
        selectedProcess.pending_approvals ||= [];
        if (!selectedProcess.pending_approvals.some((approval) => approval.id === event.payload?.id)) {
          selectedProcess.pending_approvals.push(event.payload);
        }
      }
      if (event.type === "approval_resolved" || event.type === "approval_expired") {
        selectedProcess.pending_approvals = (selectedProcess.pending_approvals || [])
          .filter((approval) => approval.id !== event.payload?.id);
      }
      selectedProcess.updated_at = event.at;
      processes = processes.map((process) => process.id === selectedProcess.id
        ? {
            ...process,
            status: selectedProcess.status,
            thread_id: selectedProcess.thread_id,
            updated_at: selectedProcess.updated_at,
            final_response: selectedProcess.final_response
          }
        : process
      );
      renderProcesses();
      renderProcessDetail();
      if (["session_ready", "command_completed", "command_failed", "session_stopped", "session_failed"].includes(event.type)) {
        loadMe().catch(() => {});
        loadProcesses().catch(() => {});
      }
    }

    async function streamProcess(id) {
      processStreamAbort = new AbortController();
      try {
        const response = await fetch("/mobile/api/session-processes/" + encodeURIComponent(id) + "/events?after=" + processLastSequence, {
          headers: { "authorization": "Bearer " + token },
          signal: processStreamAbort.signal
        });
        if (!response.ok || !response.body) {
          throw new Error("process stream failed");
        }
        await readEventStream(response, applyProcessEvent);
      } catch (error) {
        if (error.name !== "AbortError") {
          notice("Process stream paused; refreshing snapshot", "");
          if (selectedProcess?.id === id) {
            await selectProcess(id, { stream: false }).catch(() => {});
          }
        }
      }
    }

    async function sendProcessCommand() {
      if (!selectedProcess) return;
      const prompt = $("process-command").value.trim();
      if (!prompt) {
        notice("Command is empty", "bad");
        return;
      }
      $("send-process-command").disabled = true;
      try {
        selectedProcess = await api("/mobile/api/session-processes/" + encodeURIComponent(selectedProcess.id) + "/commands", {
          method: "POST",
          body: JSON.stringify({ prompt })
        });
        $("process-command").value = "";
        renderProcessDetail();
        notice("Command sent", "good");
      } catch (error) {
        notice(error.message || String(error), "bad");
      } finally {
        renderProcessDetail();
      }
    }

    async function interruptProcess() {
      if (!selectedProcess) return;
      try {
        selectedProcess = await api("/mobile/api/session-processes/" + encodeURIComponent(selectedProcess.id) + "/interrupt", {
          method: "POST",
          body: JSON.stringify({})
        });
        renderProcessDetail();
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function stopProcess() {
      if (!selectedProcess) return;
      try {
        selectedProcess = await api("/mobile/api/session-processes/" + encodeURIComponent(selectedProcess.id) + "/stop", {
          method: "POST",
          body: JSON.stringify({})
        });
        renderProcessDetail();
        await loadProcesses();
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function resolveProcessApproval(approvalId, decision) {
      if (!selectedProcess) return;
      try {
        selectedProcess = await api("/mobile/api/session-processes/" + encodeURIComponent(selectedProcess.id) + "/approvals/" + encodeURIComponent(approvalId), {
          method: "POST",
          body: JSON.stringify({ decision })
        });
        renderProcessDetail();
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function loadJobs() {
      const payload = await api("/mobile/api/jobs");
      jobs = payload.jobs || [];
      renderJobs();
      if (selectedJob) {
        const fresh = jobs.find((job) => job.id === selectedJob.id);
        if (fresh) {
          await selectJob(fresh.id, { stream: false });
        }
      }
    }

    function renderJobs() {
      $("job-list").innerHTML = jobs.map((job, index) =>
        '<article class="row job-row ' + (selectedJob?.id === job.id ? "active " : "") + statusClass(job.status) + '" data-index="' + index + '">' +
          '<div class="row-head"><div class="row-title">' + escapeHtml(job.title || job.prompt) + '</div><span class="pill ' + statusClass(job.status) + '">' + escapeHtml(job.status) + '</span></div>' +
          '<div class="row-meta mono">' + escapeHtml(time(job.started_at)) + ' · ' + escapeHtml(job.backend || "exec") + ' · ' + escapeHtml(shortPath(job.cwd)) + '</div>' +
        '</article>'
      ).join("") || '<div class="subtle">No runs yet</div>';
      for (const row of document.querySelectorAll(".job-row")) {
        row.onclick = () => {
          const job = jobs[Number(row.dataset.index)];
          if (job) selectJob(job.id);
        };
      }
    }

    function eventText(event) {
      if (event.type === "stderr" || event.type === "stdout") {
        return event.payload?.text || "";
      }
      if (event.type === "codex_event") {
        const payload = event.payload || {};
        const item = payload.item || payload.params?.item || null;
        if (item?.text) return item.text;
        if (payload.delta) return payload.delta;
        if (payload.params?.delta) return payload.params.delta;
        if (payload.message) return payload.message;
        return JSON.stringify(payload, null, 2);
      }
      return event.summary || JSON.stringify(event.payload || {}, null, 2);
    }

    function approvalTitle(approval) {
      if (approval.type === "command") return approval.command || "Command approval";
      if (approval.type === "file_change") return approval.reason || "File change approval";
      if (approval.type === "permissions") return approval.reason || "Permission request";
      return approval.method || "Approval";
    }

    function extractThreadId(payload) {
      return payload?.thread_id
        || payload?.threadId
        || payload?.thread?.id
        || payload?.params?.thread_id
        || payload?.params?.threadId
        || payload?.params?.thread?.id
        || "";
    }

    function extractAgentMessage(payload) {
      if (!payload || typeof payload !== "object") return "";
      const type = payload.type || payload.event || payload.method || "";
      if (type === "agent_message_delta" || type === "item/agentMessage/delta") {
        return payload.delta || payload.text || payload.params?.delta || "";
      }
      const item = payload.item || payload.params?.item || null;
      if (item?.type === "agent_message" || item?.type === "agentMessage") {
        return item.text || "";
      }
      if (type === "agent_message" || type === "agentMessage") {
        return payload.text || payload.params?.text || "";
      }
      return "";
    }

    function isAgentMessageDelta(payload) {
      const type = payload?.type || payload?.event || payload?.method || "";
      return type === "agent_message_delta" || type === "item/agentMessage/delta";
    }

    function canContinueSelected() {
      return Boolean(selectedJob?.thread_id && !["queued", "running", "cancelling"].includes(selectedJob.status));
    }

    function renderJobApprovals() {
      const approvals = selectedJob?.pending_approvals || [];
      $("job-approvals").classList.toggle("hidden", approvals.length === 0);
      $("job-approvals").innerHTML = approvals.map((approval) =>
        '<article class="approval">' +
          '<div class="event-head"><span>' + escapeHtml(approval.type || "approval") + '</span><span>' + escapeHtml(time(approval.created_at)) + '</span></div>' +
          '<pre>' + escapeHtml(approvalTitle(approval)) + '</pre>' +
          '<div class="toolbar">' +
            '<button data-job-approval="' + escapeHtml(approval.id) + '" data-decision="accept">Accept</button>' +
            '<button class="secondary" data-job-approval="' + escapeHtml(approval.id) + '" data-decision="decline">Decline</button>' +
            '<button class="danger" data-job-approval="' + escapeHtml(approval.id) + '" data-decision="cancel">Cancel</button>' +
          '</div>' +
        '</article>'
      ).join("");
      for (const button of document.querySelectorAll("[data-job-approval]")) {
        button.onclick = () => resolveJobApproval(button.dataset.jobApproval, button.dataset.decision);
      }
    }

    function syncSelectedJobSummary() {
      if (!selectedJob) return;
      jobs = jobs.map((job) => job.id === selectedJob.id
        ? {
            ...job,
            status: selectedJob.status,
            thread_id: selectedJob.thread_id,
            updated_at: selectedJob.updated_at,
            completed_at: selectedJob.completed_at,
            final_response: selectedJob.final_response
          }
        : job
      );
    }

    function renderJobDetail() {
      if (!selectedJob) {
        $("job-detail").classList.add("hidden");
        return;
      }
      $("job-detail").classList.remove("hidden");
      $("job-title").textContent = selectedJob.title || "Run";
      $("job-meta").textContent = (selectedJob.thread_id || "new thread") + " · " + (selectedJob.backend || "exec") + " · " + (selectedJob.cwd || "-");
      $("job-status").textContent = selectedJob.status;
      $("job-status").className = "pill " + statusClass(selectedJob.status);
      $("interrupt").disabled = !["queued", "running"].includes(selectedJob.status);
      $("followup-panel").classList.toggle("hidden", !selectedJob.thread_id);
      $("continue-run").disabled = !canContinueSelected();
      if (selectedJob.final_response) {
        $("job-final").classList.remove("hidden");
        $("job-final").innerHTML =
          '<div class="event-head"><span>final</span><span>' + escapeHtml(time(selectedJob.completed_at || selectedJob.updated_at)) + '</span></div>' +
          '<pre>' + escapeHtml(selectedJob.final_response) + '</pre>';
      } else {
        $("job-final").classList.add("hidden");
      }
      renderJobApprovals();
      const events = selectedJob.events || [];
      $("job-timeline").innerHTML = events.slice(-80).reverse().map((event) =>
        '<article class="event">' +
          '<div class="event-head"><span>' + escapeHtml(event.type) + '</span><span>#' + escapeHtml(event.sequence) + ' · ' + escapeHtml(time(event.at)) + '</span></div>' +
          '<pre>' + escapeHtml(eventText(event)) + '</pre>' +
        '</article>'
      ).join("") || '<div class="subtle">Waiting for events...</div>';
      renderJobs();
    }

    async function selectJob(id, options = {}) {
      if (jobStreamAbort) {
        jobStreamAbort.abort();
        jobStreamAbort = null;
      }
      selectedJob = await api("/mobile/api/jobs/" + encodeURIComponent(id));
      const events = selectedJob.events || [];
      jobLastSequence = events.length ? events[events.length - 1].sequence : 0;
      renderJobDetail();
      if (options.stream !== false && ["queued", "running"].includes(selectedJob.status)) {
        streamJob(id);
      }
    }

    function applyJobEvent(event) {
      if (!selectedJob) return;
      selectedJob.events ||= [];
      if (!selectedJob.events.some((item) => item.sequence === event.sequence)) {
        selectedJob.events.push(event);
      }
      jobLastSequence = Math.max(jobLastSequence, Number(event.sequence) || 0);
      if (event.type === "codex_event") {
        const threadId = extractThreadId(event.payload);
        if (threadId && !selectedJob.thread_id) selectedJob.thread_id = threadId;
        const message = extractAgentMessage(event.payload);
        if (message) {
          selectedJob.final_response = isAgentMessageDelta(event.payload)
            ? (selectedJob.final_response || "") + message
            : message;
        }
      }
      if (event.type === "approval_requested") {
        selectedJob.pending_approvals ||= [];
        if (!selectedJob.pending_approvals.some((approval) => approval.id === event.payload?.id)) {
          selectedJob.pending_approvals.push(event.payload);
        }
      }
      if (event.type === "approval_resolved" || event.type === "approval_expired") {
        selectedJob.pending_approvals = (selectedJob.pending_approvals || [])
          .filter((approval) => approval.id !== event.payload?.id);
      }
      if (event.type === "job_started") selectedJob.status = "running";
      if (event.type === "job_completed") {
        selectedJob.status = "completed";
        selectedJob.completed_at = event.at;
        loadMe().catch(() => {});
      }
      if (event.type === "job_failed") {
        selectedJob.status = "failed";
        selectedJob.completed_at = event.at;
        loadMe().catch(() => {});
      }
      if (event.type === "job_cancelled") {
        selectedJob.status = "cancelled";
        selectedJob.completed_at = event.at;
        loadMe().catch(() => {});
      }
      if (event.type === "job_cancelling") selectedJob.status = "cancelling";
      selectedJob.updated_at = event.at;
      syncSelectedJobSummary();
      renderJobDetail();
    }

    async function readEventStream(response, applyEvent) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const chunks = buffer.split("\\n\\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          const lines = chunk.split("\\n").filter((line) => line.startsWith("data: "));
          if (!lines.length) continue;
          const event = JSON.parse(lines.map((line) => line.slice(6)).join("\\n"));
          applyEvent(event);
        }
      }
    }

    async function streamJob(id) {
      jobStreamAbort = new AbortController();
      try {
        const response = await fetch("/mobile/api/jobs/" + encodeURIComponent(id) + "/events?after=" + jobLastSequence, {
          headers: { "authorization": "Bearer " + token },
          signal: jobStreamAbort.signal
        });
        if (!response.ok || !response.body) {
          throw new Error("job stream failed");
        }
        await readEventStream(response, applyJobEvent);
      } catch (error) {
        if (error.name !== "AbortError") {
          notice("Job stream paused; refreshing snapshot", "");
          await loadJobs().catch(() => {});
        }
      }
    }

    async function startRun() {
      const prompt = $("prompt").value.trim();
      if (!prompt) {
        notice("Prompt is empty", "bad");
        return;
      }
      $("run").disabled = true;
      try {
        const job = await api("/mobile/api/jobs", {
          method: "POST",
          body: JSON.stringify({
            prompt,
            cwd: $("workspace").value,
            backend: $("backend").value
          })
        });
        $("prompt").value = "";
        await loadMe();
        await loadJobs();
        await selectJob(job.id);
        notice("Run started", "good");
      } catch (error) {
        notice(error.message || String(error), "bad");
      } finally {
        $("run").disabled = false;
      }
    }

    async function continueRun() {
      if (!canContinueSelected()) return;
      const prompt = $("followup").value.trim();
      if (!prompt) {
        notice("Follow-up is empty", "bad");
        return;
      }
      $("continue-run").disabled = true;
      try {
        const job = await api("/mobile/api/jobs", {
          method: "POST",
          body: JSON.stringify({
            prompt,
            cwd: selectedJob.cwd || $("workspace").value,
            thread_id: selectedJob.thread_id,
            backend: selectedJob.backend || $("backend").value,
            title: prompt
          })
        });
        $("followup").value = "";
        await loadMe();
        await loadJobs();
        await selectJob(job.id);
        notice("Thread continued", "good");
      } catch (error) {
        notice(error.message || String(error), "bad");
      } finally {
        $("continue-run").disabled = !canContinueSelected();
      }
    }

    async function resolveJobApproval(approvalId, decision) {
      if (!selectedJob) return;
      try {
        selectedJob = await api("/mobile/api/jobs/" + encodeURIComponent(selectedJob.id) + "/approvals/" + encodeURIComponent(approvalId), {
          method: "POST",
          body: JSON.stringify({ decision })
        });
        renderJobDetail();
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function interruptRun() {
      if (!selectedJob) return;
      $("interrupt").disabled = true;
      try {
        selectedJob = await api("/mobile/api/jobs/" + encodeURIComponent(selectedJob.id) + "/interrupt", {
          method: "POST",
          body: JSON.stringify({})
        });
        renderJobDetail();
      } catch (error) {
        notice(error.message || String(error), "bad");
      }
    }

    async function logout({ revoke = true } = {}) {
      if (processStreamAbort) processStreamAbort.abort();
      if (jobStreamAbort) jobStreamAbort.abort();
      if (revoke && token) {
        try {
          await api("/mobile/logout", { method: "POST", body: JSON.stringify({}) });
        } catch (error) {
          if (error.status !== 401) {
            notice(error.message || String(error), "bad");
            return;
          }
        }
      }
      token = "";
      localStorage.removeItem(tokenKey);
      showLogin();
    }

    $("login").onclick = login;
    $("password").onkeydown = (event) => { if (event.key === "Enter") login(); };
    $("refresh-status").onclick = async () => {
      await loadStatus().catch((error) => notice(error.message || String(error), "bad"));
    };
    $("search-sessions").onclick = async () => {
      await loadSessions().catch((error) => notice(error.message || String(error), "bad"));
    };
    $("session-search").onkeydown = (event) => {
      if (event.key === "Enter") loadSessions().catch((error) => notice(error.message || String(error), "bad"));
    };
    $("session-sort").onchange = () => loadSessions().catch((error) => notice(error.message || String(error), "bad"));
    $("new-process").onclick = startEmptyProcess;
    $("send-process-command").onclick = sendProcessCommand;
    $("interrupt-process").onclick = interruptProcess;
    $("stop-process").onclick = stopProcess;
    $("run").onclick = startRun;
    $("continue-run").onclick = continueRun;
    $("interrupt").onclick = interruptRun;
    $("refresh").onclick = async () => {
      await loadMe();
      await loadStatus().catch(() => {});
      await loadProcesses().catch(() => {});
      await loadJobs();
    };
    $("logout").onclick = () => logout();
    for (const button of document.querySelectorAll("[data-tab]")) {
      button.onclick = () => setTab(button.dataset.tab);
    }

    (async () => {
      if (!token) {
        showLogin();
        return;
      }
      try {
        await loadDashboard();
      } catch {
        logout({ revoke: false });
      }
    })();
  </script>
</body>
</html>`;
}
