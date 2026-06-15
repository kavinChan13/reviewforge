/**
 * Self-contained HTML dashboard for an eval run.
 * Inlines all data + uses Chart.js from a CDN — no build step required.
 * Open the resulting `dashboard.html` in any browser.
 */

import type { AblationRun } from "./report.js";

export function renderDashboard(runs: AblationRun[], generatedAt = new Date()): string {
  const data = JSON.stringify(runs);
  const ts = generatedAt.toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ReviewForge Eval Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box }
    body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; }
    h1 { margin: 0 0 4px; font-weight: 600; letter-spacing: -0.02em; }
    .ts { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; }
    .card h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #c9d1d9; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
    .kpi .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi .value { font-size: 24px; font-weight: 600; margin-top: 6px; }
    .kpi .sub { color: #8b949e; font-size: 12px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #30363d; }
    th { color: #8b949e; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:hover td { background: #1f242c; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    .pill-good { background: #1c6b3a; color: #aff5c4; }
    .pill-bad  { background: #6e1f2e; color: #ffabb6; }
    .pill-meh  { background: #4d3f0a; color: #ffe28a; }
    .severity-critical { color: #ff7b72; font-weight: 600; }
    .severity-high     { color: #ffa657; }
    .severity-medium   { color: #d2a8ff; }
    .severity-low      { color: #79c0ff; }
    canvas { max-height: 280px; }
    details { margin-top: 8px; }
    details summary { cursor: pointer; color: #8b949e; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; overflow: auto; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; }
    select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  </style>
</head>
<body>
  <h1>ReviewForge — Eval Dashboard</h1>
  <div class="ts">Generated ${ts}</div>

  <div class="kpis" id="kpis"></div>

  <div class="grid">
    <div class="card">
      <h2>Recall / Precision / F1 by config</h2>
      <canvas id="rpf"></canvas>
    </div>
    <div class="card">
      <h2>FP per case (lower is better)</h2>
      <canvas id="fp"></canvas>
    </div>
  </div>

  <div class="card" style="margin-top: 24px">
    <h2>Per-config detail</h2>
    <div class="row" style="margin-bottom:12px">
      <label for="cfgsel">config:</label>
      <select id="cfgsel"></select>
    </div>
    <table id="caseTable">
      <thead><tr><th>case</th><th>source</th><th>GT</th><th>findings</th><th>TP</th><th>FP</th><th>FN</th></tr></thead>
      <tbody></tbody>
    </table>
    <details>
      <summary>Per-run breakdown (when --runs > 1)</summary>
      <table id="runTable">
        <thead><tr><th>run</th><th>recall</th><th>precision</th><th>F1</th><th>FP/case</th></tr></thead>
        <tbody></tbody>
      </table>
    </details>
  </div>

<script>
  const RUNS = ${data};
  const fmt = (x) => (x*100).toFixed(1) + '%';

  // KPIs from the "best F1" config.
  const best = [...RUNS].sort((a,b)=> b.aggregate.f1 - a.aggregate.f1)[0];
  const bestM = best?.multiRun;
  const kpis = document.getElementById('kpis');
  function kpi(label, value, sub) {
    return \`<div class="kpi"><div class="label">\${label}</div><div class="value">\${value}</div><div class="sub">\${sub||''}</div></div>\`;
  }
  if (best) {
    kpis.innerHTML = [
      kpi('best config', best.config, bestM ? bestM.runs+' runs' : '1 run'),
      kpi('Recall',
        bestM ? fmt(bestM.recall.mean) : fmt(best.aggregate.recall),
        bestM ? '± '+fmt(bestM.recall.std) : ''),
      kpi('Precision',
        bestM ? fmt(bestM.precision.mean) : fmt(best.aggregate.precision),
        bestM ? '± '+fmt(bestM.precision.std) : ''),
      kpi('F1',
        bestM ? fmt(bestM.f1.mean) : fmt(best.aggregate.f1),
        bestM ? '± '+fmt(bestM.f1.std) : ''),
      kpi('FP / case',
        bestM ? bestM.falsePositivesPerCase.mean.toFixed(2) : best.aggregate.falsePositivesPerCase.toFixed(2),
        bestM ? '± '+bestM.falsePositivesPerCase.std.toFixed(2) : ''),
      kpi('Localization', fmt(best.aggregate.localizationAccuracy)),
    ].join('');
  }

  // Charts.
  const labels = RUNS.map(r => r.config);
  const dataset = (label, key, color) => ({
    label, data: RUNS.map(r => (r.multiRun ? r.multiRun[key].mean : r.aggregate[key]) * 100),
    backgroundColor: color, borderColor: color, borderWidth: 1,
  });
  new Chart(document.getElementById('rpf'), {
    type: 'bar',
    data: { labels, datasets: [
      dataset('Recall', 'recall', '#3fb950'),
      dataset('Precision', 'precision', '#a371f7'),
      dataset('F1', 'f1', '#58a6ff'),
    ]},
    options: { plugins: { legend: { labels: { color:'#e6edf3'}}}, scales: { x: { ticks: { color:'#e6edf3'}}, y: { ticks: { color:'#e6edf3'}, grid: { color:'#30363d' }, max: 100 }}, responsive: true }
  });
  new Chart(document.getElementById('fp'), {
    type: 'bar',
    data: { labels, datasets: [{
      label: 'FP/case', backgroundColor: '#ff7b72',
      data: RUNS.map(r => r.multiRun ? r.multiRun.falsePositivesPerCase.mean : r.aggregate.falsePositivesPerCase)
    }]},
    options: { plugins: { legend: { labels: { color:'#e6edf3'}}}, scales: { x: { ticks: { color:'#e6edf3'}}, y: { ticks: { color:'#e6edf3'}, grid: { color:'#30363d' }, beginAtZero:true }}, responsive: true }
  });

  // Per-config table.
  const sel = document.getElementById('cfgsel');
  RUNS.forEach(r => { const o = document.createElement('option'); o.value = r.config; o.textContent = r.config; sel.appendChild(o); });
  function renderTable(cfg) {
    const r = RUNS.find(x => x.config === cfg);
    const tb = document.querySelector('#caseTable tbody');
    tb.innerHTML = r.perCase.map(c =>
      \`<tr><td>\${c.caseId}</td><td>\${c.labelSource}</td><td>\${c.totalGroundTruth}</td><td>\${c.totalFindings}</td><td>\${c.truePositives}</td><td>\${c.falsePositives}</td><td>\${c.falseNegatives}</td></tr>\`
    ).join('');
    const tr = document.querySelector('#runTable tbody');
    tr.innerHTML = (r.perRunAggregates || []).map((a, i) =>
      \`<tr><td>\${i+1}</td><td>\${fmt(a.recall)}</td><td>\${fmt(a.precision)}</td><td>\${fmt(a.f1)}</td><td>\${a.falsePositivesPerCase.toFixed(2)}</td></tr>\`
    ).join('');
  }
  sel.addEventListener('change', e => renderTable(e.target.value));
  if (RUNS.length) { sel.value = RUNS[0].config; renderTable(RUNS[0].config); }
</script>
</body>
</html>`;
}
