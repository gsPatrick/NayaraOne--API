'use strict';

// M9-D699 (carga em escala cheia, 16/11/2026) — a abertura do detalhe de um indicador lê a tabela de origem DUAS vezes: uma varredura para
// contagem e total juntos e a página pedida. Antes eram cinco (contagem e amostra de id na conferência de permissão, a página, e de novo
// contagem e soma no agregado); com 150 mil lançamentos por empresa, era o maior consumo de banco do BI sob carga e o que degradava o fluxo
// operacional. O número de páginas sai da mesma contagem do agregado, e o resultado não muda (contagem, total e páginas).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env690 = require('../_helpers/m9d690Env');
const { sequelize } = require('../../../src/models');

let env;
before(async () => { env = await env690.setup(); });
after(() => env690.teardown(env));

async function contarLeituras(tabela, fn) {
  const original = sequelize.query;
  const lidas = [];
  sequelize.query = function espiao(sql, ...resto) {
    const texto = typeof sql === 'string' ? sql : (sql && sql.query) || '';
    if (texto.includes(tabela)) lidas.push(texto.replace(/\s+/g, ' ').slice(0, 80));
    return original.call(this, sql, ...resto);
  };
  try { return { resultado: await fn(), lidas }; } finally { sequelize.query = original; }
}

for (const [key, modo] of [['fin', 'SUM'], ['legal', 'COUNT'], ['rent', 'RECOMPUTE']]) {
  test(`m9d699 o detalhe (${modo}) lê a origem duas vezes: contagem com total numa varredura e a página`, async () => {
    const metric = env.metrics.find((x) => x.key === key);
    const ref = await env690.refOf(env, metric);
    const { resultado: res, lidas } = await contarLeituras(`"analytics"."${metric.table}"`, () => env690.get(env, metric, ref, { extra: { page: '2', pageSize: '2' } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(lidas.length, 2, `leituras da origem: ${lidas.join(' | ')}`);
    assert.ok(lidas.some((l) => l.startsWith('SELECT count(*)::int AS n')), 'a contagem existe');
    assert.equal(lidas.filter((l) => l.startsWith('SELECT count(*)')).length, 1, 'contagem uma vez só');
    const body = res.body.data;
    assert.equal(body.aggregate.count, env690.INSIDE.length);
    assert.equal(body.totalPages, 3, 'o número de páginas vem da contagem do agregado');
    assert.equal(body.rows.length, 2);
    if (modo === 'SUM') assert.equal(body.aggregate.total, env690.sumSigned(env690.INSIDE).toFixed(2));
    else assert.equal(body.aggregate.total, null);
  });
}
