'use strict';

// M9-D694 (3.1) — a variação pronta do servidor chega à NAY junto do aviso de mudança de versão (a NAY nunca calcula). Integra com o
// briefing da M9-D693.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');

let env;
before(async () => { env = await e.setup(); });
after(async () => { await e.teardown(env); });

const A = () => env.tenantA;
const run = async (tx, m) => {
  await e.panel(A(), tx, { metrics: [{ code: m.code }] });
  const agent = e.agent();
  await briefs.generateBrief({ scope: e.scopeOf(A()), briefType: 'DAILY', now: new Date(e.NOW) }, { runAgent: agent }, tx);
  return e.entradaOf(agent.calls[0]).itens[0];
};

test('m9d694 a NAY recebe a variação pronta e não calcula', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00' });
    const item = await run(tx, m);
    assert.deepEqual([Number(item.variacao.absoluta), item.variacao.percentual], [-18000, '-13.85']);
    assert.equal(item.variacao.periodoAtual.endDate, '2026-10-27');
    assert.equal(item.variacao.periodoAnterior.endDate, '2026-10-26');
    assert.equal(item.variacao.mudouVersao, false);
    assert.equal(item.variacao.aviso, undefined);
  });
});

test('m9d694 o aviso de mudança de versão chega à NAY junto da variação', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00', secondVersion: true });
    const item = await run(tx, m);
    assert.equal(item.variacao.mudouVersao, true);
    assert.equal(item.variacao.aviso, 'A fórmula mudou entre os períodos.');
  });
});
