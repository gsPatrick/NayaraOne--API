'use strict';

// M9-D694 — o grounding no fluxo do briefing: causa inventada bloqueia o item (e o briefing, se for o único), sem registro de causa o item
// diz "causa não identificada nos dados", causa com registro-fonte é aceita e citada, e cada item removido gera o evento item_blocked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');

let env;
before(async () => { env = await e.setup(); });
after(async () => { await e.teardown(env); });

const A = () => env.tenantA;
const gen = (tx, runAgent, extra = {}) => briefs.generateBrief({ scope: e.scopeOf(A()), briefType: 'DAILY', now: new Date(e.NOW), ...extra }, { runAgent }, tx);
const first = (build) => e.agent((entrada) => ({ itens: entrada.itens.map((i) => ({ ...e.honestItem(i), ...build(i, entrada) })) }));

/** Faz o commit da transação "acontecer" só quando o teste mandar: guarda os avisos que esperam o commit. */
function holdEvents(tx) {
  const pending = [];
  tx.afterCommit = (fn) => pending.push(fn);
  return { fire: () => pending.splice(0).forEach((fn) => fn()) };
}

async function umaExcecao(tx, extra = {}) {
  const m = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00', ...extra });
  await e.panel(A(), tx, { metrics: [{ code: m.code }] });
  return m;
}

test('m9d694 NAY inventa causa e o grounding bloqueia', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await umaExcecao(tx);
    const held = holdEvents(tx);
    const seen = [];
    const off = briefs.onBriefEvent((p) => seen.push(p));
    try {
      const out = await gen(tx, first(() => ({ fato: 'O caixa caiu porque os clientes perderam confiança.' })));
      assert.equal(out.status, 'BLOCKED_GROUNDING', 'único item removido: sem item válido');
      assert.deepEqual(out.items, []);
      assert.match(out.brief.blocked_reason, /ANALYTICS_BRIEF_CAUSE_UNGROUNDED \[i1\]: Palavra de causalidade "porque"/);
      assert.equal(JSON.stringify(out.brief.content).includes('confiança'), false, 'o texto inventado não é gravado');
      assert.deepEqual(seen, [], 'o aviso só sai depois do commit');
      held.fire();
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, 'analytics.brief.item_blocked');
      assert.equal(seen[0].code, 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED');
      assert.equal(seen[0].refId, 'i1');
      assert.equal(JSON.stringify(seen[0]).includes('confiança'), false, 'o evento não leva o texto removido');
    } finally {
      off();
    }
  });
});

test('m9d694 NAY não inventa causa quando não há registro (diz causa não identificada)', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await umaExcecao(tx);
    const agent = first(() => ({ incerteza: 'Não sabemos o motivo.' }));
    const out = await gen(tx, agent);
    assert.equal(out.status, 'GENERATED');
    assert.match(out.items[0].incerteza, /Causa não identificada nos dados\.$/);
    assert.equal(e.entradaOf(agent.calls[0]).causasRegistradas.length, 0, 'nenhum registro de causa na entrada');
    // item que tenta afirmar causa mesmo sem registro: removido
    const forjada = await gen(tx, first(() => ({ tipoAfirmacao: 'CAUSA', fonteCausa: ['qualquer:id'], fato: 'Segundo o registro X, o motivo informado foi preço.' })), { regenerate: true });
    assert.equal(forjada.status, 'BLOCKED_GROUNDING');
    assert.match(forjada.brief.blocked_reason, /CAUSE_UNGROUNDED/);
  });
});

test('m9d694 causa com registro-fonte é aceita e citada', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const motivos = await e.causeMetric(env, A(), tx, { code: `crm.m9d694_${e.sup.sfx()}`, reasons: { PRECO: '6', TOTAL: '14' } });
    await e.setting(A(), tx, 'analytics.brief.fontes_causa', `${motivos.code}=motivo`);
    await umaExcecao(tx);
    const agent = first((i, entrada) => {
      const ids = entrada.causasRegistradas.map((c) => c.id);
      return { tipoAfirmacao: 'CAUSA', fonteCausa: ids, fato: 'Segundo o registro de motivos de perda, 6 de 14 foram por preço.', incerteza: '' };
    });
    const out = await gen(tx, agent);
    const entrada = e.entradaOf(agent.calls[0]);
    assert.deepEqual(entrada.causasRegistradas.map((c) => [c.dimensionValue, c.valor]).sort(), [['PRECO', '6.0000'], ['TOTAL', '14.0000']]);
    assert.equal(out.status, 'GENERATED');
    assert.equal(out.items[0].tipoAfirmacao, 'CAUSA');
    assert.deepEqual(out.items[0].fonteCausa.sort(), entrada.causasRegistradas.map((c) => c.id).sort());
    assert.ok(out.items[0].fato.startsWith('Segundo o registro'));
    assert.equal(out.brief.blocked_reason, null);
    assert.ok(!/Causa não identificada/.test(out.items[0].incerteza), 'com causa registrada citada não se diz que a causa é desconhecida');
  });
});

test('m9d694 número fora da entrada reprova o item e os demais seguem', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const a = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00' });
    const b = await e.metric(env, A(), tx, { current: '70', previous: '100' });
    await e.panel(A(), tx, { metrics: [{ code: a.code }, { code: b.code }] });
    const out = await gen(tx, e.agent((entrada) => ({ itens: entrada.itens.map((i, n) => ({ ...e.honestItem(i), ...(n === 0 ? { fato: 'O caixa livre ficou em R$ 113.500,00.' } : {}) })) })));
    assert.equal(out.status, 'GENERATED');
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].metricCodes[0], a.code, 'o item i1 (b, maior variação) saiu; o i2 (a) ficou');
    assert.match(out.brief.blocked_reason, /ANALYTICS_BRIEF_NUMBER_MISMATCH \[i1\]/);
    assert.equal(out.brief.content.fechamento, null, 'uma exceção foi removida: não se afirma que o resto está dentro do esperado');
  });
});

test('m9d694 sem item válido o briefing é BLOCKED_GROUNDING e o Centro de Comando mostra "Briefing indisponível"', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await umaExcecao(tx);
    const out = await gen(tx, first(() => ({ fato: 'Faturamento de R$ 9.999,99 devido a promoções.' })));
    assert.equal(out.status, 'BLOCKED_GROUNDING');
    const reader = await briefs.getBriefForReader(e.readerOf(A(), ['analytics:brief:read', 'finance:read']), { briefType: 'DAILY' }, tx);
    assert.deepEqual([reader.status, reader.available, reader.message, reader.items], ['BLOCKED_GROUNDING', false, 'Briefing indisponível', []]);
    assert.equal(briefs.UNAVAILABLE_TEXT, 'Briefing indisponível', 'nenhum template: o mesmo texto vale para falha e bloqueio');
  });
});

test('m9d694 as palavras de causalidade e a polaridade são parâmetros da empresa', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await umaExcecao(tx);
    await e.setting(A(), tx, 'analytics.brief.palavras_causalidade', 'culpa de');
    const agent = first(() => ({ fato: 'O caixa caiu porque sim, R$ 112.000,00.' }));
    const livre = await gen(tx, agent);
    assert.equal(livre.status, 'GENERATED', '"porque" deixou de estar na lista desta empresa');
    const bloqueada = await gen(tx, first(() => ({ fato: 'Foi culpa de alguém, R$ 112.000,00.' })), { regenerate: true });
    assert.equal(bloqueada.status, 'BLOCKED_GROUNDING');
    assert.ok(agent.calls[0].instruction.includes('culpa de'), 'a instrução à NAY lista as palavras configuradas');
  });
});
