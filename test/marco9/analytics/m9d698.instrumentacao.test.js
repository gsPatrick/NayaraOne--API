'use strict';

// M9-D698 (3.1, BI-012) — os GET de /analytics leem SOMENTE o schema analytics: instrumentação do SQL real enquanto os painéis são abertos
// centenas de vezes. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const q = require('../_helpers/m9d698Queries');
const catalog = require('../../../src/features/analytics/dashboards/dashboard.catalog');
const dashboards = require('../../../src/features/analytics/dashboards');

let env;
before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const ALL = ['analytics:read', 'analytics:read:tech', 'analytics:audit:read', 'finance:read', 'crm:opportunities:read', 'legal:read', 'construction:read', 'inventory:read', 'correspondent:read', 'marketing:attribution:read', 'crm:feedback:read'];

test('m9d698 painel não consulta tabelas de origem (instrumentação)', async () => {
  dashboards.clearCache();
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 200; i += 1) {
      if (i % 2 === 0) dashboards.clearCache(); // metade das aberturas sem cache: a consulta ao banco acontece de verdade
      const res = await env.call('GET', '/analytics/dashboards/finance', { perms: ALL });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.dashboard_definitions/i.test(s)), 'a leitura do painel aparece no SQL capturado');
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
  const schemas = await q.sourceSchemas(env.admin);
  assert.ok(schemas.includes('finance'), 'o detector conhece o schema de origem finance');
});

test('m9d698 nenhuma rota GET de /analytics toca tabela de origem (todos os painéis, métrica e log de acesso)', async () => {
  const urls = [...catalog.DASHBOARD_CODES.map((c) => `/analytics/dashboards/${c}`), '/analytics/metrics/fin.caixa_livre', '/analytics/access-log'];
  const run = await q.capture(env.admin, async () => {
    for (const url of urls) {
      dashboards.clearCache();
      const res = await env.call('GET', url, { perms: ALL });
      assert.ok([200, 404].includes(res.status), `${url}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  });
  assert.deepEqual(run.sources, [], run.sources.slice(0, 3).join('\n'));
});

test('m9d698 o detector pega consulta a tabela de origem (teste negativo)', async () => {
  const { sequelize } = require('../../testHelpers');
  const run = await q.capture(env.admin, () => sequelize.query('SELECT count(*) FROM finance.financial_entries WHERE false'));
  assert.equal(run.sources.length, 1);
});
