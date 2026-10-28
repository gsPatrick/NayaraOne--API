'use strict';

// M9-D700 — cache e NAY não contornam a permissão: varredura estática do código (sem banco).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scanSource, scanRepo } = require('../../../scripts/lib/analyticsReadScan');
const { buildCacheKey } = require('../../../src/features/analytics/security');

const ROOT = path.join(__dirname, '..', '..', '..');

test('m9d700 cache e NAY não contornam a permissão (varredura de rotas e ferramentas)', () => {
  const violacoes = scanRepo(ROOT);
  assert.deepEqual(violacoes, [], `caminhos que leem o BI sem passar pelo serviço de permissão:\n${violacoes.map((v) => `${v.rule} ${v.file}: ${v.message}`).join('\n')}`);
});

test('m9d700 a varredura reprova os caminhos de contorno (fixtures)', () => {
  const sql = "await sequelize.query('SELECT * FROM analytics.rm_finance_health');";
  assert.equal(scanSource('src/features/ai/tools/x.js', sql).map((v) => v.rule).sort().join(), 'R1,R3');
  assert.equal(scanSource('src/features/ai/tools/x.js', "q('SELECT 1 FROM analytics.metric_snapshots')").map((v) => v.rule).join(), 'R3');
  assert.equal(scanSource('src/features/analytics/exports/x.js', "q('SELECT 1 FROM analytics.export_jobs')").map((v) => v.rule).join(), 'R3');
  assert.equal(scanSource('src/features/analytics/briefs/x.js', "q('UPDATE analytics.executive_briefs SET x=1')").map((v) => v.rule).join(), 'R3');
  assert.equal(scanSource('src/features/finance/x.js', 'analytics.rm_finance_health').map((v) => v.rule).join(), 'R1');
  assert.equal(scanSource('src/features/analytics/read-models/finance.js', "q('SELECT 1 FROM analytics.rm_finance_health')").map((v) => v.rule).join(), 'R2');
  assert.deepEqual(scanSource('src/features/analytics/read-models/finance.js', "const s = require('../security');\nq('SELECT 1 FROM analytics.rm_finance_health')"), []);
  assert.deepEqual(scanSource('src/features/analytics/stores.js', "q('SELECT 1 FROM analytics.metric_definitions')"), []);
  assert.deepEqual(scanSource('src/features/ai/x.js', "const m = require('../analytics');"), []);
});

test('m9d700 o cache nunca serve a resposta de um usuário com outras permissões ou outro recorte', () => {
  const finance = { groupId: 'g', companyId: 'c', permissions: ['analytics:read', 'finance:read'] };
  const corretor = { groupId: 'g', companyId: 'c', permissions: ['analytics:read', 'crm:opportunities:read:own'] };
  const k = (ctx, scope) => buildCacheKey(ctx, 'metric:fin.free_cash', {}, scope);
  assert.notEqual(k(finance), k(corretor));
  assert.notEqual(k(corretor), k(corretor, { mode: 'SELF', userIds: ['u1'] }));
  assert.notEqual(k(corretor, { mode: 'SELF', userIds: ['u1'] }), k(corretor, { mode: 'SELF', userIds: ['u2'] }));
});
