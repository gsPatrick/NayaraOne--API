'use strict';

// M9-D693 — geração do briefing: todo item com fato, fonte e freshness; exceções priorizadas e limitadas; qualidade antes da conclusão;
// falha do provider sem texto inventado; item sem fonte descartado (BLOCKED_GROUNDING); regeração; ação só sugerida. Banco descartável;
// cada teste roda em transação com rollback. A NAY é simulada pela porta runAgent (o orquestrador real é do Bloco A).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');
const store = require('../../../src/features/analytics/executiveBriefStore.service');

let env;
before(async () => { env = await e.setup(); });
after(async () => { await e.teardown(env); });

const A = () => env.tenantA;
const gen = (tx, runAgent, extra = {}) => briefs.generateBrief({ scope: e.scopeOf(A()), briefType: 'DAILY', now: new Date(e.NOW), ...extra }, { runAgent }, tx);
async function cenario(tx, { metrics, alerts = [], settings = {} }) {
  const made = [];
  for (const m of metrics) made.push(await e.metric(env, A(), tx, m));
  await e.panel(A(), tx, { metrics: made.map((m, i) => ({ code: m.code, config: metrics[i].config })) });
  for (const a of alerts) await e.alert(A(), tx, { metricCode: made[a.metric].code, severity: a.severity, resolved: a.resolved, lastValue: a.lastValue });
  for (const [k, v] of Object.entries(settings)) await e.setting(A(), tx, k, v);
  return made;
}

test('m9d693 todo item tem fato, fonte e freshness', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const [m] = await cenario(tx, { metrics: [{ current: '112000.00', previous: '130000.00' }], alerts: [{ metric: 0, severity: 'CRITICAL' }] });
    const agent = e.agent();
    const out = await gen(tx, agent);
    assert.equal(out.status, 'GENERATED');
    assert.equal(out.items.length, 1);
    const item = out.items[0];
    assert.ok(item.fato.includes('112.000,00'), item.fato);
    assert.equal(item.tipo, 'EXCECAO');
    assert.equal(item.ordem, 1);
    assert.equal(item.fonte.length, 1);
    assert.deepEqual(Object.keys(item.fonte[0]).sort(), ['freshnessState', 'metricCode', 'sourceSnapshotAt', 'version']);
    assert.equal(item.fonte[0].metricCode, m.code);
    assert.equal(item.fonte[0].version, 1);
    assert.equal(item.fonte[0].freshnessState, 'FRESH');
    assert.equal(item.fonte[0].sourceSnapshotAt, '2026-10-27T20:00:00.000Z');
    // gravado: ai_run_id, fontes do briefing e resumo de frescor
    const row = await store.getCurrentBrief({ companyId: A().companyId, groupId: A().groupId, briefType: 'DAILY', periodStart: '2026-10-27', periodEnd: '2026-10-27' }, tx);
    assert.equal(row.status, 'GENERATED');
    assert.ok(row.ai_run_id);
    assert.equal(row.source_refs[0].metricCode, m.code);
    assert.deepEqual(row.freshness_summary, { FRESH: 1 });
    assert.equal(agent.calls.length, 1);
  });
});

test('m9d693 briefing prioriza exceções e respeita o limite de itens', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const made = await cenario(tx, {
      settings: { 'analytics.brief.max_itens': 'diário 4; semanal 12' },
      metrics: [
        { current: '80', previous: '80' },                                                       // 0 alerta CRITICAL aberto
        { current: '20', previous: '20', config: { trafficLight: { red: { operator: 'LT', value: 50 } } } }, // 1 semáforo vermelho
        { current: '150', previous: '100' },                                                     // 2 variação +50% (sentido desconhecido)
        { current: '70', previous: '100' },                                                      // 3 variação -30%
        { current: '60', previous: '60' },                                                       // 4 alerta WARNING
        { current: '100', previous: '100' },                                                     // 5 normal: não entra
        { current: '90', previous: '80' },                                                       // 6 variação +12,5%
      ],
      alerts: [{ metric: 0, severity: 'CRITICAL' }, { metric: 4, severity: 'WARNING' }],
    });
    const out = await gen(tx, e.agent());
    const codes = out.items.map((i) => i.metricCodes[0]);
    assert.deepEqual(codes, [made[0].code, made[1].code, made[2].code, made[3].code], '1 CRITICAL, 2 vermelho, 3 maior variação (|50| depois |30|); limite de 4 corta o resto');
    assert.deepEqual(out.items.map((i) => i.ordem), [1, 2, 3, 4]);
    assert.equal(out.items.length, 4, 'métrica normal (5) não entra e o limite vale');
    assert.equal(out.items.filter((i) => i.metricCodes[0] === made[5].code).length, 0);
    assert.equal(out.brief.content.fechamento, null, 'há exceção fora do briefing por causa do limite: não se pode afirmar que o resto está dentro do esperado');
  });
});

test('m9d693 ordem do livro e fechamento calculado pelo servidor', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const made = await cenario(tx, {
      settings: { 'analytics.brief.polaridade': 'fin.x=alta' },
      metrics: [
        { current: '100', previous: '100' }, { current: '60', previous: '60' }, { current: '150', previous: '100' }, { current: '70', previous: '100' }, { current: '100', previous: '100' },
      ],
      alerts: [{ metric: 1, severity: 'WARNING' }, { metric: 0, severity: 'CRITICAL' }],
    });
    const out = await gen(tx, e.agent());
    assert.deepEqual(out.items.map((i) => i.metricCodes[0]), [made[0].code, made[2].code, made[3].code, made[1].code], 'CRITICAL, variações (50% e 30%), WARNING');
    assert.equal(out.brief.content.fechamento, 'Todas as demais áreas dentro do esperado');
    assert.equal(out.items.every((i) => i.tipo === 'EXCECAO'), true);
  });
});

test('m9d693 dia normal gera briefing curto sem exceção e sem chamar a NAY', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await cenario(tx, { metrics: [{ current: '100', previous: '99' }, { current: '50', previous: '50' }] });
    const agent = e.agent();
    const out = await gen(tx, agent);
    assert.equal(out.status, 'GENERATED');
    assert.deepEqual(out.items, []);
    assert.equal(out.brief.content.fechamento, 'Todas as áreas dentro do esperado');
    assert.equal(agent.calls.length, 0, 'sem item para escrever, a NAY nem é chamada');
  });
});

test('m9d693 destaque positivo usa a polaridade configurada e vem por último', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const [bom, ruim] = [null, null];
    void bom; void ruim;
    const made = [];
    for (const m of [{ current: '150', previous: '100' }, { current: '150', previous: '100' }]) made.push(await e.metric(env, A(), tx, m));
    await e.panel(A(), tx, { metrics: made.map((m) => ({ code: m.code })) });
    await e.setting(A(), tx, 'analytics.brief.polaridade', `${made[0].code}=alta; ${made[1].code}=baixa`);
    const out = await gen(tx, e.agent());
    assert.deepEqual(out.items.map((i) => [i.metricCodes[0], i.tipo]), [[made[1].code, 'EXCECAO'], [made[0].code, 'DESTAQUE']], 'subir é bom para o primeiro (destaque) e ruim para o segundo (exceção)');
  });
});

test('m9d693 métrica DEGRADED gera item de qualidade e nenhuma conclusão', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const ruim = await e.metric(env, A(), tx, { current: '987654.32', previous: '10.00', status: 'DEGRADED' });
    const bomMesmaArea = await e.metric(env, A(), tx, { current: '150', previous: '100' });
    const outraArea = await e.metric(env, A(), tx, { code: `crm.m9d693_${e.sup.sfx()}`, current: '70', previous: '100' });
    await e.panel(A(), tx, { metrics: [{ code: ruim.code }, { code: bomMesmaArea.code }, { code: outraArea.code }] });
    const agent = e.agent();
    const out = await gen(tx, agent);
    const quality = out.items.filter((i) => i.tipo === 'ATENCAO_QUALIDADE');
    assert.equal(quality.length, 1, 'um item de qualidade por área');
    assert.equal(quality[0].fato, 'Financeiro: dado incompleto em um indicador; a conclusão sobre esta área fica adiada até a próxima atualização.');
    assert.equal(quality[0].fonte[0].metricCode, ruim.code);
    const entrada = e.entradaOf(agent.calls[0]);
    assert.deepEqual(entrada.itens.map((i) => i.metricCode), [outraArea.code], 'a área com dado ruim não recebe conclusão, nem pelos indicadores bons dela; a outra área segue');
    assert.ok(!JSON.stringify(agent.calls[0]).includes('987654'), 'o número do dado degradado nunca chega à NAY');
    assert.ok(out.items.every((i) => !JSON.stringify(i).includes('987654')), 'nem ao briefing gravado');
    assert.deepEqual(out.brief.quality_summary.areasComDadoIncompleto, ['Financeiro']);
    assert.deepEqual(out.items.map((i) => i.tipo).sort(), ['ATENCAO_QUALIDADE', 'EXCECAO']);
  });
});

test('m9d693 dado velho e métrica sem registro no dia nunca viram conclusão', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const velho = await e.metric(env, A(), tx, { current: '70', previous: '100', sourceAt: '2026-10-26T01:00:00Z', refreshedAt: '2026-10-27T20:00:00Z' }); // 43 h de idade da fonte
    const semRegistro = await e.metric(env, A(), tx, { current: null, previous: '100' });
    await e.panel(A(), tx, { metrics: [{ code: velho.code }, { code: semRegistro.code }] });
    const agent = e.agent();
    const out = await gen(tx, agent);
    assert.deepEqual(out.items.map((i) => i.tipo), ['ATENCAO_QUALIDADE']);
    assert.equal(agent.calls.length, 0);
    assert.deepEqual(out.brief.quality_summary.semRegistro, [semRegistro.code]);
    assert.ok(['STALE', 'EXPIRED'].includes(out.items[0].fonte[0].freshnessState), out.items[0].fonte[0].freshnessState);
  });
});

test('m9d693 falha do provider não gera briefing inventado', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await cenario(tx, { metrics: [{ current: '150', previous: '100' }] });
    // orçamento estourado: FAILED com ANALYTICS_BRIEF_AI_BUDGET (HTTP 200 do job; o briefing do período não existe)
    const budget = await gen(tx, e.agent(() => ({ ok: false, error: { status: 429, code: 'AI_BUDGET_EXHAUSTED', message: 'x' } })));
    assert.equal(budget.status, 'FAILED');
    assert.equal(budget.brief.blocked_reason, 'ANALYTICS_BRIEF_AI_BUDGET');
    assert.deepEqual(budget.brief.content, { itens: [], fechamento: null, periodo: { inicio: '2026-10-27', fim: '2026-10-27', anteriorInicio: '2026-10-26', anteriorFim: '2026-10-26' } });
    assert.ok(budget.brief.source_refs.length > 0, 'as fontes tentadas ficam registradas');
    // reler: o Centro de Comando mostra "Briefing indisponível"
    const reader = await briefs.getBriefForReader(e.readerOf(A(), ['analytics:brief:read', 'finance:read']), { briefType: 'DAILY' }, tx);
    assert.equal(reader.available, false);
    assert.equal(reader.message, 'Briefing indisponível');
    assert.deepEqual(reader.items, []);
    // provider que lança: FAILED com o código do erro
    const lanca = await gen(tx, async () => { const err = new Error('timeout'); err.code = 'AI_PROVIDER_TIMEOUT'; throw err; }, { regenerate: true });
    assert.equal(lanca.status, 'FAILED');
    assert.equal(lanca.brief.blocked_reason, 'ANALYTICS_BRIEF_AI_FAILED:AI_PROVIDER_TIMEOUT');
    // saída que não é JSON: nada de texto gravado
    const lixo = await gen(tx, e.agent(() => 'Bom dia! O caixa está ótimo.'), { regenerate: true });
    assert.equal(lixo.status, 'FAILED');
    assert.equal(lixo.brief.blocked_reason, 'ANALYTICS_BRIEF_SCHEMA_INVALID');
    assert.deepEqual(lixo.items, []);
    // agente sem identidade de serviço configurada (o runner real do Bloco A): FAILED, nunca texto
    const { createBriefAgentRunner } = require('../../../src/features/ai/agents/nay_diretoria/diretoria.briefRunner');
    const real = await gen(tx, createBriefAgentRunner(), { regenerate: true });
    assert.equal(real.status, 'FAILED');
    assert.match(real.brief.blocked_reason, /^ANALYTICS_BRIEF_AI_(FAILED:|BUDGET)/);
  });
});

test('m9d693 item sem fonte é descartado e sem itens vira BLOCKED_GROUNDING', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const made = await cenario(tx, { metrics: [{ current: '150', previous: '100' }, { current: '70', previous: '100' }] });
    // a NAY entrega os dois itens, mas o segundo sem fonte: só o primeiro fica
    const meio = await gen(tx, e.agent((entrada) => ({ itens: entrada.itens.map((i, n) => ({ ...e.honestItem(i), ...(n === 1 ? { fonte: [] } : {}) })) })));
    assert.equal(meio.status, 'GENERATED');
    assert.equal(meio.items.length, 1);
    assert.equal(meio.items[0].metricCodes[0], made[0].code);
    assert.match(meio.brief.blocked_reason, /ANALYTICS_BRIEF_NO_SOURCES \[i2\]/);
    // nenhum item com fonte: BLOCKED_GROUNDING, sem texto
    const nada = await gen(tx, e.agent((entrada) => ({ itens: entrada.itens.map((i) => ({ ...e.honestItem(i), fonte: [{ metricCode: 'fin.inventada' }] })) })), { regenerate: true });
    assert.equal(nada.status, 'BLOCKED_GROUNDING');
    assert.deepEqual(nada.items, []);
    assert.match(nada.brief.blocked_reason, /ANALYTICS_BRIEF_NO_SOURCES/);
    const reader = await briefs.getBriefForReader(e.readerOf(A(), ['analytics:brief:read', 'finance:read']), { briefType: 'DAILY' }, tx);
    assert.deepEqual([reader.available, reader.message], [false, 'Briefing indisponível']);
  });
});

test('m9d693 regerar marca o anterior SUPERSEDED', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await cenario(tx, { metrics: [{ current: '150', previous: '100' }] });
    const primeiro = await gen(tx, e.agent());
    const repetido = await gen(tx, e.agent());
    assert.equal(repetido.skipped, 'EXISTS', 'sem pedido de regeração, o período já tem briefing');
    const segundo = await gen(tx, e.agent(), { regenerate: true });
    assert.notEqual(segundo.brief.id, primeiro.brief.id);
    const [rows] = await e.sequelize.query(
      "SELECT id, status FROM analytics.executive_briefs WHERE company_id = :c AND brief_type = 'DAILY' AND period_start = '2026-10-27' ORDER BY created_at, id",
      { replacements: { c: A().companyId }, transaction: tx }
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['GENERATED', 'SUPERSEDED']);
    assert.equal(rows.find((r) => r.id === primeiro.brief.id).status, 'SUPERSEDED');
    assert.equal(rows.find((r) => r.id === segundo.brief.id).status, 'GENERATED');
  });
});

test('m9d693 ação sugerida nunca executa nada', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await cenario(tx, { metrics: [{ current: '150', previous: '100' }], alerts: [{ metric: 0, severity: 'CRITICAL' }] });
    const antes = await e.rowCounts(tx, ['finance', 'crm', 'legal', 'correspondent', 'construction', 'inventory', 'marketing']);
    assert.ok(Object.keys(antes).length > 20, 'a conferência cobre as tabelas de pagamento, aprovação, preço e envio das áreas');
    const out = await gen(tx, e.agent((entrada) => ({ itens: entrada.itens.map((i) => ({ ...e.honestItem(i), acaoSugerida: 'Aprovar o pagamento e mudar o preço do imóvel.', execute: 'POST /finance/payments' })) })));
    for (const item of out.items) {
      assert.deepEqual(Object.keys(item.acaoSugerida).sort(), ['texto', 'tipo'], 'só texto e tipo, nada executável');
      assert.equal(item.acaoSugerida.tipo, 'SUGESTAO');
      assert.equal(item.execute, undefined);
    }
    assert.deepEqual(await e.rowCounts(tx, ['finance', 'crm', 'legal', 'correspondent', 'construction', 'inventory', 'marketing']), antes, 'nenhuma tabela das áreas operacionais mudou: o briefing só escreve no schema analytics');
  });
});
