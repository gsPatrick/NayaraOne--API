'use strict';

const fs = require('node:fs');
const path = require('node:path');

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Relatório do contract test em JSON (M9-D842 §3.5): totais, operações cobertas e, por exemplo, status, achados e duração. Sem token, conexão ou corpo de resposta. */
function buildReport({ results, coverage, commit, generatedAt = new Date().toISOString() }) {
  const failed = results.filter((item) => !item.ok);
  return {
    generatedAt,
    commit: commit || null,
    ok: failed.length === 0 && coverage.length === 0,
    totals: { examples: results.length, passed: results.length - failed.length, failed: failed.length, coverageFindings: coverage.length },
    operations: [...new Set(results.map((item) => item.example.op))].sort(),
    coverage,
    results: results.map((item) => ({ op: item.example.op, kind: item.example.kind, name: item.example.name, expected: item.example.expect, status: item.status, ok: item.ok, ms: item.ms || 0, findings: item.findings })),
  };
}

/** Mesmo relatório em JUnit XML, para o CI anexar. */
function toJunit(report) {
  const cases = report.results.map((item) => {
    const body = item.ok ? '' : `<failure message="${esc(item.findings.map((f) => `${f.code}: ${f.message}`).join(' | '))}"/>`;
    return `    <testcase classname="${esc(item.op)}" name="${esc(`${item.kind} ${item.name}`)}" time="${(item.ms / 1000).toFixed(3)}">${body}</testcase>`;
  });
  const covers = report.coverage.map((f) => `    <testcase classname="cobertura" name="${esc(f.message)}"><failure message="${esc(`${f.code}: ${f.message}`)}"/></testcase>`);
  const total = cases.length + covers.length;
  const failures = report.totals.failed + covers.length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="contract-tests" tests="${total}" failures="${failures}">\n${[...cases, ...covers].join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

function writeReports(report, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'contract-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'contract-report.junit.xml'), toJunit(report));
}

module.exports = { buildReport, toJunit, writeReports };
