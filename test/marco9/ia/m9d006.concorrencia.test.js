'use strict';

// Marco 9, M9-D006 — duas chamadas iguais ao mesmo tempo (duas conexões): a segunda ESPERA a primeira e devolve o resultado dela
// (replayed=true); a tool executa uma única vez. Commita dados: só roda no cluster descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../../testHelpers');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { abrirRun, ferramenta, rodar, linhas } = require('../_helpers/iaToolCalls');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const comPerm = (ctx) => ({ ...ctx, permissions: ['ai:use', 'ai:audit'] });

test('m9d006_replay_concorrente_duas_conexoes', { skip: SKIP }, async () => {
  const ctx = comPerm(ctxDe(tenantA));
  const runId = await withTenantTransaction(tenantA, (tx) => abrirRun(ctx, tx));
  const { tool, execucoes } = ferramenta({ atrasoMs: 300 });
  const chamar = () => withTenantTransaction(tenantA, (tx) => rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'X' }, seq: 1 }));
  const [a, b] = await Promise.all([chamar(), chamar()]);
  assert.equal(execucoes.length, 1, 'a tool executou uma única vez');
  const replays = [a, b].filter((r) => r.replayed === true);
  assert.equal(replays.length, 1, 'exatamente uma das duas devolveu o resultado anterior');
  assert.deepEqual([a.status, b.status], ['SUCCEEDED', 'SUCCEEDED']);
  assert.deepEqual(replays[0].output, { ok: true, itens: 3 });
  const rows = await withTenantTransaction(tenantA, (tx) => linhas(runId, tx));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SUCCEEDED');
});

test('m9d006_primeira_conexao_desfaz_e_a_segunda_executa', { skip: SKIP }, async () => {
  const ctx = comPerm(ctxDe(tenantA));
  const runId = await withTenantTransaction(tenantA, (tx) => abrirRun(ctx, tx));
  const { tool, execucoes } = ferramenta({ atrasoMs: 200 });
  const primeira = withTenantTransaction(tenantA, async (tx) => {
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'Y' }, seq: 1 });
    throw new Error('desfaz tudo (por exemplo, falha depois da tool)');
  }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 50));
  const segunda = await withTenantTransaction(tenantA, (tx) => rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'Y' }, seq: 1 }));
  assert.match((await primeira).message, /desfaz tudo/);
  assert.equal(segunda.status, 'SUCCEEDED');
  assert.equal(segunda.replayed, undefined, 'o que foi desfeito não conta como execução anterior');
  assert.equal(execucoes.length, 2, 'a 1ª execução foi desfeita junto com a transação; a 2ª valeu');
  const [{ n }] = await withTenantTransaction(tenantA, (tx) => q('SELECT count(*)::int AS n FROM ai.tool_calls WHERE run_id = :runId', { runId }, tx));
  assert.equal(n, 1);
});
