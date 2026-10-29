'use strict';

// M9-D685 — quem vê o quê no Centro de Comando (ABAC e contador de ocultos), o briefing da NAY Diretoria (M9-D693), a conclusão adiada de CADA bloco (M9-D697), as origens
// CRITICAL (M9-D712) e a conferência da fila de decisão com as métricas (M9-D709). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e685 = require('../_helpers/m9d685Env');
const seed = require('../../../src/features/analytics/metrics/seed');
const { ITEM_MAP, DEPENDS_ON, BLOCKS } = require('../../../src/features/analytics/dashboards/command/command.map');

const { openCenter, blockOf, DIRECTOR } = e685;
const ok = (value, dims = []) => ({ value, status: 'OK', dimensions: dims.map(([key, v]) => ({ key, value: v })) });
const MANAGER = ['analytics:read', 'analytics:brief:read', 'legal:read']; // gerente de locação e jurídico
let env;
const allItems = (res) => res.body.data.blocks.flatMap((b) => b.items);
const briefItem = (id, domain, metric) => ({ refId: id, tipo: 'DESTAQUE', fato: `Fato ${id}.`, fonte: [{ metricCode: metric, version: 1 }], freshness: { state: 'FRESH' }, dominios: [domain] });

before(async () => { env = await e685.setup(); await e685.clearQueueAndAlerts(env, env.tenantA); await e685.seedScenario(env); });
after(async () => { await e685.clearQueueAndAlerts(env, env.tenantA); await e685.teardown(env); });

test('m9d685 gerente vê só seu recorte e contador de ocultos', async () => {
  await e685.queueItem(env, env.tenantA, { kind: 'FIN_APPROVAL', title: 'Pedido do financeiro' });
  await e685.alertOf(env, env.tenantA, { metricCode: 'fin.free_cash', severity: 'CRITICAL', status: 'OPEN' });
  await e685.alertOf(env, env.tenantA, { metricCode: 'legal.deadlines', severity: 'WARNING', status: 'OPEN' });
  const query = `asOf=${e685.AS_OF}&bloco=`;
  let director = 0;
  const directorBlocks = {};
  for (const b of BLOCKS) { const r = await openCenter(env, { query: query + b.key }); directorBlocks[b.key] = blockOf(r, b.key).total; director += blockOf(r, b.key).total; }
  const res = await openCenter(env, { perms: MANAGER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mine = allItems(res);
  assert.ok(mine.length > 0 && mine.every((i) => ['LEGAL', 'RENTAL', 'GENERAL'].includes(i.domain)), 'só itens de locação e jurídico (mais os gerais)');
  assert.ok(mine.some((i) => i.type === 'PRAZO_JURIDICO') && mine.some((i) => i.type === 'GARANTIA_VENCIDA'));
  const text = JSON.stringify(res.body.data.blocks);
  for (const secret of ['R$ 79.000,00', 'fin.free_cash', 'Pedido do financeiro', 'cor.commission', 'obra.projected_margin', 'Dinheiro parado']) assert.ok(!text.includes(secret), `não revela "${secret}"`);
  let visible = 0;
  for (const b of BLOCKS) {
    const full = await openCenter(env, { perms: MANAGER, query: query + b.key });
    const block = blockOf(full, b.key);
    visible += block.total;
    assert.equal(block.total + block.hiddenCount, directorBlocks[b.key], `${b.key}: visíveis + ocultos = o que a diretoria vê`);
  }
  const hidden = res.body.data.hidden;
  assert.equal(hidden.count, director - visible, 'o contador do total soma os ocultos dos seis blocos');
  assert.match(hidden.text, /^\+\d+ itens que você não pode ver$/);
  assert.ok(hidden.count > 0);
  const decision = blockOf(res, 'DECISAO');
  assert.equal(decision.hiddenText, '+1 item que você não pode ver', 'a aprovação financeira some, só o contador fica');
  assert.deepEqual(blockOf(res, 'DINHEIRO').items, [], 'o total do dinheiro nunca sai parcial para quem não lê todos os domínios');
  const diretoria = await openCenter(env);
  assert.equal(diretoria.body.data.hidden.count, 0, 'a diretoria vê tudo');
  assert.equal(diretoria.body.data.hidden.text, null);
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 todo item gerado é de um tipo do mapa e aponta só para métrica CRITICAL ou alerta (M9-D712)', async () => {
  await e685.alertOf(env, env.tenantA, { severity: 'WARNING', status: 'OPEN' });
  for (const kind of ['FIN_APPROVAL', 'INV_ADJUSTMENT', 'RULE_APPROVAL', 'NAY_PROPOSAL']) await e685.queueItem(env, env.tenantA, { kind });
  const critical = new Set(seed.criticalCodes());
  const mapped = new Set(ITEM_MAP.map((m) => m.type).concat(['ALERTA_RESOLVIDO', 'DINHEIRO_PARADO', 'DINHEIRO_PERDIDO', 'DINHEIRO_TERCEIROS']));
  const seen = new Set();
  for (const b of BLOCKS) {
    for (const item of blockOf(await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=${b.key}` }), b.key).items) {
      seen.add(item.type);
      assert.ok(mapped.has(item.type), `${item.type} é do mapa fechado`);
      const src = item.source;
      if (src.alertId) continue;
      assert.ok([...(src.metricCodes || [src.metricCode])].every((c) => critical.has(c)), `${item.id}: origem CRITICAL`);
    }
  }
  assert.ok(['ALERTA_ABERTO', 'APROVACAO_FINANCEIRA', 'DINHEIRO_PARADO', 'PRAZO_JURIDICO', 'OPORTUNIDADE_PARADA', 'ANOMALIA_FINANCEIRA'].every((t) => seen.has(t)), [...seen].join(','));
  await e685.clearQueueAndAlerts(env, env.tenantA);
});

test('m9d685 bloco 2 confere com as métricas da fila de decisão e lê só o read model', async () => {
  const rows = { FIN_APPROVAL: 2, INV_ADJUSTMENT: 1, RULE_APPROVAL: 1, NAY_PROPOSAL: 3 };
  for (const [kind, n] of Object.entries(rows)) for (let i = 0; i < n; i += 1) await e685.queueItem(env, env.tenantA, { kind, hours: i + 1 });
  await e685.seedScenario(env, { 'fin.approvals_pending': ok('2'), 'inv.adjustments_pending': ok('1'), 'tec.rule_approvals_pending': ok('1'), 'ai.proposals_pending': ok('3') });
  const res = await openCenter(env, { query: `asOf=${e685.AS_OF}&bloco=DECISAO` });
  const items = blockOf(res, 'DECISAO').items;
  assert.equal(items.length, 7);
  for (const [metric, n] of [['fin.approvals_pending', 2], ['inv.adjustments_pending', 1], ['tec.rule_approvals_pending', 1], ['ai.proposals_pending', 3]]) {
    const metricRes = await e685.getMetric(env, metric, DIRECTOR);
    assert.equal(Number(metricRes.body.data.value), n, `${metric}: a métrica`);
    assert.equal(items.filter((i) => i.source.metricCode === metric).length, n, `${metric}: os itens do bloco 2 batem com a métrica`);
  }
  const ages = items.map((i) => i.ageHours);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a), 'do mais antigo ao mais novo (nenhum envelhecido aqui)');
  const tech = await openCenter(env, { perms: ['analytics:read', 'finance:read'], query: `asOf=${e685.AS_OF}&bloco=DECISAO` });
  assert.deepEqual([...new Set(blockOf(tech, 'DECISAO').items.map((i) => i.source.metricCode))], ['fin.approvals_pending'], 'só as filas que o usuário pode ler');
  assert.equal(blockOf(tech, 'DECISAO').hiddenCount, 5);
  await e685.clearQueueAndAlerts(env, env.tenantA);
  await e685.seedScenario(env);
});

test('m9d685 qualidade ruim adia a conclusão de cada um dos seis blocos, com a razão, e os outros seguem', async () => {
  for (const spec of BLOCKS) {
    const bad = DEPENDS_ON[spec.key][0];
    await e685.seedScenario(env, {}, { degraded: [bad] });
    const res = await openCenter(env);
    const block = blockOf(res, spec.key);
    assert.deepEqual([spec.key, block.deferred, block.deferredText, block.items.length], [spec.key, true, 'Conclusão adiada: dado incompleto', 0]);
    assert.ok(block.reasons.some((r) => r.metricCode === bad && r.problem === 'DEGRADED'), `${spec.key}: razão ${bad}`);
    const others = res.body.data.blocks.filter((b) => b.key !== spec.key && !DEPENDS_ON[b.key].includes(bad));
    assert.ok(others.length >= 3 && others.every((b) => b.deferred === false), 'os blocos que não dependem dela continuam concluindo');
  }
  await e685.seedScenario(env);
});

test('m9d685 briefing vigente vem no topo, filtrado pela permissão do leitor, com fonte e freshness; sem briefing, "Briefing indisponível"', async () => {
  const none = await openCenter(env);
  assert.deepEqual([none.body.data.brief.available, none.body.data.brief.message], [false, 'Briefing indisponível'], 'sem briefing: sem resumo inventado');
  await e685.briefOf(env, env.tenantA, { items: [briefItem('b1', 'FINANCE', 'fin.free_cash'), briefItem('b2', 'LEGAL', 'legal.deadlines')] });
  const full = (await openCenter(env)).body.data.brief;
  assert.deepEqual([full.available, full.items.map((i) => i.refId), full.closing], [true, ['b1', 'b2'], 'Resumo do dia.']);
  assert.ok(full.items.every((i) => i.fonte.length > 0 && i.freshness), 'cada item com fonte e freshness');
  const legalOnly = (await openCenter(env, { perms: MANAGER })).body.data.brief;
  assert.deepEqual(legalOnly.items.map((i) => i.refId), ['b2'], 'o item financeiro sai para quem não lê o Financeiro');
  const noPermission = (await openCenter(env, { perms: ['analytics:read', 'finance:read'] })).body.data.brief;
  assert.deepEqual([noPermission.available, noPermission.message], [false, 'Briefing indisponível'], 'sem analytics:brief:read a tela não mostra briefing');
  const res = await openCenter(env);
  assert.equal(res.body.data.widgets[1].type, 'BRIEF', 'o briefing é o segundo widget, antes dos blocos');
  await e685.briefOf(env, env.tenantA, { status: 'FAILED' });
  const failed = (await openCenter(env)).body.data.brief;
  assert.deepEqual([failed.available, failed.message, failed.items], [false, 'Briefing indisponível', []], 'FAILED: indisponível, nenhum texto inventado');
  await e685.briefOf(env, env.tenantA, { status: 'BLOCKED_GROUNDING' });
  assert.equal((await openCenter(env)).body.data.brief.available, false, 'BLOCKED_GROUNDING também');
  await e685.clearQueueAndAlerts(env, env.tenantA);
});
