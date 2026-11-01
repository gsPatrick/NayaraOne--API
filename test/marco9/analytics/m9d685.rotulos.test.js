'use strict';

// M9-D685 (reabertura F10) — a conclusão adiada diz QUAL indicador está ruim (nome legível, nunca o código cru) e a data da última atualização; a faixa de qualidade
// lista cada indicador pelo nome (não repete o título do bloco); "Ver todos" aparece sempre que o bloco tem itens. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e685 = require('../_helpers/m9d685Env');
const { DEPENDS_ON } = require('../../../src/features/analytics/dashboards/command/command.map');

const { openCenter, blockOf } = e685;
let env;

before(async () => { env = await e685.setup(); await e685.clearQueueAndAlerts(env, env.tenantA); await e685.seedScenario(env); });
after(async () => { await e685.clearQueueAndAlerts(env, env.tenantA); await e685.teardown(env); });

test('m9d685 conclusão adiada traz o nome do indicador e a última atualização, sem código cru', async () => {
  const bad = DEPENDS_ON.PRAZOS[0];
  await e685.seedScenario(env, {}, { degraded: [bad] });
  const res = await openCenter(env);
  const reason = blockOf(res, 'PRAZOS').reasons.find((r) => r.metricCode === bad);
  assert.ok(reason, 'a razão do indicador ruim');
  assert.ok(reason.name && reason.name !== bad && !/^[a-z]+\.[a-z_0-9]+$/.test(reason.name), `nome legível, não o código (${reason.name})`);
  assert.ok(reason.lastUpdateAt === null || !Number.isNaN(Date.parse(reason.lastUpdateAt)), 'última atualização é uma data ou nula');
  const banner = res.body.data.widgets.find((w) => w.type === 'QUALITY_BANNER').banner;
  const entry = banner.degradedMetrics.find((m) => m.metricCode === bad);
  assert.equal(entry.title, reason.name, 'a faixa de qualidade lista o indicador pelo nome');
  assert.ok(!banner.degradedMetrics.some((m) => ['O que aconteceu', 'Quais prazos estão críticos'].includes(m.title)), 'o título do bloco não se repete como se fosse o indicador');
  await e685.seedScenario(env);
});

test('m9d685 "Ver todos" aparece sempre que o bloco tem itens e some na visão do bloco inteiro', async () => {
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', hours: 1, title: 'Pedido único' });
  const res = await openCenter(env);
  const decision = blockOf(res, 'DECISAO');
  assert.ok(decision.total > 0 && decision.total <= 5, 'poucos itens, abaixo do limite');
  assert.equal(decision.viewAllHref, '/painel/centro-de-comando?bloco=DECISAO');
  const only = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=DECISAO` });
  assert.equal(blockOf(only, 'DECISAO').viewAllHref, null, 'já está vendo o bloco inteiro');
  await e685.clearQueueAndAlerts(env, env.tenantA);
});
