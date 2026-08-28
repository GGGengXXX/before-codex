export function renderAdminPage({ bootstrapAdminToken = "", canShutdown = false } = {}) {
  const bootstrapJson = JSON.stringify(bootstrapAdminToken || "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#173f35">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
    button.busy { position: relative; }
    button.busy::before {
      content: "";
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-right: 7px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      vertical-align: -2px;
      animation: button-spin .7s linear infinite;
    }
    @keyframes button-spin { to { transform: rotate(360deg); } }
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
    label.checkbox-row {
      min-height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--field);
      color: var(--ink);
      padding: 7px 9px;
      margin-bottom: 0;
      font-size: 13px;
      letter-spacing: 0;
      text-transform: none;
    }
    .checkbox-row input { margin: 0; accent-color: var(--green); }
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
    .scope-bar { display: grid; grid-template-columns: 150px minmax(220px, 360px) 1fr auto; gap: 10px; align-items: end; padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); }
    .scope-status { min-height: 34px; display: flex; align-items: center; color: var(--muted); font-size: 12px; }
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
    .work { padding: 14px; min-width: 0; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    h2, h3 { margin: 0; font-size: 14px; letter-spacing: .02em; }
    .subtle { color: var(--muted); font-size: 12px; }
    .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 12px 0; }
    .metric { border: 1px solid var(--line); background: var(--panel-2); padding: 10px; border-radius: 6px; min-height: 70px; min-width: 0; }
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
      grid-template-columns: repeat(4, 1fr);
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
    }
    .log-pager {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin-bottom: 10px;
    }
    .log-pager.bottom {
      margin-top: 10px;
      margin-bottom: 0;
    }
    .log-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pager-buttons { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .pager-select {
      width: auto;
      min-width: 84px;
    }
    .estimate-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 0 7px;
      border-radius: 999px;
      border: 1px solid rgba(162, 95, 24, .4);
      background: var(--amber-2);
      color: var(--amber);
      font-size: 11px;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-left: 6px;
    }
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
    .rollout-path { display: block; max-width: min(560px, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help; }
    .token { font-weight: 700; color: var(--blue); white-space: nowrap; }
    .result { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
    .result.success { color: var(--green); }
    .result.failure { color: var(--red); }
    .log-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .session-toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .session-summary { margin-bottom: 12px; }
    .session-list { display: grid; gap: 8px; }
    .session-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, .85fr);
      gap: 14px;
      align-items: center;
      border: 1px solid rgba(14,16,13,.14);
      border-left: 4px solid var(--blue);
      border-radius: 7px;
      background: rgba(255,253,247,.82);
      padding: 12px;
      cursor: pointer;
      min-width: 0;
      overflow: hidden;
      transition: transform .12s ease, border-color .12s ease, background .12s ease;
    }
    .session-row:hover { transform: translateY(-1px); border-color: var(--green); background: var(--panel); }
    .session-row-main, .session-heading { min-width: 0; }
    .session-heading { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
    .session-heading strong {
      min-width: 0;
      overflow: hidden;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .session-heading .pill { flex: 0 0 auto; }
    .session-preview {
      margin-top: 5px;
      color: var(--muted);
      overflow: hidden;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .session-id { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 7px; }
    .session-path { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(70px, 1fr)); gap: 7px; }
    .session-stat { border-left: 1px solid var(--line); padding-left: 10px; min-width: 0; }
    .session-stat label { overflow-wrap: anywhere; }
    .session-stat .value {
      margin-top: 3px;
      font: 700 18px/1.1 Georgia, serif;
      color: var(--green);
      overflow-wrap: anywhere;
    }
    .session-stat .subtle { overflow-wrap: anywhere; }
    .session-call-row { grid-template-columns: minmax(0, 1fr) minmax(110px, auto); }
    .session-call-row > div:last-child { min-width: 0; text-align: right; }
    .session-call-row .token { white-space: normal; overflow-wrap: anywhere; }
    .session-pager { margin-top: 12px; }
    .session-call-list { display: grid; gap: 7px; margin-top: 12px; }
    .session-call-row { cursor: pointer; }
    .session-detail-hero { border-left-color: var(--blue); }
    .session-detail-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .session-detail-stat { border: 1px solid var(--line); border-radius: 7px; background: var(--panel-2); padding: 10px; min-width: 0; }
    .session-detail-stat .value { margin-top: 4px; font: 700 20px/1 Georgia, serif; color: var(--blue); }
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
      width: min(1120px, 100%);
      max-height: min(860px, 92vh);
      overflow: auto;
      border: 1px solid var(--black);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 28px 80px rgba(14,16,13,.25);
      padding: 14px;
    }
    .detail-shell { display: grid; gap: 14px; }
    .detail-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      border-left: 4px solid var(--green);
      background: var(--panel);
      padding: 14px;
    }
    .detail-kicker { color: var(--muted); font: 700 11px/1 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .detail-title { margin: 7px 0 0; font: 700 25px/1.08 Georgia, serif; }
    .detail-subtitle { color: var(--muted); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
    .detail-route { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; color: var(--muted); font-size: 12px; }
    .detail-route strong { color: var(--ink); font-size: 13px; }
    .detail-route-arrow { color: var(--blue); font-weight: 700; }
    .detail-hero-aside { min-width: 160px; padding-left: 14px; border-left: 1px solid var(--line); text-align: right; }
    .detail-stat-label { color: var(--muted); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
    .detail-stat-value { margin-top: 4px; font: 700 22px/1 Georgia, serif; color: var(--blue); }
    .detail-id { margin-top: 12px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .detail-status {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 9px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .detail-status.success { color: var(--green); border-color: rgba(47,111,78,.35); background: var(--green-2); }
    .detail-status.failure { color: var(--red); border-color: rgba(163,59,47,.35); background: #f8e0dc; }
    .detail-token-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .detail-token-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      border-top: 3px solid var(--green);
      padding: 10px 12px 12px;
      min-width: 0;
    }
    .detail-token-card.output { border-top-color: var(--blue); }
    .detail-token-card.total { border-top-color: var(--amber); }
    .detail-token-card .value {
      margin-top: 4px;
      font: 700 24px/1.1 Georgia, serif;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .detail-token-card .subtle { margin-top: 5px; }
    .detail-note {
      border-left: 3px solid var(--amber);
      background: #faf2e3;
      color: var(--amber);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
    }
    .detail-body-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .85fr); gap: 10px; align-items: start; }
    .detail-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      padding: 10px;
      min-width: 0;
    }
    .detail-panel h3 { margin-bottom: 8px; }
    .detail-panel-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .detail-context-list { display: grid; gap: 0; }
    .detail-context-row { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .detail-context-row:last-child { border-bottom: 0; }
    .detail-context-row label { margin: 0; }
    .detail-context-row strong { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
    .detail-extra { display: grid; gap: 8px; margin-top: 10px; }
    .detail-extra-item { padding: 9px 10px; border-left: 3px solid var(--red); background: rgba(248,224,220,.65); border-radius: 5px; }
    .response-box {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      min-height: 120px;
      max-height: 360px;
      overflow: auto;
      padding: 10px;
      font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .response-box.compact { min-height: 160px; }
    .detail-tabs { display: inline-grid; grid-template-columns: repeat(2, 1fr); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
    .detail-tabs button { border: 0; border-radius: 0; background: var(--panel); color: var(--ink); }
    .detail-tabs button.active { background: var(--green); color: #fff; }
    .json-box {
      white-space: pre-wrap;
      overflow: auto;
      max-height: 460px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      padding: 10px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .raw-json-meta { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
    .checkline { display: flex; align-items: center; gap: 7px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .account-form { display: grid; gap: 8px; margin-top: 10px; }
    .account-form .toolbar { margin-top: 0; }
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
      .detail-hero, .detail-token-strip, .detail-body-grid { grid-template-columns: 1fr; }
      .session-row { grid-template-columns: 1fr; }
      .session-toolbar { grid-template-columns: 1fr 1fr; }
      .session-detail-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-hero-aside { border-left: 0; border-top: 1px solid var(--line); padding: 12px 0 0; text-align: left; }
      .topbar { grid-template-columns: 1fr; }
      .scope-bar { grid-template-columns: 1fr 1fr; }
      .scope-status { grid-column: 1 / -1; }
    }
    @media (max-width: 620px) {
      .shell { padding: 14px; }
      .auth { grid-template-columns: 1fr; }
      .scope-bar { grid-template-columns: 1fr; }
      .scope-status { grid-column: auto; }
      .field-grid { grid-template-columns: 1fr; }
      .session-toolbar, .session-detail-summary { grid-template-columns: 1fr; }
      .session-stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .session-stat .value { font-size: 15px; }
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
          <label for="admin-key">Admin/User Token</label>
          <input id="admin-key" type="password" autocomplete="off">
        </div>
        <button id="connect">Connect</button>
      </div>
    </section>

    <div class="toolbar">
      <button id="save">Save + Reload</button>
      <button id="reload" class="secondary">Reload File</button>
      <button id="refresh" class="secondary">Refresh</button>
      <button id="shutdown" class="danger${canShutdown ? "" : " hidden"}" title="Stop the local Relay service">Stop Relay</button>
      <div class="tabs">
        <button id="quick-tab" class="active">Quick</button>
        <button id="json-tab">JSON</button>
      </div>
    </div>
    <div class="scope-bar">
      <div class="field">
        <label for="scope-mode">Apply scope</label>
        <select id="scope-mode">
          <option value="global">Global</option>
          <option value="terminal">Terminal</option>
        </select>
      </div>
      <div class="field scope-session-field">
        <label for="scope-session">Terminal session ID</label>
        <input id="scope-session" list="scope-session-options" placeholder="RELAY_SESSION_ID / iTerm session ID">
        <datalist id="scope-session-options"></datalist>
      </div>
      <div id="scope-status" class="scope-status">Global profile: guest</div>
      <button id="apply-scope" class="secondary">Apply Scope</button>
    </div>
    <div id="notice" class="notice" role="status" aria-live="polite">Idle</div>

    <section class="layout">
      <aside class="rail">
        <div class="section-title">
          <h2>Account</h2>
          <span id="profile-state" class="pill">guest</span>
        </div>
        <div class="toolbar">
          <button id="account-default" class="secondary">Set Default</button>
          <button id="account-delete" class="danger">Delete</button>
          <button id="account-guest" class="ghost">Logout</button>
        </div>
        <div class="account-form">
          <div class="field">
            <label for="account-username">Username</label>
            <input id="account-username" autocomplete="username">
          </div>
          <div class="field">
            <label for="account-password">Password</label>
            <input id="account-password" type="password" autocomplete="current-password">
          </div>
          <div class="toolbar">
            <button id="account-login" class="secondary">Login</button>
            <button id="account-register" class="secondary">Register</button>
          </div>
        </div>
        <div id="profile-path" class="hint">Guest profile</div>
        <div class="divider"></div>
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
            <button id="sessions-work-tab">Sessions</button>
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
          <div id="sessions-panel" class="tab-panel hidden">
          <div class="section-title">
            <div>
              <h2>Sessions</h2>
              <div class="subtle">recent Codex sessions linked to Relay calls</div>
            </div>
            <button id="sessions-refresh" class="secondary">Refresh</button>
          </div>
          <div class="session-toolbar">
            <input id="session-search" type="search" placeholder="Search title, session ID, folder, model...">
            <select id="session-sort" aria-label="Sort sessions">
              <option value="recent">Last used</option>
              <option value="requests">Request count</option>
              <option value="rpm">Requests / min</option>
              <option value="tokens">Token usage</option>
            </select>
            <select id="session-window" aria-label="RPM window">
              <option value="5">5m window</option>
              <option value="15" selected>15m window</option>
              <option value="60">60m window</option>
            </select>
            <button id="session-search-button">Search</button>
          </div>
          <div id="session-summary" class="metrics session-summary"></div>
          <div id="session-list" class="session-list"></div>
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
  <div id="session-modal" class="modal hidden">
    <div class="dialog">
      <div class="section-title">
        <h2 id="session-modal-title">Session Activity</h2>
        <button id="close-session-detail" class="secondary">Close</button>
      </div>
      <div id="session-detail"></div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const bootstrapAdminToken = ${bootstrapJson};
    let guestAdminToken = bootstrapAdminToken || localStorage.getItem("codexRelayAdminKey") || "";
    let userToken = localStorage.getItem("codexRelayUserToken") || "";
    let adminToken = userToken || guestAdminToken;
    let config = null;
    let selectedModel = "";
    let selectedProvider = "";
    let view = "quick";
    const scopeQuery = new URLSearchParams(location.search).get("session") || "";
    let scopeMode = ["global", "terminal"].includes(localStorage.getItem("codexRelayScopeMode") || "")
      ? localStorage.getItem("codexRelayScopeMode")
      : "global";
    let scopeSessionId = scopeQuery || localStorage.getItem("codexRelayScopeSession") || "";
    const savedWorkView = localStorage.getItem("codexRelayWorkView");
    let workView = ["overview", "logs", "sessions", "apis"].includes(savedWorkView) ? savedWorkView : "overview";
    let usageRange = "week";
    const persistedLogPage = Number(localStorage.getItem("codexRelayLogPage") || 0);
    let logPage = Number.isFinite(persistedLogPage) ? Math.max(0, Math.floor(persistedLogPage)) : 0;
    let logPageSize = [10, 20, 50].includes(Number(localStorage.getItem("codexRelayLogPageSize") || 20))
      ? Number(localStorage.getItem("codexRelayLogPageSize") || 20)
      : 20;
    let logTotal = 0;
    let logTotalPages = 1;
    let logCalls = [];
    let logPageLoaded = false;
    let logRequestSequence = 0;
    let logLoading = false;
    let sessionSearch = localStorage.getItem("codexRelaySessionSearch") || "";
    let sessionSort = ["recent", "requests", "rpm", "tokens"].includes(localStorage.getItem("codexRelaySessionSort") || "")
      ? localStorage.getItem("codexRelaySessionSort")
      : "recent";
    let sessionWindow = [5, 15, 60].includes(Number(localStorage.getItem("codexRelaySessionWindow") || 15))
      ? Number(localStorage.getItem("codexRelaySessionWindow") || 15)
      : 15;
    const persistedSessionPage = Number(localStorage.getItem("codexRelaySessionPage") || 0);
    let sessionPage = Number.isFinite(persistedSessionPage) ? Math.max(0, Math.floor(persistedSessionPage)) : 0;
    let sessionPageSize = [10, 20, 50].includes(Number(localStorage.getItem("codexRelaySessionPageSize") || 20))
      ? Number(localStorage.getItem("codexRelaySessionPageSize") || 20)
      : 20;
    let sessionPayload = null;
    let sessionItems = [];
    let sessionLoading = false;
    let sessionRequestSequence = 0;
    let selectedSessionDetail = null;
    let selectedCallDetail = null;
    let callDetailReturnToSession = false;
    let callDetailView = "summary";
    let rawCallDetail = null;
    let rawCallDetailRequestId = null;
    let rawCallDetailLoading = false;
    let runtimeStatus = { deployments: [], recent_calls: [] };
    let profile = { kind: "guest", username: null, can_shutdown: ${canShutdown ? "true" : "false"} };
    const testingDeployments = new Set();
    const busyActions = new Set();
    let logRefreshTimer = null;
    const logRefreshIntervalMs = 15000;

    $("admin-key").value = adminToken;
    if (bootstrapAdminToken) {
      localStorage.setItem("codexRelayAdminKey", bootstrapAdminToken);
      document.querySelector(".auth").classList.add("hidden");
    }

    function setActiveToken(token, { user = false } = {}) {
      adminToken = token || "";
      $("admin-key").value = adminToken;
      if (user) {
        userToken = adminToken;
        if (userToken) {
          localStorage.setItem("codexRelayUserToken", userToken);
        } else {
          localStorage.removeItem("codexRelayUserToken");
        }
      } else {
        guestAdminToken = adminToken;
        if (guestAdminToken) {
          localStorage.setItem("codexRelayAdminKey", guestAdminToken);
        } else {
          localStorage.removeItem("codexRelayAdminKey");
        }
      }
    }

    function persistUiState() {
      localStorage.setItem("codexRelayWorkView", workView);
      localStorage.setItem("codexRelayLogPage", String(logPage));
      localStorage.setItem("codexRelayLogPageSize", String(logPageSize));
      localStorage.setItem("codexRelaySessionSearch", sessionSearch);
      localStorage.setItem("codexRelaySessionSort", sessionSort);
      localStorage.setItem("codexRelaySessionWindow", String(sessionWindow));
      localStorage.setItem("codexRelaySessionPage", String(sessionPage));
      localStorage.setItem("codexRelaySessionPageSize", String(sessionPageSize));
      localStorage.setItem("codexRelayScopeMode", scopeMode);
      localStorage.setItem("codexRelayScopeSession", scopeSessionId);
    }

    function notice(text, kind = "") {
      const element = $("notice");
      element.textContent = text;
      element.className = "notice " + kind;
    }

    function setButtonBusy(buttonId, busy, busyLabel = "Working...") {
      const button = $(buttonId);
      if (!button) return;
      if (busy) {
        if (!button.dataset.idleLabel) {
          button.dataset.idleLabel = button.textContent;
        }
        button.disabled = true;
        button.classList.add("busy");
        button.setAttribute("aria-busy", "true");
        button.textContent = busyLabel;
        return;
      }
      button.disabled = false;
      button.classList.remove("busy");
      button.removeAttribute("aria-busy");
      if (button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
      }
    }

    async function runButtonAction(buttonId, busyLabel, action, options = {}) {
      const lockKey = options.lockKey || buttonId;
      if (busyActions.has(lockKey)) {
        return null;
      }
      busyActions.add(lockKey);
      const relatedButtons = options.relatedButtons || [];
      setButtonBusy(buttonId, true, busyLabel);
      relatedButtons.forEach((id) => {
        const button = $(id);
        if (button) {
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
        }
      });
      if (options.progress) {
        notice(options.progress, "");
      }
      try {
        const result = await action();
        if (options.success) {
          notice(options.success(result), "good");
        }
        return result;
      } catch (error) {
        notice(error.message || String(error), "bad");
        return null;
      } finally {
        setButtonBusy(buttonId, false);
        relatedButtons.forEach((id) => {
          const button = $(id);
          if (button) {
            button.disabled = false;
            button.removeAttribute("aria-busy");
          }
        });
        renderProfile(profile);
        busyActions.delete(lockKey);
      }
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
        const error = new Error(message);
        error.status = response.status;
        throw error;
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

    function formatResponsePreview(value) {
      const text = String(value ?? "");
      const slash = String.fromCharCode(92);
      return text
        .split(slash + "r" + slash + "n").join(String.fromCharCode(13, 10))
        .split(slash + "n").join(String.fromCharCode(10))
        .split(slash + "t").join(String.fromCharCode(9));
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
      $("metric-deployments").textContent = formatInteger(deployments.length);
      $("metric-healthy").textContent = formatInteger(deployments.filter((item) => item.status === "healthy").length);
      $("metric-attempts").textContent = formatInteger(deployments.reduce((sum, item) => sum + item.attempts, 0));
    }

    function formatTime(value) {
      if (!value) return "never";
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }

    function formatInteger(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric.toLocaleString("en-US") : String(value ?? "0");
    }

    function usageIsEstimated(usage) {
      return Boolean(
        usage?.estimated ||
        usage?.estimated_total_tokens ||
        usage?.estimated_calls
      );
    }

    function formatTokens(usage) {
      if (!usage) return "0";
      const total = usage.total_tokens ?? usage.estimated_total_tokens ?? 0;
      return (usageIsEstimated(usage) ? "≈" : "") + formatInteger(total) + " tok";
    }

    function tokenBadge(usage) {
      return usageIsEstimated(usage) ? '<span class="estimate-badge">est</span>' : '';
    }

    function formatUsageValue(value, usage) {
      const numeric = Number(value);
      const safeValue = Number.isFinite(numeric) ? numeric : 0;
      return (usageIsEstimated(usage) ? "≈" : "") + formatInteger(safeValue);
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
            estimatedTokens: usage.estimated_total_tokens || 0,
            calls: usage.calls,
            avgLatency: usage.avg_latency_ms
          };
        }).sort((a, b) => (b.tokens + b.estimatedTokens) - (a.tokens + a.estimatedTokens) || b.calls - a.calls);
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
          estimatedTokens: 0,
          calls: 0,
          latencyTotal: 0,
          latencyCount: 0
        };
        current.deployments += 1;
        current.healthy += deployment.status === "healthy" ? 1 : 0;
        current.successes += deployment.successes || 0;
        current.failures += deployment.failures || 0;
        current.tokens += usage.total_tokens || 0;
        current.estimatedTokens += usage.estimated_total_tokens || 0;
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
          estimatedTokens: 0,
          calls: 0,
          latencyTotal: 0,
          latencyCount: 0
        };
        if (Number.isFinite(call.duration_ms)) {
          current.latencyTotal += call.duration_ms;
          current.latencyCount += 1;
        }
        if (usageIsEstimated(call.usage)) {
          current.estimatedTokens += call.usage.total_tokens || 0;
        }
        stats.set(key, current);
      }
      return [...stats.values()].sort((a, b) => (b.tokens + b.estimatedTokens) - (a.tokens + a.estimatedTokens) || b.calls - a.calls);
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
        acc.estimated_total_tokens += itemUsage.estimated_total_tokens || 0;
        acc.calls += itemUsage.requests || 0;
        return acc;
      }, {
        total_tokens: 0,
        estimated_total_tokens: 0,
        calls: 0,
        failures: calls.filter((item) => item.result === "failure").length,
        avg_latency_ms: 0
      });
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
          return '<div class="bar-wrap" title="' + escapeHtml(item.date + ' · ' + formatInteger(item.total_tokens || 0) + ' tokens') + '">' +
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
            escapeHtml(item.date + ' · ' + formatInteger(tokens) + ' tokens · ' + formatInteger(item.calls || 0) + ' calls') +
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

    function renderLogPager(totalPages, totalCalls, calls, variant = "") {
      const currentPageIndex = Math.min(Math.max(logPage, 0), totalPages - 1);
      const currentPage = currentPageIndex + 1;
      const from = totalCalls ? currentPageIndex * logPageSize + 1 : 0;
      const to = totalCalls ? Math.min(totalCalls, currentPageIndex * logPageSize + calls.length) : 0;
      const pageOptions = [10, 20, 50].map((size) =>
        '<option value="' + size + '"' + (size === logPageSize ? ' selected' : '') + '>' + size + '</option>'
      ).join("");
      return '<div class="log-pager' + (variant ? ' ' + variant : '') + '">' +
        '<div class="log-summary">' +
          '<span class="subtle">Page ' + formatInteger(currentPage) + '/' + formatInteger(totalPages) + ' · ' + formatInteger(from) + '-' + formatInteger(to) + ' of ' + formatInteger(totalCalls) + '</span>' +
          '<label class="subtle" style="margin:0">Rows</label>' +
          '<select class="pager-select" onchange="setLogPageSize(Number(this.value))">' + pageOptions + '</select>' +
        '</div>' +
        '<div class="pager-buttons">' +
          '<button class="secondary" type="button" onclick="loadLogPage(0)" ' + (logLoading || currentPageIndex <= 0 ? "disabled" : "") + '>First</button>' +
          '<button class="secondary" type="button" onclick="loadLogPage(' + (currentPageIndex - 1) + ')" ' + (logLoading || currentPageIndex <= 0 ? "disabled" : "") + '>Prev</button>' +
          '<button class="secondary" type="button" onclick="loadLogPage(' + (currentPageIndex + 1) + ')" ' + (logLoading || currentPageIndex + 1 >= totalPages ? "disabled" : "") + '>Next</button>' +
          '<button class="secondary" type="button" onclick="loadLogPage(' + (totalPages - 1) + ')" ' + (logLoading || currentPageIndex + 1 >= totalPages ? "disabled" : "") + '>Last</button>' +
        '</div>' +
      '</div>';
    }

    function formatRate(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
    }

    function renderSessionPager(payload) {
      const totalPages = Math.max(1, Number(payload?.total_pages) || 1);
      const currentPage = Math.min(Math.max(0, Number(payload?.page) || 0), totalPages - 1);
      const total = Number(payload?.total) || 0;
      const pageSize = Number(payload?.limit) || 20;
      const from = total ? currentPage * pageSize + 1 : 0;
      const to = total ? Math.min(total, currentPage * pageSize + (payload?.sessions?.length || 0)) : 0;
      return '<div class="log-pager session-pager">' +
        '<div class="log-summary"><span class="subtle">Page ' + formatInteger(currentPage + 1) + '/' + formatInteger(totalPages) + ' · ' + formatInteger(from) + '-' + formatInteger(to) + ' of ' + formatInteger(total) + '</span>' +
        '<select class="pager-select" onchange="setSessionPageSize(Number(this.value))">' +
          [10, 20, 50].map((size) => '<option value="' + size + '"' + (size === pageSize ? ' selected' : '') + '>' + size + ' rows</option>').join("") +
        '</select></div>' +
        '<div class="pager-buttons">' +
          '<button class="secondary" type="button" onclick="loadSessions(0)" ' + (sessionLoading || currentPage <= 0 ? "disabled" : "") + '>First</button>' +
          '<button class="secondary" type="button" onclick="loadSessions(' + (currentPage - 1) + ')" ' + (sessionLoading || currentPage <= 0 ? "disabled" : "") + '>Prev</button>' +
          '<button class="secondary" type="button" onclick="loadSessions(' + (currentPage + 1) + ')" ' + (sessionLoading || currentPage + 1 >= totalPages ? "disabled" : "") + '>Next</button>' +
          '<button class="secondary" type="button" onclick="loadSessions(' + (totalPages - 1) + ')" ' + (sessionLoading || currentPage + 1 >= totalPages ? "disabled" : "") + '>Last</button>' +
        '</div>' +
      '</div>';
    }

    function renderSessions() {
      const hasSessionPayload = Boolean(sessionPayload);
      const payload = sessionPayload || {
        sessions: [],
        total: 0,
        total_pages: 1,
        page: 0,
        limit: 20,
        window_minutes: sessionWindow,
        active_sessions: 0,
        requests_last_window: 0,
        aggregate_rpm: 0,
        linked_calls: 0,
        unlinked_calls: 0,
        sqlite_available: null
      };
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      sessionItems = sessions;
      if ($("session-search")) {
        if (document.activeElement !== $("session-search")) {
          $("session-search").value = sessionSearch;
        }
        $("session-sort").value = sessionSort;
        $("session-window").value = String(sessionWindow);
      }
      $("session-summary").innerHTML =
        '<div class="metric"><div class="subtle">active sessions</div><div class="value">' + formatInteger(payload.active_sessions || 0) + '</div></div>' +
        '<div class="metric"><div class="subtle">requests · ' + formatInteger(payload.window_minutes || sessionWindow) + 'm</div><div class="value">' + formatInteger(payload.requests_last_window || 0) + '</div></div>' +
        '<div class="metric"><div class="subtle">aggregate RPM</div><div class="value">' + formatRate(payload.aggregate_rpm) + '</div></div>' +
        '<div class="metric"><div class="subtle">linked calls</div><div class="value">' + formatInteger(payload.linked_calls || 0) + '</div><div class="hint">' + formatInteger(payload.unlinked_calls || 0) + ' unlinked</div></div>';
      const listHtml = sessions.map((session, index) => {
        const active = Number(session.requests_last_window) > 0;
        const preview = session.preview || session.first_user_message || "No preview available";
        const model = session.model || "model not recorded";
        return '<article class="session-row" onclick="showSessionDetail(' + index + ')">' +
          '<div class="session-row-main">' +
            '<div class="session-heading"><strong title="' + escapeHtml(session.title || session.id) + '">' + escapeHtml(session.title || session.id) + '</strong><span class="pill ' + (active ? "on" : "") + '">' + (active ? "active" : "idle") + '</span></div>' +
            '<div class="session-id mono hint" title="' + escapeHtml(session.id) + '">' + escapeHtml(session.id) + '</div>' +
            '<div class="session-preview" title="' + escapeHtml(preview) + '">' + escapeHtml(preview) + '</div>' +
            '<div class="session-meta hint"><span>' + escapeHtml(session.model_provider || "provider unknown") + '</span><span class="mono">' + escapeHtml(model) + '</span><span>' + escapeHtml(formatTime(session.last_active_at)) + '</span><span>' + escapeHtml(session.token_source === "codex_sqlite" ? "Codex tokens" : session.token_source === "both" ? "Codex + Relay" : session.token_source === "relay_usage" ? "Relay tokens" : "no token usage") + '</span></div>' +
            '<div class="session-path hint mono" title="' + escapeHtml(session.rollout_path || "No rollout path linked") + '">' + escapeHtml(session.rollout_path || "rollout · not identified") + '</div>' +
          '</div>' +
          '<div class="session-stat-grid">' +
            '<div class="session-stat"><label>RPM · ' + formatInteger(session.window_minutes || sessionWindow) + 'm</label><div class="value">' + formatRate(session.rpm) + '</div><div class="subtle">' + formatInteger(session.requests_last_window || 0) + ' recent</div></div>' +
            '<div class="session-stat"><label>requests</label><div class="value">' + formatInteger(session.request_count || 0) + '</div><div class="subtle">observed ' + formatRate(session.observed_rpm) + '/min</div></div>' +
            '<div class="session-stat"><label>tokens</label><div class="value">' + formatTokens({ total_tokens: session.total_tokens, estimated: session.estimated }) + '</div><div class="subtle">' + escapeHtml(session.token_source === "codex_sqlite" ? "from Codex state" : session.token_source === "both" ? "Codex + Relay" : formatInteger((session.recent_calls || []).length) + ' shown') + '</div></div>' +
          '</div>' +
        '</article>';
      }).join("");
      $("session-list").innerHTML = (sessionLoading && !sessions.length
        ? '<div class="board-panel"><div class="subtle">Loading session activity...</div></div>'
        : listHtml || '<div class="board-panel"><div class="subtle">No sessions match this search.</div></div>') + renderSessionPager(payload);
      if (hasSessionPayload && payload.sqlite_available === false && !sessionLoading) {
        $("session-list").insertAdjacentHTML("afterbegin", '<div class="detail-note">Codex SQLite was not available. Sessions are shown only when Relay calls include a recognizable thread ID.</div>');
      }
    }

    function renderSessionDetail() {
      const session = selectedSessionDetail;
      if (!session) return;
      const calls = session.recent_calls || [];
      $("session-modal-title").textContent = "Session Activity";
      const callHtml = calls.map((call, index) =>
        '<div class="call-row compact session-call-row" onclick="showSessionCall(' + index + ')">' +
          '<div class="call-main"><strong>' + escapeHtml(callTitle(call)) + '</strong><div class="subtle mono">' + escapeHtml(call.deployment_id || "-") + ' · ' + escapeHtml(call.provider || "-") + '</div><div class="hint">' + escapeHtml(formatTime(call.at)) + ' · ' + escapeHtml(call.request_id || "no request id") + '</div></div>' +
          '<div><div class="result ' + escapeHtml(call.result || "success") + '">' + escapeHtml(call.result || "success") + '</div><div class="token">' + formatTokens(call.usage) + '</div><div class="hint">' + escapeHtml(call.duration_ms ?? "-") + ' ms</div></div>' +
        '</div>'
      ).join("");
      $("session-detail").innerHTML =
        '<div class="detail-shell">' +
          '<div class="detail-hero session-detail-hero"><div><div class="detail-kicker">session activity</div><div class="detail-status ' + (session.requests_last_window ? "success" : "") + '">' + (session.requests_last_window ? "active" : "idle") + '</div><h3 class="detail-title">' + escapeHtml(session.title || session.id) + '</h3><div class="detail-subtitle mono">' + escapeHtml(session.id) + '</div><div class="detail-route"><span>provider</span><strong>' + escapeHtml(session.model_provider || "-") + '</strong><span class="detail-route-arrow">→</span><span>model</span><strong class="mono">' + escapeHtml(session.model || "-") + '</strong></div></div><div class="detail-hero-aside"><div class="detail-stat-label">last active</div><div class="detail-stat-value">' + escapeHtml(formatTime(session.last_active_at)) + '</div><div class="detail-id mono">' + escapeHtml(session.rollout_path || "rollout not identified") + '</div></div></div>' +
          '<div class="session-detail-summary">' +
            '<div class="session-detail-stat"><label>RPM · ' + formatInteger(session.window_minutes || sessionWindow) + 'm</label><div class="value">' + formatRate(session.rpm) + '</div><div class="subtle">fixed window</div></div>' +
            '<div class="session-detail-stat"><label>observed RPM</label><div class="value">' + formatRate(session.observed_rpm) + '</div><div class="subtle">' + formatRate(session.observed_minutes) + ' min span</div></div>' +
            '<div class="session-detail-stat"><label>requests</label><div class="value">' + formatInteger(session.request_count || 0) + '</div><div class="subtle">' + formatInteger(session.requests_last_window || 0) + ' in window</div></div>' +
            '<div class="session-detail-stat"><label>tokens</label><div class="value">' + formatTokens({ total_tokens: session.total_tokens, estimated: session.estimated }) + '</div><div class="subtle">' + (session.estimated ? "estimated" : "upstream usage") + '</div></div>' +
          '</div>' +
          '<div class="detail-panel"><div class="detail-panel-heading"><h3>Recent Relay Requests</h3><span class="subtle">latest ' + formatInteger(calls.length) + '</span></div><div class="session-call-list">' + (callHtml || '<div class="subtle">No Relay calls are linked to this session.</div>') + '</div></div>' +
          '<div class="detail-panel"><div class="detail-panel-heading"><h3>Session Context</h3><span class="subtle">Codex metadata</span></div><div class="detail-context-list"><div class="detail-context-row"><label>rollout</label><strong class="mono">' + escapeHtml(session.rollout_path || "not identified") + '</strong></div><div class="detail-context-row"><label>folder</label><strong class="mono">' + escapeHtml(session.cwd || "-") + '</strong></div><div class="detail-context-row"><label>reasoning</label><strong>' + escapeHtml(session.reasoning_effort || "-") + '</strong></div><div class="detail-context-row"><label>source</label><strong>' + escapeHtml(session.thread_source || "Codex SQLite") + '</strong></div></div></div>' +
        '</div>';
    }

    function showSessionDetail(index) {
      selectedSessionDetail = sessionItems[index];
      if (!selectedSessionDetail) return;
      renderSessionDetail();
      $("session-modal").classList.remove("hidden");
    }

    function showSessionCall(index) {
      const call = selectedSessionDetail?.recent_calls?.[index];
      if (!call) return;
      $("session-modal").classList.add("hidden");
      showCallRecord(call, "Session Request", { returnToSession: true });
    }

    function rolloutPathMarkup(item) {
      if (item.rollout_path) {
        return '<span class="hint mono rollout-path" title="' + escapeHtml(item.rollout_path) + '">rollout · ' + escapeHtml(item.rollout_path) + '</span>';
      }
      return '<span class="hint mono rollout-path" title="The request did not include a recognizable Codex thread id">rollout · not identified</span>';
    }

    function renderDashboard() {
      const calls = logPageLoaded ? logCalls : (runtimeStatus.recent_calls || []);
      const deployments = runtimeStatus.deployments || [];
      const usage = selectedUsage();
      const totals = usage.total || {};
      const comparisonHtml = modelStats().map((item) => {
        const avg = item.avgLatency ?? (item.latencyCount ? Math.round(item.latencyTotal / item.latencyCount) : 0);
        const estimated = item.estimatedTokens > 0;
        return '<div class="usage-row">' +
          '<div class="usage-main">' +
            '<strong>' + escapeHtml(item.model) + '</strong>' +
            '<div class="subtle mono">' + formatInteger(item.healthy) + '/' + formatInteger(item.deployments) + ' healthy · ' + formatInteger(item.successes) + ' ok · ' + formatInteger(item.failures) + ' fail · ' + formatInteger(avg) + 'ms avg</div>' +
          '</div>' +
          '<div class="token">' + formatTokens({ total_tokens: item.tokens, estimated }) + '</div>' + tokenBadge({ estimated }) +
        '</div>';
      }).join("") || '<div class="subtle">No model data yet</div>';
      $("overview-board").innerHTML =
        '<div class="section-title"><div class="range-tabs">' +
          '<button class="' + (usageRange === "week" ? "active" : "") + '" onclick="setUsageRange(\\'week\\')">Week</button>' +
          '<button class="' + (usageRange === "month" ? "active" : "") + '" onclick="setUsageRange(\\'month\\')">Month</button>' +
          '<button class="' + (usageRange === "year" ? "active" : "") + '" onclick="setUsageRange(\\'year\\')">Year</button>' +
        '</div><span class="subtle">persistent usage</span></div>' +
        '<div class="overview-grid">' +
          '<div class="metric"><div class="subtle">tokens</div><div class="value">' + formatTokens(totals) + '</div>' + tokenBadge(totals) + '</div>' +
          '<div class="metric"><div class="subtle">calls</div><div class="value">' + formatInteger(totals.calls || 0) + '</div></div>' +
          '<div class="metric"><div class="subtle">avg latency</div><div class="value">' + formatInteger(totals.avg_latency_ms || 0) + 'ms</div></div>' +
          '<div class="metric"><div class="subtle">failures</div><div class="value">' + formatInteger(totals.failures || 0) + '</div></div>' +
        '</div>' +
        '<div class="board-panel"><div class="section-title"><h3>Token Activity</h3><span class="subtle">' + usageRange + '</span></div>' + renderTokenVisual(usage.buckets) + '</div>' +
        '<div class="divider"></div>' +
        '<div class="board-panel"><div class="section-title"><h3>Model Comparison</h3><span class="subtle">tokens, health, latency</span></div><div class="compare-list">' + comparisonHtml + '</div></div>';

      const totalCalls = logTotal || calls.length;
      const totalPages = Math.max(1, logTotalPages || Math.ceil(totalCalls / logPageSize));
      const logHtml = calls.map((item, index) => {
        const detailAction = item.request_id
          ? 'showCallDetailByRequest(' + escapeHtml(JSON.stringify(item.request_id)) + ')'
          : 'showCallDetail(' + index + ')';
        return '<div class="call-row compact" onclick="' + detailAction + '">' +
          '<div class="call-main">' +
            '<strong>' + escapeHtml(callTitle(item)) + '</strong>' +
            '<div class="subtle mono">' + escapeHtml(item.deployment_id || "-") + ' · ' + escapeHtml(item.provider || "-") + '</div>' +
            '<div class="hint">' + formatTime(item.at) + '</div>' +
            rolloutPathMarkup(item) +
          '</div>' +
          '<div><div class="result ' + escapeHtml(item.result || "success") + '">' + escapeHtml(item.result || "success") + '</div><div class="token">' + formatTokens(item.usage) + '</div>' + tokenBadge(item.usage) + '</div>' +
        '</div>';
      }).join("") || '<div class="subtle">No calls yet</div>';
      const pagerHtml = renderLogPager(totalPages, totalCalls, calls);
      const bottomPagerHtml = renderLogPager(totalPages, totalCalls, calls, "bottom");
      const usageHtml = deployments.map((item) => {
        const usage = item.token_usage || {};
        return '<div class="usage-row">' +
          '<div class="usage-main">' +
            '<strong>' + escapeHtml(item.id) + '</strong>' +
            '<div class="subtle mono">' + escapeHtml(item.model) + ' · ' + escapeHtml(item.status) + '</div>' +
          '</div>' +
          '<div class="token">' + formatTokens(usage) + '</div>' + tokenBadge(usage) +
        '</div>';
      }).join("") || '<div class="subtle">No deployments</div>';
      $("log-list").innerHTML = pagerHtml +
        '<div class="log-items">' + logHtml + '</div>' +
        bottomPagerHtml +
        '<div class="board-panel"><h3>Token Totals</h3><div class="usage-list">' + usageHtml + '</div></div>';
    }

    function showCallDetail(index) {
      const item = (logPageLoaded ? logCalls : runtimeStatus.recent_calls || [])[index];
      if (!item) return;
      showCallRecord(item, "Call Detail");
    }

    function showCallDetailByRequest(requestId) {
      const item = (logPageLoaded ? logCalls : runtimeStatus.recent_calls || [])
        .find((call) => call.request_id === requestId);
      if (!item) return;
      showCallRecord(item, "Call Detail");
    }

    function showCallRecord(item, title = "Call Detail", { returnToSession = false } = {}) {
      selectedCallDetail = item;
      callDetailReturnToSession = returnToSession;
      callDetailView = "summary";
      rawCallDetail = null;
      rawCallDetailRequestId = null;
      rawCallDetailLoading = false;
      $("call-modal-title").textContent = title;
      renderCallDetail();
      $("call-modal").classList.remove("hidden");
    }

    async function loadRawCallDetail(item) {
      const rawId = item.raw_response_id || item.request_id;
      try {
        rawCallDetail = await api("/admin/calls/" + encodeURIComponent(rawId) + "/raw");
      } catch (error) {
        rawCallDetail = { error: error.message };
      } finally {
        rawCallDetailLoading = false;
        if (selectedCallDetail?.request_id === item.request_id && callDetailView === "json") {
          renderCallDetail();
        }
      }
    }

    function renderCallDetail() {
      const item = selectedCallDetail;
      if (!item) return;
      const usage = item.usage || {};
      const estimated = usageIsEstimated(usage);
      $("call-summary-tab").classList.toggle("active", callDetailView === "summary");
      $("call-json-tab").classList.toggle("active", callDetailView === "json");
      if (callDetailView === "json") {
        if (item.raw_response_available && item.request_id) {
          const rawId = item.raw_response_id || item.request_id;
          if (rawCallDetailRequestId !== rawId) {
            rawCallDetailRequestId = rawId;
            rawCallDetailLoading = true;
            rawCallDetail = null;
            $("call-detail").innerHTML = '<div class="detail-note">Loading the original upstream response...</div>';
            loadRawCallDetail(item);
            return;
          }
          if (rawCallDetailLoading) {
            $("call-detail").innerHTML = '<div class="detail-note">Loading the original upstream response...</div>';
            return;
          }
          if (rawCallDetail?.error) {
            $("call-detail").innerHTML = '<div class="detail-note">' + escapeHtml(rawCallDetail.error) + '</div>';
            return;
          }
          const rawContent = rawCallDetail?.is_json
            ? JSON.stringify(rawCallDetail.json, null, 2)
            : (rawCallDetail?.raw_text || "");
          const rawMeta = [
            rawCallDetail?.content_type || "unknown content type",
            rawCallDetail?.stream ? "stream" : "non-stream",
            rawCallDetail?.captured_at ? formatTime(rawCallDetail.captured_at) : ""
          ].filter(Boolean).join(" · ");
          $("call-detail").innerHTML =
            '<div class="raw-json-meta"><span>original upstream response</span><span>' + escapeHtml(rawMeta) + '</span></div>' +
            '<pre class="json-box">' + escapeHtml(rawContent || "<empty response>") + '</pre>';
          return;
        }
        $("call-detail").innerHTML =
          '<div class="detail-note">The full upstream response was not captured for this older call. New calls are loaded on demand from a local protected file.</div>' +
          '<pre class="json-box">' + escapeHtml(JSON.stringify(item, null, 2)) + '</pre>';
        return;
      }
      const estimatedNote = estimated
        ? '<div class="detail-note">Token counts are estimated from captured text because the upstream did not return usage' + (usage.estimated_reason ? ' · ' + escapeHtml(usage.estimated_reason) : '') + '.</div>'
        : '';
      const responseText = formatResponsePreview(item.response_text || "");
      const responseMeta = responseText
        ? responseText.length.toLocaleString() + ' chars · ' + (responseText.split(String.fromCharCode(10)).length).toLocaleString() + ' lines'
        : 'no captured text';
      const extraPanels = [];
      if (item.error) {
        extraPanels.push(
          '<div class="detail-extra-item"><label>error</label><strong>' + escapeHtml(item.error.kind || item.error.code || "-") + '</strong><div class="hint">' + escapeHtml(item.error.message || "") + '</div></div>'
        );
      }
      if (item.warnings?.length) {
        extraPanels.push(
          '<div class="detail-extra-item"><label>warnings</label><div class="hint">' + escapeHtml(item.warnings.join(" · ")) + '</div></div>'
        );
      }
      if (item.diagnostics) {
        extraPanels.push(
          '<div class="detail-extra-item"><label>diagnostics</label><pre class="json-box">' + escapeHtml(JSON.stringify(item.diagnostics, null, 2)) + '</pre></div>'
        );
      }
      $("call-detail").innerHTML =
        '<div class="detail-shell">' +
          '<div class="detail-hero">' +
            '<div>' +
              '<div class="detail-kicker">call detail · ' + escapeHtml(item.provider || "relay") + '</div>' +
              '<div class="detail-status ' + escapeHtml(item.result || "success") + '">' + escapeHtml(item.result || "success") + '</div>' +
              '<h3 class="detail-title">' + escapeHtml(callTitle(item)) + '</h3>' +
              '<div class="detail-route"><span>deployment</span><strong class="mono">' + escapeHtml(item.deployment_id || "-") + '</strong><span class="detail-route-arrow">→</span><span>model</span><strong class="mono">' + escapeHtml(item.upstream_model || "-") + '</strong></div>' +
            '</div>' +
            '<div class="detail-hero-aside">' +
              '<div class="detail-stat-label">duration</div>' +
              '<div class="detail-stat-value">' + escapeHtml(item.duration_ms ?? "-") + ' ms</div>' +
              '<div class="detail-id">' + escapeHtml(formatTime(item.at)) + '<br><span class="mono">' + escapeHtml(item.request_id || "-") + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="detail-token-strip">' +
            '<div class="detail-token-card"><label>input tokens</label><div class="value">' + formatUsageValue(usage.input_tokens, usage) + '</div><div class="subtle">request context</div></div>' +
            '<div class="detail-token-card output"><label>output tokens</label><div class="value">' + formatUsageValue(usage.output_tokens, usage) + '</div><div class="subtle">captured response</div></div>' +
            '<div class="detail-token-card total"><label>total tokens</label><div class="value">' + formatUsageValue(usage.total_tokens ?? usage.estimated_total_tokens, usage) + ' ' + tokenBadge(usage) + '</div><div class="subtle">' + (estimated ? 'trend estimate' : 'upstream reported') + '</div></div>' +
          '</div>' +
          estimatedNote +
          '<div class="detail-body-grid">' +
            '<div class="detail-panel">' +
              '<div class="detail-panel-heading"><h3>Response Preview</h3><span class="subtle">' + responseMeta + '</span></div>' +
              '<div class="response-box compact">' + escapeHtml(responseText || "No response text captured.") + '</div>' +
            '</div>' +
            '<div class="detail-panel">' +
              '<div class="detail-panel-heading"><h3>Request Context</h3><span class="subtle">routing</span></div>' +
              '<div class="detail-context-list">' +
                '<div class="detail-context-row"><label>result</label><strong class="result ' + escapeHtml(item.result || "success") + '">' + escapeHtml(item.result || "success") + '</strong></div>' +
                '<div class="detail-context-row"><label>provider</label><strong>' + escapeHtml(item.provider || "-") + '</strong></div>' +
                '<div class="detail-context-row"><label>requested</label><strong class="mono">' + escapeHtml(item.requested_model || "-") + '</strong></div>' +
                '<div class="detail-context-row"><label>upstream</label><strong class="mono">' + escapeHtml(item.upstream_model || "-") + '</strong></div>' +
                '<div class="detail-context-row"><label>rollout</label><strong class="mono">' + escapeHtml(item.rollout_path || "not identified") + '</strong></div>' +
                '<div class="detail-context-row"><label>raw JSON</label><strong>' + escapeHtml(item.raw_response_available ? "available on demand" : "not captured") + '</strong></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          (extraPanels.length ? '<div class="detail-extra">' + extraPanels.join("") + '</div>' : '') +
        '</div>';
    }

    function syncLogAutoRefresh() {
      if (logRefreshTimer) {
        clearInterval(logRefreshTimer);
        logRefreshTimer = null;
      }
      if (!["logs", "sessions"].includes(workView) || document.hidden) {
        return;
      }
      logRefreshTimer = setInterval(() => {
        if (!["logs", "sessions"].includes(workView) || document.hidden) {
          return;
        }
        if (workView === "logs") {
          requestLogPage(logPage).catch((error) => notice(error.message, "bad"));
        } else {
          requestSessions(sessionPage).catch((error) => notice(error.message, "bad"));
        }
      }, logRefreshIntervalMs);
    }

    function applyWorkViewState() {
      $("overview-work-tab").classList.toggle("active", workView === "overview");
      $("logs-work-tab").classList.toggle("active", workView === "logs");
      $("sessions-work-tab").classList.toggle("active", workView === "sessions");
      $("apis-work-tab").classList.toggle("active", workView === "apis");
      $("overview-panel").classList.toggle("hidden", workView !== "overview");
      $("logs-panel").classList.toggle("hidden", workView !== "logs");
      $("sessions-panel").classList.toggle("hidden", workView !== "sessions");
      $("apis-panel").classList.toggle("hidden", workView !== "apis");
      syncLogAutoRefresh();
    }

    async function requestLogPage(page = 0) {
      const requestedPage = Number(page);
      const safePage = Number.isFinite(requestedPage) ? Math.max(0, Math.floor(requestedPage)) : 0;
      const sequence = ++logRequestSequence;
      logLoading = true;
      renderDashboard();
      try {
        const payload = await api("/admin/calls?offset=" + (safePage * logPageSize) + "&limit=" + logPageSize);
        if (sequence !== logRequestSequence) {
          return;
        }
        const nextPageSize = payload.limit || logPageSize;
        const totalPages = Math.max(
          1,
          Number(payload.total_pages) || Math.ceil((payload.total || 0) / nextPageSize)
        );
        logPageSize = nextPageSize;
        logTotal = Number(payload.total) || 0;
        logTotalPages = totalPages;
        logPage = Math.min(
          Math.max(0, Number(payload.page) || Math.floor((payload.offset || 0) / nextPageSize)),
          totalPages - 1
        );
        logCalls = Array.isArray(payload.calls) ? payload.calls : [];
        logPageLoaded = true;
        persistUiState();
      } finally {
        if (sequence === logRequestSequence) {
          logLoading = false;
          renderDashboard();
        }
      }
    }

    function setLogPageSize(size) {
      const nextSize = [10, 20, 50].includes(size) ? size : 20;
      logPageSize = nextSize;
      persistUiState();
      requestLogPage(0).catch((error) => notice(error.message, "bad"));
    }

    async function requestSessions(page = 0) {
      const requestedPage = Number(page);
      const safePage = Number.isFinite(requestedPage) ? Math.max(0, Math.floor(requestedPage)) : 0;
      const sequence = ++sessionRequestSequence;
      sessionLoading = true;
      renderSessions();
      const params = new URLSearchParams({
        q: sessionSearch,
        sort: sessionSort,
        window: String(sessionWindow),
        offset: String(safePage * sessionPageSize),
        limit: String(sessionPageSize)
      });
      try {
        const payload = await api("/admin/sessions?" + params.toString());
        if (sequence !== sessionRequestSequence) {
          return;
        }
        sessionPayload = payload;
        sessionPage = Number(payload.page) || 0;
        persistUiState();
      } finally {
        if (sequence === sessionRequestSequence) {
          sessionLoading = false;
          renderSessions();
        }
      }
    }

    function setSessionPageSize(size) {
      if (![10, 20, 50].includes(size)) {
        return;
      }
      sessionPageSize = size;
      persistUiState();
      requestSessions(0).catch((error) => notice(error.message, "bad"));
    }

    function searchSessions() {
      sessionSearch = $("session-search").value.trim();
      sessionSort = $("session-sort").value;
      sessionWindow = Number($("session-window").value) || 15;
      sessionPage = 0;
      persistUiState();
      return requestSessions(0);
    }

    function setWorkView(nextView) {
      workView = ["overview", "logs", "sessions", "apis"].includes(nextView) ? nextView : "overview";
      persistUiState();
      applyWorkViewState();
      if (workView === "logs") {
        requestLogPage(logPage).catch((error) => notice(error.message, "bad"));
      }
      if (workView === "sessions") {
        requestSessions(sessionPage).catch((error) => notice(error.message, "bad"));
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

    function renderProfile(nextProfile) {
      profile = nextProfile || { kind: "guest", username: null, can_shutdown: false };
      const label = profile.kind === "account" ? profile.username : "guest";
      $("profile-state").textContent = label || "guest";
      $("profile-state").className = "pill " + (profile.kind === "account" ? "on" : "");
      $("profile-path").textContent = profile.config_path || "Guest profile";
      $("shutdown").classList.toggle("hidden", profile.can_shutdown !== true);
      $("account-default").disabled = profile.kind !== "account";
      $("account-delete").disabled = profile.kind !== "account";
    }

    function renderScope(scope = null) {
      const global = scope?.global || {};
      const sessions = scope?.sessions || [];
      const options = sessions
        .filter((item) => item.session_id)
        .map((item) => '<option value="' + escapeHtml(item.session_id) + '">' + escapeHtml(item.username || "unassigned") + (item.active ? "" : " · revoked") + '</option>')
        .join("");
      $("scope-session-options").innerHTML = options;
      $("scope-mode").value = scopeMode;
      $("scope-session").value = scopeSessionId;
      $("scope-session").disabled = scopeMode !== "terminal";
      const globalLabel = global.kind === "account" ? (global.username || "account") : "guest";
      $("scope-status").textContent = "Global profile: " + globalLabel + (scopeMode === "terminal" ? " · Terminal selected" : "");
    }

    function selectedScope() {
      return scopeMode === "terminal"
        ? { mode: "terminal", session_id: scopeSessionId.trim() }
        : { mode: "global" };
    }

    async function applyScope() {
      if (scopeMode === "terminal" && !scopeSessionId.trim()) {
        throw new Error("Enter a terminal session ID first");
      }
      const payload = await api("/admin/scope", {
        method: "POST",
        body: JSON.stringify(selectedScope())
      });
      persistUiState();
      renderScope(payload.scope);
      notice((scopeMode === "global" ? "Global" : "Terminal") + " scope applied", "good");
      return payload;
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
      if (!deployment) return;
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
      if (field === "enabled") {
        notice((deployment.enabled ? "Enabled " : "Disabled ") + deployment.id + " · save to apply", "good");
      }
    }

    function setDeploymentCompatibility(index, field, value, rerender = false) {
      const deployment = currentModelConfig().deployments[index];
      if (!deployment) return;
      const current = deployment.compatibility && typeof deployment.compatibility === "object" && !Array.isArray(deployment.compatibility)
        ? deployment.compatibility
        : {};
      deployment.compatibility = { ...current, [field]: value };
      syncEditorFromConfig();
      if (rerender) {
        renderApis();
      }
      if (field === "passthrough_provider_state") {
        notice((value ? "Provider state passthrough enabled for " : "Provider state passthrough disabled for ") + deployment.id + " · save to apply", "good");
      }
    }

    function onlyDeployment(index) {
      const deployments = currentModelConfig().deployments;
      const selected = deployments[index];
      if (!selected) return;
      deployments.forEach((deployment, currentIndex) => {
        deployment.enabled = currentIndex === index;
      });
      syncEditorFromConfig();
      renderApis();
      notice("Only " + selected.id + " is enabled for " + selectedModel + " · save to apply", "good");
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
      const deployments = currentModelConfig().deployments;
      const deployment = deployments[index];
      if (!deployment) return;
      if (!confirm("Remove API " + deployment.id + "? Remember to click Save + Reload to apply the change.")) {
        return;
      }
      deployments.splice(index, 1);
      syncEditorFromConfig();
      renderApis();
      notice("Removed " + deployment.id + " · save to apply", "good");
    }

    function input(value, oninput, type = "text") {
      return '<input type="' + type + '" value="' + escapeHtml(value) + '" oninput="' + oninput + '">';
    }

    function missingApiKey(value) {
      const text = String(value || "");
      return !text ||
        text === "missing-user-api-key" ||
        text.startsWith("missing-env:") ||
        text.startsWith("secret:deployment:");
    }

    function apiKeyInput(item, index, live) {
      const missing = missingApiKey(item.api_key);
      const value = missing ? "" : item.api_key;
      const placeholder = live?.credential_configured || !missing ? "configured" : "missing";
      return '<input type="password" value="' + escapeHtml(value) + '" placeholder="' + placeholder + '" oninput="setDeployment(' + index + ', \\'api_key\\', this.value)">';
    }

    function slider(value, oninput, min, max) {
      const numeric = Number(value);
      const safeValue = Number.isFinite(numeric) ? numeric : min;
      return '<div class="slider-row">' +
        '<input type="range" min="' + min + '" max="' + max + '" value="' + safeValue + '" oninput="this.nextElementSibling.textContent = this.value; ' + oninput + '">' +
        '<output>' + safeValue + '</output>' +
      '</div>';
    }

    function checkboxRow(checked, onchange, label) {
      return '<label class="checkbox-row"><input type="checkbox" ' + (checked ? "checked" : "") + ' onchange="' + onchange + '"><span>' + escapeHtml(label) + '</span></label>';
    }

    function renderApis() {
      const list = $("api-list");
      const deployments = currentModelConfig().deployments;
      list.innerHTML = deployments.map((item, index) => {
        const testing = testingDeployments.has(item.id);
        const enabled = item.enabled !== false;
        const live = statusForDeployment(item.id);
        const usage = live.token_usage || {};
        const last = live.last_request;
        const credential = live.credential_configured ?? !missingApiKey(item.api_key);
        const passthroughProviderState = item.compatibility?.passthrough_provider_state === true;
        return '<article class="api-row ' + (enabled ? "" : "disabled") + '">' +
          '<div class="api-head">' +
            '<div class="api-name"><strong>' + escapeHtml(item.id) + '</strong><span class="pill ' + (enabled ? "on" : "") + '">' + (enabled ? "enabled" : "disabled") + '</span><span class="pill">' + escapeHtml(live.status || "new") + '</span><span class="pill ' + (credential ? "on" : "") + '">' + (credential ? "key set" : "missing key") + '</span><span class="pill ' + (passthroughProviderState ? "on" : "") + '">' + (passthroughProviderState ? "state passthrough" : "cleaning on") + '</span></div>' +
            '<div class="row-actions">' +
              '<button class="secondary" onclick="onlyDeployment(' + index + ')">Only This</button>' +
              '<button class="secondary" ' + (testing ? "disabled" : "") + ' onclick="testDeployment(' + index + ')">' + (testing ? "Testing..." : "Test") + '</button>' +
              '<button class="secondary" ' + (testing ? "disabled" : "") + ' onclick="hardTestDeployment(' + index + ')">' + (testing ? "Testing..." : "Hard Test") + '</button>' +
              '<button class="secondary" onclick="setDeployment(' + index + ', \\'enabled\\', ' + (!enabled) + ', true)">' + (enabled ? "Disable" : "Enable") + '</button>' +
              '<button class="danger" onclick="removeDeployment(' + index + ')">Remove</button>' +
            '</div>' +
          '</div>' +
          '<div class="field-grid">' +
            '<div class="field"><label>API</label>' + apiKeyInput(item, index, live) + '<div class="hint">' + (credential ? "private credential" : "set this user\\'s private key") + '</div></div>' +
            '<div class="field"><label>model_provider</label>' + input(item.provider || "", "setDeployment(" + index + ", 'provider', this.value)") + '</div>' +
            '<div class="field"><label>base_url</label>' + input(item.base_url || "", "setDeployment(" + index + ", 'base_url', this.value)") + '</div>' +
            '<div class="field"><label>model</label>' + input(item.model || "", "setDeployment(" + index + ", 'model', this.value)") + '</div>' +
            '<div class="field"><label>id</label>' + input(item.id || "", "setDeployment(" + index + ", 'id', this.value)") + '</div>' +
            '<div class="field"><label>priority</label>' + slider(item.priority ?? 100, "setDeployment(" + index + ", 'priority', this.value)", 1, 100) + '<div class="hint">smaller runs first</div></div>' +
            '<div class="field"><label>weight</label>' + slider(item.weight ?? 1, "setDeployment(" + index + ", 'weight', this.value)", 1, 20) + '<div class="hint">same priority share</div></div>' +
            '<div class="field"><label>provider state</label>' + checkboxRow(passthroughProviderState, "setDeploymentCompatibility(" + index + ", 'passthrough_provider_state', this.checked, true)", "Preserve state") + '<div class="hint">no item cleaning; keep one provider per session</div></div>' +
            '<div class="field"><label>tokens</label><div class="token">' + formatTokens(usage) + '</div><div class="hint">' + formatInteger(usage.requests || 0) + ' successful calls</div></div>' +
            '<div class="field"><label>last model</label><div class="mono">' + escapeHtml(last?.upstream_model || "-") + '</div><div class="hint">' + formatTime(last?.at) + '</div></div>' +
          '</div>' +
        '</article>';
      }).join("") || '<div class="api-row">No APIs</div>';
    }

    function renderAll(payload) {
      config = payload.config;
      renderProfile(payload.profile);
      renderScope(payload.scope);
      runtimeStatus = payload.status || { deployments: [], recent_calls: [] };
      sessionPayload = null;
      sessionItems = [];
      selectedSessionDetail = null;
      selectedModel = selectedModel && config.models[selectedModel] ? selectedModel : models()[0];
      renderMetrics(runtimeStatus);
      renderCodex(payload.codex || {});
      renderSecrets(payload.env || {});
      renderModelSelect();
      renderDashboard();
      renderSessions();
      renderApis();
      syncEditorFromConfig();
      applyWorkViewState();
    }

    async function refresh() {
      const payload = await api("/admin/config");
      renderAll(payload);
      if (workView === "logs") {
        await requestLogPage(logPage);
      }
      if (workView === "sessions") {
        await requestSessions(sessionPage);
      }
      notice("Loaded " + (payload.profile?.username || payload.profile?.kind || "guest") + " · " + payload.config_path, "good");
    }

    async function accountAuth(path) {
      const username = $("account-username").value.trim();
      const password = $("account-password").value;
      if (!username || !password) {
        notice("Username and password are required", "bad");
        return null;
      }
      const payload = await api(path, {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setActiveToken(payload.api_token, { user: true });
      $("account-password").value = "";
      await refresh();
      notice((payload.profile?.username || username) + " active", "good");
      return payload;
    }

    async function setDefaultAccount() {
      await api("/admin/account/default", { method: "POST" });
      notice("Default account updated", "good");
    }

    async function deleteAccount() {
      if (profile.kind !== "account") return;
      const password = $("account-password").value;
      if (!password) {
        notice("Password is required to delete the account", "bad");
        return;
      }
      if (!confirm("Delete account " + profile.username + "?")) {
        return;
      }
      await api("/admin/account/delete", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      $("account-password").value = "";
      await useGuestProfile({ revoke: false });
      notice("Account deleted", "good");
    }

    async function useGuestProfile({ revoke = true } = {}) {
      if (revoke && profile.kind === "account" && userToken) {
        try {
          await api("/admin/account/logout", { method: "POST" });
        } catch (error) {
          if (error.status !== 401) throw error;
        }
      }
      userToken = "";
      localStorage.removeItem("codexRelayUserToken");
      adminToken = guestAdminToken || bootstrapAdminToken || "";
      $("admin-key").value = adminToken;
      if (adminToken) {
        localStorage.setItem("codexRelayAdminKey", adminToken);
        await refresh();
      } else {
        localStorage.removeItem("codexRelayAdminKey");
        renderProfile({ kind: "guest", username: null });
        notice("Guest token cleared. Enter the Admin Key to manage Guest.", "");
      }
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
      const body = { config };
      if (options.applyScope !== false) body.scope = selectedScope();
      const payload = await api("/admin/config", {
        method: "PUT",
        body: JSON.stringify(body)
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

    async function runDeploymentTest(index, mode = "basic") {
      const deployment = currentModelConfig().deployments[index];
      if (!deployment) return;
      if (testingDeployments.has(deployment.id)) return;

      const deploymentId = deployment.id;
      testingDeployments.add(deploymentId);
      renderApis();
      const hard = mode === "hard";
      const label = hard ? "Hard testing " : "Testing ";
      notice(label + deploymentId + (hard ? " (stream/tools/terminal)..." : "..."), "");

      try {
        notice("Saving current config before test...", "");
        await save({ quiet: true, syncProvider: false, applyScope: false });
        notice(label + deploymentId + (hard ? " (stream/tools/terminal)..." : "..."), "");
        const result = await api("/admin/test-deployment", {
          method: "POST",
          body: JSON.stringify({
            deployment_id: deploymentId,
            mode: hard ? "hard" : "basic",
            input: hard ? undefined : "Reply with OK in one short sentence."
          })
        });
        runtimeStatus = result.status || runtimeStatus;
        logCalls = runtimeStatus.recent_calls || logCalls;
        logTotal = Math.max(logTotal, logCalls.length);
        renderMetrics(runtimeStatus);
        renderDashboard();
        renderApis();
        showCallRecord({
          result: result.ok ? "success" : "failure",
          deployment_id: result.deployment_id || deploymentId,
          provider: result.provider,
          request_id: result.request_id,
          requested_model: result.model,
          upstream_model: result.model,
          duration_ms: result.duration_ms,
          usage: result.usage || null,
          response_text: result.response_text,
          error: result.error || null,
          diagnostics: result.diagnostics || null,
          warnings: result.warnings || null,
          at: new Date().toISOString()
        }, hard ? "Hard Test Result" : "Test Result");
        const warningSuffix = result.warnings?.length ? " · warning: " + result.warnings[0] : "";
        notice(
          (result.ok ? (hard ? "Hard test passed: " : "Test passed: ") : (hard ? "Hard test failed: " : "Test failed: "))
            + deploymentId + " · " + (result.duration_ms ?? "-") + "ms" + warningSuffix,
          result.ok ? (result.warnings?.length ? "" : "good") : "bad"
        );
      } catch (error) {
        showCallRecord({
          result: "failure",
          deployment_id: deploymentId,
          response_text: error.message,
          error: { message: error.message },
          at: new Date().toISOString()
        }, mode === "hard" ? "Hard Test Result" : "Test Result");
        notice((mode === "hard" ? "Hard test failed: " : "Test failed: ") + error.message, "bad");
      } finally {
        testingDeployments.delete(deploymentId);
        renderApis();
      }
    }

    async function reloadFile() {
      await api("/admin/reload", { method: "POST" });
      await refresh();
      notice("Reloaded from file", "good");
    }

    async function shutdownRelay() {
      if (busyActions.has("shutdown")) {
        return;
      }
      if (!confirm("Stop the Codex Relay service? You can start it again with npm run start:background.")) {
        return;
      }
      busyActions.add("shutdown");
      const button = $("shutdown");
      button.disabled = true;
      button.classList.add("busy");
      button.setAttribute("aria-busy", "true");
      button.textContent = "Stopping...";
      try {
        await api("/admin/shutdown", { method: "POST" });
        document.querySelectorAll("button, input, select, textarea").forEach((element) => {
          element.disabled = true;
        });
        notice("Relay is shutting down. Start it again with npm run start:background.", "good");
      } catch (error) {
        button.disabled = false;
        button.classList.remove("busy");
        button.removeAttribute("aria-busy");
        button.textContent = "Stop Relay";
        notice(error.message, "bad");
      } finally {
        busyActions.delete("shutdown");
      }
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
      const deploymentId = selectedModel + "-api-" + index;
      model.deployments.push({
        id: deploymentId,
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
      notice("Added " + deploymentId + " · fill in the API details, then save", "good");
    }

    function addModel() {
      let name = prompt("Route name used by Codex", "codex");
      if (!name) {
        notice("Route creation cancelled", "");
        return;
      }
      name = name.trim();
      if (!name) {
        notice("Route name cannot be empty", "bad");
        return;
      }
      config.models[name] ||= { aliases: ["gpt-5-codex"], deployments: [] };
      selectedModel = name;
      renderModelSelect();
      renderApis();
      syncEditorFromConfig();
      notice("Route " + name + " selected · add an API, then save", "good");
    }

    async function applyProvider() {
      const codex = await syncCodexProvider();
      notice(providerNotice(codex), "good");
    }

    $("connect").onclick = () => runButtonAction("connect", "Connecting...", async () => {
      setActiveToken($("admin-key").value.trim(), { user: false });
      return refresh();
    }, { progress: "Connecting to Relay..." });
    $("refresh").onclick = () => runButtonAction("refresh", "Refreshing...", refresh, {
      progress: "Refreshing the current profile..."
    });
    $("save").onclick = () => runButtonAction("save", "Saving...", save, {
      progress: "Saving configuration and reloading Relay..."
    });
    $("reload").onclick = () => runButtonAction("reload", "Reloading...", reloadFile, {
      progress: "Reloading configuration from disk..."
    });
    $("scope-mode").onchange = () => {
      scopeMode = $("scope-mode").value;
      persistUiState();
      renderScope();
    };
    $("scope-session").oninput = () => {
      scopeSessionId = $("scope-session").value;
      persistUiState();
    };
    $("apply-scope").onclick = () => runButtonAction("apply-scope", "Applying...", applyScope, {
      progress: "Applying the selected account scope..."
    });
    $("shutdown").onclick = () => shutdownRelay().catch((error) => notice(error.message, "bad"));
    $("save-secrets").onclick = () => runButtonAction("save-secrets", "Saving...", saveSecrets, {
      progress: "Saving secrets and reloading Relay..."
    });
    $("account-login").onclick = () => runButtonAction("account-login", "Logging in...", () => accountAuth("/admin/account/login"), {
      lockKey: "account-auth",
      relatedButtons: ["account-register"],
      progress: "Signing in..."
    });
    $("account-register").onclick = () => runButtonAction("account-register", "Registering...", () => accountAuth("/admin/account/register"), {
      lockKey: "account-auth",
      relatedButtons: ["account-login"],
      progress: "Creating the account..."
    });
    $("account-default").onclick = () => runButtonAction("account-default", "Setting...", setDefaultAccount, {
      progress: "Updating the default account..."
    });
    $("account-delete").onclick = () => runButtonAction("account-delete", "Deleting...", deleteAccount, {
      progress: "Deleting the account..."
    });
    $("account-guest").onclick = () => runButtonAction("account-guest", "Logging out...", useGuestProfile, {
      progress: "Returning to Guest profile..."
    });
    $("add-api").onclick = () => runButtonAction("add-api", "Adding...", addApi, {
      progress: "Adding a new API route..."
    });
    $("enable-all-apis").onclick = () => runButtonAction("enable-all-apis", "Enabling...", enableAllDeployments, {
      progress: "Enabling all APIs..."
    });
    $("add-model").onclick = () => runButtonAction("add-model", "Adding...", addModel, {
      progress: "Adding a model route..."
    });
    $("overview-work-tab").onclick = () => setWorkView("overview");
    $("logs-work-tab").onclick = () => setWorkView("logs");
    $("sessions-work-tab").onclick = () => setWorkView("sessions");
    $("apis-work-tab").onclick = () => setWorkView("apis");
    $("sessions-refresh").onclick = () => runButtonAction("sessions-refresh", "Refreshing...", () => requestSessions(sessionPage), {
      progress: "Refreshing session activity..."
    });
    $("session-search-button").onclick = () => runButtonAction("session-search-button", "Searching...", searchSessions, {
      progress: "Searching session activity..."
    });
    $("session-sort").onchange = () => runButtonAction("session-search-button", "Searching...", searchSessions, {
      lockKey: "session-search",
      progress: "Updating session sort..."
    });
    $("session-window").onchange = () => runButtonAction("session-search-button", "Searching...", searchSessions, {
      lockKey: "session-search",
      progress: "Updating the RPM window..."
    });
    $("session-search").onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runButtonAction("session-search-button", "Searching...", searchSessions, {
          progress: "Searching session activity..."
        });
      }
    };
    $("model-select").onchange = (event) => {
      selectedModel = event.target.value;
      renderDashboard();
      renderApis();
    };
    $("provider-openai").onclick = () => {
      selectedProvider = "openai";
      renderCodex({ model_provider: $("codex-state").textContent });
      notice("Provider openai selected · click Apply Provider to save", "good");
    };
    $("provider-relay").onclick = () => {
      selectedProvider = "relay";
      renderCodex({ model_provider: $("codex-state").textContent });
      notice("Provider relay selected · click Apply Provider to save", "good");
    };
    $("apply-provider").onclick = () => runButtonAction("apply-provider", "Applying...", applyProvider, {
      progress: "Updating Codex provider and thread state..."
    });
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
    window.setDeploymentCompatibility = setDeploymentCompatibility;
    window.testDeployment = (index) => runDeploymentTest(index).catch((error) => notice(error.message, "bad"));
    window.hardTestDeployment = (index) => runDeploymentTest(index, "hard").catch((error) => notice(error.message, "bad"));
    window.onlyDeployment = onlyDeployment;
    window.enableAllDeployments = enableAllDeployments;
    window.removeDeployment = removeDeployment;
    window.showCallDetail = showCallDetail;
    window.showCallDetailByRequest = showCallDetailByRequest;
    window.showSessionDetail = showSessionDetail;
    window.showSessionCall = showSessionCall;
    window.setUsageRange = setUsageRange;
    window.loadLogPage = (page) => requestLogPage(page).catch((error) => notice(error.message, "bad"));
    window.setLogPageSize = (size) => setLogPageSize(size);
    window.loadSessions = (page) => requestSessions(page).catch((error) => notice(error.message, "bad"));
    window.setSessionPageSize = (size) => setSessionPageSize(size);
    function closeCallDetail() {
      $("call-modal").classList.add("hidden");
      if (callDetailReturnToSession && selectedSessionDetail) {
        renderSessionDetail();
        $("session-modal").classList.remove("hidden");
      }
      callDetailReturnToSession = false;
    }
    $("close-call-detail").onclick = closeCallDetail;
    $("call-summary-tab").onclick = () => { callDetailView = "summary"; renderCallDetail(); };
    $("call-json-tab").onclick = () => { callDetailView = "json"; renderCallDetail(); };
    $("call-modal").onclick = (event) => {
      if (event.target.id === "call-modal") {
        closeCallDetail();
      }
    };
    $("close-session-detail").onclick = () => $("session-modal").classList.add("hidden");
    $("session-modal").onclick = (event) => {
      if (event.target.id === "session-modal") {
        $("session-modal").classList.add("hidden");
      }
    };
    document.addEventListener("visibilitychange", () => {
      syncLogAutoRefresh();
      if (!document.hidden && workView === "logs") {
        requestLogPage(logPage).catch((error) => notice(error.message, "bad"));
      }
      if (!document.hidden && workView === "sessions") {
        requestSessions(sessionPage).catch((error) => notice(error.message, "bad"));
      }
    });

    async function initialRefresh() {
      try {
        await refresh();
      } catch (error) {
        if (userToken) {
          userToken = "";
          localStorage.removeItem("codexRelayUserToken");
          adminToken = guestAdminToken || bootstrapAdminToken || "";
          $("admin-key").value = adminToken;
          if (adminToken) {
            await refresh();
            notice("User session expired. Loaded Guest profile.", "");
            return;
          }
        }
        notice(error.message, "bad");
      }
    }

    if (adminToken) {
      initialRefresh();
    }
  </script>
</body>
</html>`;
}
