'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { drillFailed } = require('./drill.constants');

/**
 * M9-D442 — relatório do ensaio: uma linha por combinação canal x cenário com o que o livro espera, o que foi obtido e se aprovou. O caso de base (OK) fica à parte, porque
 * não é um dos 12 cenários do livro. Uma divergência qualquer reprova o ensaio inteiro.
 */
const row = (canal, cenario, esperado, ok, obtido) => ({ canal, cenario, esperado, obtido, aprovado: Boolean(ok) });

function newReport(startedAt) {
  return { startedAt: startedAt.toISOString(), finishedAt: null, rows: [], baseline: [] };
}

function finish(report, finishedAt) {
  const approved = report.rows.filter((r) => r.aprovado).length;
  const baselineOk = report.baseline.every((b) => b.aprovado);
  return {
    ...report,
    finishedAt: finishedAt.toISOString(),
    summary: { combinacoes: report.rows.length, aprovadas: approved, reprovadas: report.rows.length - approved, baseReprovadas: report.baseline.filter((b) => !b.aprovado).length },
    passed: report.rows.length > 0 && approved === report.rows.length && baselineOk,
  };
}

/** Reprova (MKT_DRILL_FAILED) quando houve divergência; devolve o relatório quando tudo passou. */
function assertPassed(report) {
  if (report.passed) return report;
  const divergencias = [...report.baseline, ...report.rows].filter((r) => !r.aprovado).map((r) => ({ canal: r.canal, cenario: r.cenario, esperado: r.esperado, obtido: r.obtido }));
  throw drillFailed({ divergencias });
}

const pad = (text, size) => String(text).padEnd(size).slice(0, Math.max(size, String(text).length));

/** Linhas de texto: canal, cenário, aprovado e, nas reprovadas, o esperado e o obtido. */
function toText(report) {
  const lines = [...report.baseline, ...report.rows].map((r) => `${r.aprovado ? 'APROVADO ' : 'REPROVADO'} ${pad(r.canal, 10)} ${pad(r.cenario, 28)} ${r.aprovado ? '' : `esperado: ${r.esperado} | obtido: ${r.obtido}`}`.trimEnd());
  const s = report.summary;
  lines.push(`Combinações: ${s.combinacoes}; aprovadas: ${s.aprovadas}; reprovadas: ${s.reprovadas}; casos de base reprovados: ${s.baseReprovadas}.`);
  lines.push(report.passed ? 'FAILURE DRILL APROVADO' : 'FAILURE DRILL REPROVADO (MKT_DRILL_FAILED: O failure drill encontrou comportamento inesperado no canal.)');
  return lines.join('\n');
}

/** Grava o relatório (JSON) na pasta; devolve o caminho. */
function writeReport(report, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `marketing-drill-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

module.exports = { row, newReport, finish, assertPassed, toText, writeReport };
