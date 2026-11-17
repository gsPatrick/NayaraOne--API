'use strict';

// Livro BI §19 ("cache por permissão/escopo"; carga em escala cheia da etapa 13, 16/11/2026) — GET /analytics/metrics/:code passa a usar o mesmo
// cache por permissão e escopo do painel (M9-D698): a repetição vem do cache, o conjunto de permissões faz parte da chave, as conferências e o log de
// acesso do indicador CRITICAL valem em TODA leitura, e gravar um número novo da empresa descarta o que estava guardado. Antes, cada leitura
// refazia todas as consultas (definição, versão, snapshot, confirmação, qualidade), e eram 3/4 das requisições do BI sob carga.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e609 = require('../_helpers/m9d609Env');
const { startServer, snapshotAt } = require('../_helpers/m9d702Env');
const dashboards = require('../../../src/features/analytics/dashboards');

const FIN = ['analytics:read', 'finance:read'];
const NOW = '2026-10-28T15:00:00Z';
let env;
let srv;
let m;

before(async () => {
  env = await e609.setup();
  srv = await startServer(env);
  e609.at(NOW);
  m = await e609.publish(env, env.tenantA, { criticality: 'CRITICAL', maxStalenessMinutes: 60, validFrom: '2025-01-01' });
  await snapshotAt(e609.sup, env.tenantA, m, { asOfDate: '2026-10-28', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '120000', sourceSnapshotAt: '2026-10-28T14:48:00Z' });
});
after(async () => { dashboards.clearCache(); await srv.close(); await e609.teardown(env); });

const get = (perms = FIN) => srv.call('GET', `/analytics/metrics/${m.code}?period=2026-10`, { perms });
const logs = async () => (await env.admin.query("SELECT count(*)::int AS n FROM analytics.access_log WHERE action = 'METRIC_READ' AND resource_code = :c", { replacements: { c: m.code } }))[0][0].n;

test('m9d699 a leitura repetida do indicador vem do cache, com o log de acesso em toda leitura', async () => {
  dashboards.clearCache();
  const antes = dashboards.cacheStats();
  const logsAntes = await logs();
  const primeira = await get();
  assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
  const segunda = await get();
  assert.equal(segunda.status, 200);
  assert.deepEqual(segunda.body.data, primeira.body.data, 'a mesma resposta');
  const depois = dashboards.cacheStats();
  assert.equal(depois.misses - antes.misses, 1, 'só a primeira calcula');
  assert.equal(depois.hits - antes.hits, 1, 'a segunda vem do cache');
  assert.equal(await logs(), logsAntes + 2, 'o indicador CRITICAL registra o acesso nas duas leituras');
});

test('m9d699 outro conjunto de permissões não recebe a resposta guardada e a permissão segue conferida', async () => {
  dashboards.clearCache();
  await get();
  const antes = dashboards.cacheStats();
  const outro = await get([...FIN, 'analytics:drilldown']);
  assert.equal(outro.status, 200);
  assert.equal(dashboards.cacheStats().misses - antes.misses, 1, 'permissões diferentes = chave diferente');
  const semDominio = await get(['analytics:read']);
  assert.equal(semDominio.status, 403, 'sem a permissão do domínio o cache não responde');
});

test('m9d699 número novo da empresa descarta o indicador guardado', async () => {
  dashboards.clearCache();
  assert.equal((await get()).status, 200);
  const guardado = dashboards.cacheStats();
  assert.equal((await get()).status, 200);
  assert.equal(dashboards.cacheStats().hits - guardado.hits, 1, 'guardado');
  // snapshot novo da empresa (gravado com commit): o aviso de depois do commit descarta o que era dela
  await snapshotAt(e609.sup, env.tenantA, m, { asOfDate: '2026-10-28', periodStart: '2026-10-01', periodEnd: '2026-10-31', value: '1000', dimensionKey: 'company=m9d699', sourceSnapshotAt: '2026-10-28T14:55:00Z' });
  const antes = dashboards.cacheStats();
  assert.equal((await get()).status, 200);
  const depois = dashboards.cacheStats();
  assert.equal(depois.misses - antes.misses, 1, 'depois do número novo a leitura calcula de novo');
  assert.equal(depois.hits - antes.hits, 0);
});
