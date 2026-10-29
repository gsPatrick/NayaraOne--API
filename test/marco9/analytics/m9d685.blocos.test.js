'use strict';

// M9-D685 — conteúdo dos blocos 1, 2, 3, 5 e 6: o que aconteceu (fatos do dia, variação relevante e alertas), o que exige decisão (fila do read model e alertas
// reconhecidos), onde há risco, prazos (vencido antes do mais próximo) e oportunidades. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e685 = require('../_helpers/m9d685Env');
const { setSetting, clearSetting, openCenter, blockOf, seedAt } = e685;
const { KEYS } = require('../../../src/features/analytics/centroSettings');

const ok = (value, dims = []) => ({ value, status: 'OK', dimensions: dims.map(([key, v]) => ({ key, value: v })) });
let env;

before(async () => { env = await e685.setup(); await e685.clearQueueAndAlerts(env, env.tenantA); await e685.seedScenario(env); });
after(async () => { await e685.clearQueueAndAlerts(env, env.tenantA); await e685.teardown(env); });

test('m9d685 bloco 1: fatos do dia, variação relevante contra a janela anterior e alertas abertos e resolvidos na janela', async () => {
  await e685.seedScenario(env);
  await e685.seedMetric(env.tenantA, 'fin.free_cash', { result: ok('100000.00') });
  await e685.seedMetric(env.tenantA, 'fin.delinquency_rate', { result: ok('10.00') });
  await seedAt(env, 'fin.free_cash', '2026-10-27', ok('80000.00')); // +25%: acima da relevância de 10%
  await seedAt(env, 'fin.delinquency_rate', '2026-10-27', ok('9.50')); // +5,26%: abaixo
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'OPEN', hoursAgo: 3 });
  await e685.alertOf(env, env.tenantA, { severity: 'CRITICAL', status: 'RESOLVED', hoursAgo: 10, resolvedHoursAgo: 2 });
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'OPEN', hoursAgo: 40 }); // aberto antes da janela de 24 h: não é "o que aconteceu"
  const res = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=ACONTECEU` });
  const block = blockOf(res, 'ACONTECEU');
  const titles = block.items.map((i) => i.title);
  assert.ok(titles.includes('3 contratos assinados') && titles.includes('2 oportunidades ganhas') && titles.includes('1 pagamento liquidado de valor relevante'), titles.join(' | '));
  const variation = block.items.filter((i) => i.type === 'VARIACAO_KPI');
  assert.deepEqual(variation.map((i) => i.source.metricCode), ['fin.free_cash'], 'só o KPI crítico acima do limiar de relevância');
  assert.match(variation[0].title, /subiu 25%/);
  assert.match(variation[0].detail, /De R\$ 80\.000,00 para R\$ 100\.000,00/);
  const alerts = block.items.filter((i) => i.source.alertId);
  assert.deepEqual(alerts.map((i) => i.type).sort(), ['ALERTA_ABERTO', 'ALERTA_RESOLVIDO'], 'um aberto e um resolvido na janela; o de 40 h fica de fora');
  assert.equal(block.window, undefined);
  assert.deepEqual([res.body.data.window.hours, block.items.length], [24, 6]);
  const contracts = block.items.find((i) => i.type === 'CONTRATO_ASSINADO');
  assert.match(contracts.detail, /Valor: R\$ 90\.000,00\. Janela anterior: 1\./);
  await clearSetting(env, env.tenantA, KEYS.relevancePct);
  await setSetting(env, env.tenantA, KEYS.relevancePct, 3);
  const strict = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=ACONTECEU` });
  assert.equal(blockOf(strict, 'ACONTECEU').items.filter((i) => i.type === 'VARIACAO_KPI').length, 2, 'o limiar de relevância é do administrador (3%): a taxa de 5,26% também entra');
  await setSetting(env, env.tenantA, 'analytics.centro.janela_horas', 48);
  const wide = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=ACONTECEU` });
  assert.equal(wide.body.data.window.hours, 48);
  assert.equal(blockOf(wide, 'ACONTECEU').items.filter((i) => i.source.alertId).length, 3, 'janela de 48 h inclui o alerta aberto há 40 h');
  await clearSetting(env, env.tenantA, 'analytics.centro.janela_horas');
  await clearSetting(env, env.tenantA, KEYS.relevancePct);
  await e685.clearQueueAndAlerts(env, env.tenantA);
  await e685.seedScenario(env);
});

test('m9d685 bloco 2: fila de decisão do read model, do mais grave ao mais antigo, com idade, marca de envelhecido e link do módulo', async () => {
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', hours: 10, title: 'Pedido novo', amount: '2500.00' });
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', hours: 60, title: 'Pedido velho', amount: '90000.00' });
  await e685.queueItem(env, env.tenantA, { kind: 'INV_ADJUSTMENT', hours: 80, title: 'Ajuste velho', amount: null });
  await e685.queueItem(env, env.tenantA, { kind: 'NAY_PROPOSAL', hours: 1, title: 'Proposta', amount: null });
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', hours: 100, title: 'Já decidido', status: 'DECIDED' });
  const res = await openCenter(env);
  const block = blockOf(res, 'DECISAO');
  assert.deepEqual(block.items.map((i) => i.title), ['Ajuste de estoque: Ajuste velho', 'Aprovação financeira: Pedido velho', 'Aprovação financeira: Pedido novo', 'Proposta da NAY: Proposta'],
    'envelhecidos (acima de 48 h) primeiro, do mais antigo ao mais novo; decididos não entram');
  assert.deepEqual(block.items.map((i) => [i.ageHours, i.aged]), [[80, true], [60, true], [10, false], [1, false]]);
  assert.deepEqual(block.items.map((i) => i.link.href), ['/painel/estoque/sugestoes', '/painel/financeiro/aprovacoes', '/painel/financeiro/aprovacoes', '/painel/financeiro/nay']);
  assert.deepEqual(block.items.map((i) => i.source.metricCode), ['inv.adjustments_pending', 'fin.approvals_pending', 'fin.approvals_pending', 'ai.proposals_pending']);
  assert.equal(block.items[1].formatted, 'R$ 90.000,00');
  assert.match(block.items[1].detail, /há 60 h \(acima de 48 h\)/);
  await setSetting(env, env.tenantA, 'analytics.centro.decisao_atraso_horas', 70);
  const lenient = await openCenter(env);
  assert.deepEqual(blockOf(lenient, 'DECISAO').items.map((i) => i.aged), [true, false, false, false], 'o limite de envelhecimento é o parâmetro da M9-D709');
  await clearSetting(env, env.tenantA, 'analytics.centro.decisao_atraso_horas');
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 bloco 2: alerta reconhecido sem resolução com owner da diretoria exige decisão; de outro owner, não', async () => {
  const mine = await e685.alertOf(env, env.tenantA, { severity: 'CRITICAL', status: 'ACKNOWLEDGED', ownerRole: 'Diretoria', hoursAgo: 30 });
  await e685.alertOf(env, env.tenantA, { severity: 'CRITICAL', status: 'ACKNOWLEDGED', ownerRole: 'financeiro-gestor', hoursAgo: 30 });
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'OPEN', ownerRole: 'Diretoria', hoursAgo: 30 });
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'RESOLVED', ownerRole: 'Diretoria', hoursAgo: 30 });
  const block = blockOf(await openCenter(env), 'DECISAO');
  assert.deepEqual(block.items.map((i) => [i.type, i.source.alertId]), [['ALERTA_RECONHECIDO', mine.id]]);
  await setSetting(env, env.tenantA, KEYS.directorRoles, 'Diretoria, financeiro-gestor');
  assert.equal(blockOf(await openCenter(env), 'DECISAO').items.length, 2, 'os papéis da diretoria são do administrador');
  await clearSetting(env, env.tenantA, KEYS.directorRoles);
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 bloco 3: risco por alerta aberto, anomalia, processo, garantia vencida, margem baixa e integração fora do SLO', async () => {
  await e685.alertOf(env, env.tenantA, { severity: 'CRITICAL', status: 'OPEN' });
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'OPEN' });
  await e685.alertOf(env, env.tenantA, { severity: 'INFO', status: 'ACKNOWLEDGED' });
  const res = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=RISCO` });
  const block = blockOf(res, 'RISCO');
  assert.deepEqual(block.items.filter((i) => i.source.alertId).map((i) => i.severity), ['CRITICAL', 'WARNING'], 'só OPEN, do mais grave ao menos grave');
  assert.equal(block.items[0].severity, 'CRITICAL');
  const byType = Object.fromEntries(block.items.filter((i) => !i.source.alertId).map((i) => [i.type, i]));
  assert.equal(byType.ANOMALIA_FINANCEIRA.title, '2 anomalias financeiras de risco alto');
  assert.equal(byType.PROCESSO_RISCO_ALTO.title, '3 processos jurídicos de risco alto ou crítico');
  assert.equal(byType.PROCESSO_RISCO_ALTO.severity, 'CRITICAL', 'há processo de risco crítico');
  assert.equal(byType.GARANTIA_VENCIDA.title, '1 garantia de locação vencida');
  assert.equal(byType.INTEGRACAO_FORA_SLO.title, '1 integração acima do limite de erro');
  const margins = block.items.filter((i) => i.type === 'OBRA_MARGEM_BAIXA');
  assert.deepEqual(margins.map((i) => [i.extra ? 1 : 0, i.projectId, i.formatted]), [[0, 'aaaaaaaa-0000-4000-8000-000000000001', '6,00%']], 'só a obra abaixo de 10%');
  await setSetting(env, env.tenantA, KEYS.minMarginPct, 25);
  const strict = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=RISCO` });
  assert.equal(blockOf(strict, 'RISCO').items.filter((i) => i.type === 'OBRA_MARGEM_BAIXA').length, 2, 'a margem mínima é do administrador (25%)');
  await clearSetting(env, env.tenantA, KEYS.minMarginPct);
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 prazo vencido vem antes do mais próximo', async () => {
  const res = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=PRAZOS` });
  const items = blockOf(res, 'PRAZOS').items;
  assert.equal(items.length, 7);
  const firstNotOverdue = items.findIndex((i) => !i.overdue);
  assert.ok(items.slice(0, firstNotOverdue).every((i) => i.overdue) && items.slice(firstNotOverdue).every((i) => !i.overdue), 'vencidos primeiro, depois os próximos');
  assert.deepEqual(items.map((i) => i.type), ['ATRASO_OBRA', 'PRAZO_JURIDICO', 'VISTORIA_CHAVE_ATRASADA', 'VISTORIA_CHAVE_ATRASADA', 'CONTAS_A_PAGAR', 'PRAZO_JURIDICO', 'GARANTIA_A_VENCER']);
  assert.equal(items[1].title, '1 prazo jurídico vencido');
  assert.match(items[1].detail, /venceu há 9 dias/);
  assert.equal(items[5].title, '2 prazos jurídicos nos próximos 7 dias', 'o prazo jurídico próximo vem depois dos vencidos');
  assert.deepEqual(items.slice(0, 4).map((i) => i.sort), [undefined, undefined, undefined, undefined], 'a chave de ordenação não vai ao Front');
  const limited = await openCenter(env);
  assert.deepEqual(blockOf(limited, 'PRAZOS').items.map((i) => i.overdue), [true, true, true, true, false], 'com o limite de 5, os vencidos continuam na frente');
});

test('m9d685 bloco 6: oportunidades paradas, propostas, matches sem contato e imóveis sem venda (só sugestão)', async () => {
  const res = await openCenter(env);
  const block = blockOf(res, 'OPORTUNIDADES');
  const byType = Object.fromEntries(block.items.map((i) => [i.type, i]));
  assert.equal(byType.OPORTUNIDADE_PARADA.title, '3 oportunidades em estágio avançado paradas há mais de 7 dias');
  assert.equal(byType.PROPOSTA_EM_ABERTO.title, '5 propostas em aberto');
  assert.match(byType.PROPOSTA_EM_ABERTO.detail, /R\$ 2\.400\.000,00/);
  assert.equal(byType.MATCH_SEM_CONTATO.title, '5 matches do Radar sem contato', '85 cruzamentos menos 80 enviados');
  assert.equal(byType.IMOVEL_SEM_VENDA.title, '22 imóveis há mais de 180 dias sem venda');
  assert.deepEqual([byType.IMOVEL_SEM_VENDA.suggestionOnly, /apenas sugestão/.test(byType.IMOVEL_SEM_VENDA.detail)], [true, true]);
  await setSetting(env, env.tenantA, 'analytics.centro.opp_parada_dias', 15);
  const other = await openCenter(env);
  assert.match(blockOf(other, 'OPORTUNIDADES').items.find((i) => i.type === 'OPORTUNIDADE_PARADA').title, /mais de 15 dias/, 'o prazo vem do parâmetro da M9-D616');
  await clearSetting(env, env.tenantA, 'analytics.centro.opp_parada_dias');
});

test('m9d685 o limite de itens por bloco é do administrador', async () => {
  await setSetting(env, env.tenantA, KEYS.maxItems, 2);
  const res = await openCenter(env);
  const prazos = blockOf(res, 'PRAZOS');
  assert.deepEqual([prazos.items.length, prazos.total, prazos.viewAllHref], [2, 7, '/painel/centro-de-comando?bloco=PRAZOS']);
  assert.equal(res.body.data.maxItemsPerBloco, undefined);
  assert.equal(res.body.data.maxItemsPerBlock, 2);
  await clearSetting(env, env.tenantA, KEYS.maxItems);
});
