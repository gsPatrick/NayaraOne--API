'use strict';

// M9-D811 — o portão passa no repositório real, todo indicador do catálogo declara a área e o CI executa o comando em todo pull request.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listCriticalityRows } = require('../../../src/features/analytics/metrics/seed/criticality.table');
const { AREAS, MANDATORY_AREAS } = require('../../../src/features/core-governance/lineage/lineage.constants');

const ROOT = path.join(__dirname, '../../..');

test('m9d811 todo indicador do catálogo declara a área e a área obrigatória implica crítico', () => {
  for (const row of listCriticalityRows()) {
    assert.ok(AREAS.includes(row.area), `${row.code}: área ${row.area}`);
    if (row.criticality === 'CRITICAL') assert.notEqual(row.area, 'OTHER', `${row.code} crítico não pode ter área OTHER`);
  }
  assert.ok(listCriticalityRows().some((row) => MANDATORY_AREAS.includes(row.area) && row.criticality === 'NORMAL'), 'área obrigatória vale mesmo quando a tabela do BI diz NORMAL');
});

test('m9d811 npm run check:lineage passa no repositório com cobertura crítica total', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/checkLineageCoverage.js')], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /covered=(\d+)\/\1 percent=100/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['check:lineage'], 'node scripts/checkLineageCoverage.js');
});

test('m9d811 o CI executa o portão em todo pull request e o runbook o descreve', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.match(wf, /npm run check:lineage/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/runbooks/CI_CD.md'), 'utf8'), /check:lineage/);
  assert.ok(/^on:[\s\S]*?pull_request/m.test(wf), 'o workflow roda em pull request');
});

test('m9d811 um indicador novo com área obrigatória e sem lineage reprova o portão do repositório', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-ci-'));
  const catalog = path.join(dir, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify([...listCriticalityRows().map((r) => ({ code: r.code, criticality: r.criticality, area: r.area })), { code: 'EXEC_NOI', criticality: 'NORMAL', area: 'EXEC_KPI' }]));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/checkLineageCoverage.js'), '--catalog', catalog], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /KPI crítico sem lineage: EXEC_NOI\./);
});
