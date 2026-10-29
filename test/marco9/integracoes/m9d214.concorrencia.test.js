'use strict';

// Marco 9, M9-D214 — dois workers nunca executam o mesmo envio (SKIP LOCKED). Exige banco descartável (COMMIT e concorrência real).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sequelize, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, instalar, restaurar, ler, dispatch } = require('../_helpers/m9d214Env');
const { mensagemProgramavel } = require('../_helpers/m9d214Scripted');

let tenant;
let msg;
let Msg;

before(async () => {
  ({ tenant } = await carregarTenants());
  msg = await conexaoAtiva(tenant, 'MESSAGING');
  Msg = mensagemProgramavel();
  instalar(Msg);
});
beforeEach(async () => { Msg.S.reset(); await limparPendentes(tenant); });
after(async () => { restaurar(); await sequelize.close(); });

test('dispatch_workers_concorrentes_executam_uma_vez', async () => {
  assert.equal(process.env.DISPOSABLE_DB, '1', 'este teste exige o banco descartável');
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: crypto.randomUUID(), payload: { to: `+55419999${String(i).padStart(5, '0')}`, text: `msg ${i}` } });
    ids.push(r.dispatchId);
  }
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: 'm-x' } }]);
  Msg.S.aoChamar = async () => { await new Promise((ok) => setTimeout(ok, 40)); };
  const ctx = ctxDe(tenant);
  const [a, b] = await Promise.all([dispatch.runDispatchCycle(ctx, { limit: 8 }), dispatch.runDispatchCycle(ctx, { limit: 8 })]);
  assert.equal(a.claimed + b.claimed, 8, 'cada envio foi pego por exatamente um dos workers');
  const porEnvio = new Map();
  Msg.S.chamadas.forEach((c) => porEnvio.set(c.meta.dispatchId, (porEnvio.get(c.meta.dispatchId) || 0) + 1));
  assert.equal(Msg.S.chamadas.length, 8);
  assert.deepEqual([...porEnvio.keys()].sort(), [...ids].sort());
  assert.ok([...porEnvio.values()].every((n) => n === 1), 'nenhum envio foi executado duas vezes');
  for (const id of ids) {
    const linha = await ler(tenant, id);
    assert.equal(linha.status, 'SUBMITTED');
    assert.equal(linha.attempts, 1);
  }
});
