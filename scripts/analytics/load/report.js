'use strict';

/**
 * M9-D699 (3.4) — relatório JSON da execução de carga: configuração, percentis, erros e veredito. Sem segredo nem string de conexão;
 * ids só da massa descartável. `renderText` é o resumo legível que o pipeline imprime (aponta o painel ou a consulta responsável).
 */
const fs = require('node:fs');
const path = require('node:path');

function buildReport({ options, seed, verdict, baseline, withBi, panels, extra, startedAt, finishedAt }) {
  return {
    generatedAt: finishedAt, startedAt, scale: options.scale, seed, anchor: options.anchor,
    config: { durationSec: options.durationMs / 1000, rounds: options.rounds, oltpUsers: options.oltpUsers, biUsers: options.biUsers, thinkMs: options.thinkMs, degradationMaxPct: verdict.maxPct },
    massa: extra.massa, baseline, withBi, panels, other: extra.other, verdict,
  };
}

function write(report, file) {
  if (!file) return null;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

function renderText(report) {
  const v = report.verdict;
  const lines = [`Carga do BI: ${v.pass ? 'APROVADA' : 'REPROVADA'} (limite de degradação do fluxo operacional: ${v.maxPct}%)`, '', 'Fluxo operacional (p95 ms): linha de base -> com BI'];
  for (const [op, r] of Object.entries(v.oltp)) lines.push(`  ${op}: ${r.baselineP95} -> ${r.withBiP95} (${r.variationPct === null ? 's/ base' : `${r.variationPct}%`}) ${r.pass ? 'ok' : 'FALHOU'}`);
  lines.push('', 'Painéis (p95 ms / meta):');
  for (const [code, r] of Object.entries(v.panels)) lines.push(`  ${code}: ${r.p95} / ${r.targetMs} ${r.pass ? 'ok' : 'FALHOU'}`);
  lines.push('', `Rebuild sob carga: ${v.rebuild.pass ? 'concluiu e reproduziu o hash' : `FALHOU (${v.rebuild.reason})`}`);
  if (v.failures.length) {
    lines.push('', 'Responsáveis pela reprovação:');
    for (const f of v.failures) lines.push(`  [${f.kind}] ${f.name}: ${f.reason}`);
    if (v.culprit) lines.push(`  painel que mais consumiu tempo de servidor: ${v.culprit.panel}`);
  }
  return lines.join('\n');
}

module.exports = { buildReport, write, renderText };
