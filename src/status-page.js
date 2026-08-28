export function renderStatusPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#173f35">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Codex Relay</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101417;
      --panel: #182024;
      --panel-2: #202a2e;
      --ink: #e8f0eb;
      --muted: #9aa9a2;
      --line: #33433f;
      --mint: #b8f36b;
      --cyan: #81d8d0;
      --amber: #f1b969;
      --red: #f27d72;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 80% 0%, #26352e 0, transparent 34rem), var(--bg);
      color: var(--ink);
      font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 44px 24px 64px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 28px; }
    .eyebrow { color: var(--mint); letter-spacing: .18em; text-transform: uppercase; font-size: 11px; }
    h1 { margin: 8px 0 0; font: 600 clamp(32px, 6vw, 64px)/.98 Georgia, serif; letter-spacing: 0; }
    .lede { max-width: 460px; color: var(--muted); margin: 0; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--mint); margin-right: 8px; box-shadow: 0 0 16px var(--mint); }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 26px 0; }
    .metric, .table-wrap { background: rgba(24, 32, 36, .9); border: 1px solid var(--line); }
    .metric { padding: 18px; min-height: 104px; }
    .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .value { margin-top: 8px; font-size: 27px; color: var(--mint); }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; font-weight: 400; }
    tr:last-child td { border-bottom: 0; }
    .status { display: inline-flex; align-items: center; gap: 7px; }
    .status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); }
    .status.healthy::before { background: var(--mint); }
    .status.cooling_down::before { background: var(--amber); }
    .status.offline::before { background: var(--red); }
    footer { color: var(--muted); margin-top: 18px; font-size: 12px; }
    @media (max-width: 760px) {
      main { padding: 28px 16px 48px; }
      header { display: block; }
      .lede { margin-top: 20px; }
      .grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Codex Relay / Runtime</div>
        <h1><span class="dot"></span>traffic, kept moving.</h1>
      </div>
      <p class="lede">A local OpenAI Responses gateway that keeps provider credentials behind one stable endpoint.</p>
    </header>
    <section class="grid" id="metrics">
      <div class="metric"><div class="label">service</div><div class="value">ready</div></div>
      <div class="metric"><div class="label">deployments</div><div class="value">...</div></div>
      <div class="metric"><div class="label">healthy</div><div class="value">...</div></div>
      <div class="metric"><div class="label">requests</div><div class="value">...</div></div>
    </section>
    <div class="table-wrap">
      <table>
        <thead><tr><th>deployment</th><th>provider</th><th>model</th><th>status</th><th>success / fail</th><th>last issue</th></tr></thead>
        <tbody id="deployments"><tr><td colspan="6">Loading runtime state...</td></tr></tbody>
      </table>
    </div>
    <footer>Public status intentionally omits base URLs and credential material. Refreshes every 5 seconds.</footer>
  </main>
  <script>
    function formatNumber(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric.toLocaleString('en-US') : String(value ?? '0');
    }
    async function refresh() {
      const response = await fetch('/api/status/public');
      const data = await response.json();
      const deployments = data.deployments || [];
      const healthy = deployments.filter(item => item.status === 'healthy').length;
      const values = document.querySelectorAll('.metric .value');
      values[1].textContent = formatNumber(deployments.length);
      values[2].textContent = formatNumber(healthy);
      values[3].textContent = formatNumber(deployments.reduce((sum, item) => sum + item.attempts, 0));
      document.querySelector('#deployments').innerHTML = deployments.map(item => {
        const issue = item.last_error ? item.last_error.code + ' / ' + item.last_error.status : 'none';
        return '<tr>' +
          '<td>' + item.id + '</td>' +
          '<td>' + item.provider + '</td>' +
          '<td>' + item.model + '</td>' +
          '<td><span class="status ' + item.status + '">' + item.status + '</span></td>' +
          '<td>' + formatNumber(item.successes) + ' / ' + formatNumber(item.failures) + '</td>' +
          '<td>' + issue + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="6">No deployments configured.</td></tr>';
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
