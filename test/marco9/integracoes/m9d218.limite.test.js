'use strict';

// Marco 9, M9-D218 — limitador local por connection (per_second, per_minute, per_day): excesso é reagendado, nunca falha nem gasta tentativa.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sequelize, comTenant, carregarTenants, ctxDe, limparPendentes, enfileirar, tentativas, instalar, restaurar, ler, dispatch, uniqueSuffix, forcar } = require('../_helpers/m9d214Env');
const { mensagemProgramavel } = require('../_helpers/m9d214Scripted');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');

let tenant;
let Msg;
const ctx = () => ctxDe(tenant);
const agg = () => crypto.randomUUID();

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => { Msg = mensagemProgramavel({ idempotente: true }); instalar(Msg); await limparPendentes(tenant); });
after(async () => { restaurar(); await sequelize.close(); });

/** Conexão de mensageria ATIVA com política de limite local. */
async function conexaoComLimite(rateLimit) {
  return comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'messaging-sandbox' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId }, transaction: t });
    const nova = await registry.createConnection({ providerCode: 'messaging-sandbox', environment: 'SANDBOX', label: `QA-M9 lim ${uniqueSuffix()}`, policyJson: { rate_limit: rateLimit } }, ctx(), t);
    await transitionConnection(nova.id, 'ACTIVE', ctx(), t);
    return nova;
  });
}
const mensagens = async (c, n, extra = {}) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await enfileirar(tenant, { connectionId: c.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: `+5541${String(900000000 + i)}`, text: `m${i}` }, ...extra })).dispatchId);
  return ids;
};
const situacao = async (ids) => {
  const linhas = await Promise.all(ids.map((id) => ler(tenant, id)));
  return { enviados: linhas.filter((l) => l.status === 'SUBMITTED'), esperando: linhas.filter((l) => l.status === 'RETRY_WAIT'), outros: linhas.filter((l) => !['SUBMITTED', 'RETRY_WAIT'].includes(l.status)) };
};

test('quota_token_bucket_reagenda_sem_falhar', async () => {
  const c = await conexaoComLimite({ per_minute: 60 });
  const ids = await mensagens(c, 100);
  const t0 = new Date();
  const resumo = await dispatch.runDispatchCycle(ctx(), { now: t0, limit: 100 });
  assert.equal(resumo.claimed, 100);
  const a = await situacao(ids);
  assert.equal(a.enviados.length, 60, '60 saem no minuto');
  assert.equal(a.esperando.length, 40, '40 reagendados sem falha');
  assert.equal(a.outros.length, 0, 'nenhum falhou');
  assert.equal(Msg.S.chamadas.length, 60);
  assert.ok(a.esperando.every((l) => l.attempts === 0), 'o reagendamento não gasta tentativa');
  assert.ok(a.esperando.every((l) => Math.abs(new Date(l.next_attempt_at).getTime() - (t0.getTime() + 60000)) < 1500), 'volta quando a mais antiga sai da janela de 60 s');
  // Passado o minuto os 40 saem.
  await Promise.all(a.esperando.map((l) => forcar(tenant, l.id, "next_attempt_at = now() - interval '1 second'")));
  await dispatch.runDispatchCycle(ctx(), { now: new Date(t0.getTime() + 61000), limit: 100 });
  const b = await situacao(ids);
  assert.equal(b.enviados.length, 100);
  assert.equal(Msg.S.chamadas.length, 100);
  // per_second: 2 por segundo.
  const c2 = await conexaoComLimite({ per_second: 2 });
  const ids2 = await mensagens(c2, 5);
  const t1 = new Date();
  await dispatch.runDispatchCycle(ctx(), { now: t1, limit: 10 });
  const s = await situacao(ids2);
  assert.deepEqual([s.enviados.length, s.esperando.length], [2, 3]);
  assert.ok(s.esperando.every((l) => Math.abs(new Date(l.next_attempt_at).getTime() - (t1.getTime() + 1000)) < 1500));
});

test('quota_nao_consome_tentativa', async () => {
  const c = await conexaoComLimite({ per_minute: 1 });
  const ids = await mensagens(c, 3);
  const t0 = new Date();
  for (let i = 0; i < 4; i += 1) {
    await dispatch.runDispatchCycle(ctx(), { now: new Date(t0.getTime() + i * 1000), limit: 10 });
    const lin = await Promise.all(ids.map((id) => ler(tenant, id)));
    await Promise.all(lin.filter((l) => l.status === 'RETRY_WAIT').map((l) => forcar(tenant, l.id, "next_attempt_at = now() - interval '1 second'")));
  }
  const s = await situacao(ids);
  assert.equal(s.enviados.length, 1);
  assert.equal(s.esperando.length, 2);
  for (const l of s.esperando) {
    assert.equal(l.attempts, 0, 'o contador está intacto depois de várias esperas');
    assert.equal(l.max_attempts, 8);
    assert.equal((await tentativas(tenant, l.id)).length, 0, 'nenhuma tentativa aberta');
  }
  assert.equal(Msg.S.chamadas.length, 1);
  // Janela livre: os dois saem, cada um com a 1ª tentativa de verdade.
  await dispatch.runDispatchCycle(ctx(), { now: new Date(t0.getTime() + 61000), limit: 10 });
  const livre = await situacao(ids);
  assert.equal(livre.enviados.length, 2, 'um por janela de um minuto');
  assert.ok(livre.enviados.every((l) => l.attempts === 1));
  await Promise.all(livre.esperando.map((l) => forcar(tenant, l.id, "next_attempt_at = now() - interval '1 second'")));
  await dispatch.runDispatchCycle(ctx(), { now: new Date(t0.getTime() + 125000), limit: 10 });
  assert.equal((await situacao(ids)).enviados.length, 3);
});

test('quota_sem_politica_nao_limita_e_prioriza_essenciais_na_fila', async () => {
  const c = await conexaoComLimite({ per_minute: 2 });
  const comuns = await mensagens(c, 3);
  const essencial = (await mensagens(c, 1, { essential: true }))[0];
  const perigosa = (await mensagens(c, 1, { opClass: 'DANGEROUS' }))[0];
  await dispatch.runDispatchCycle(ctx(), { now: new Date(), limit: 10 });
  assert.equal((await ler(tenant, essencial)).status, 'SUBMITTED', 'o essencial sai primeiro');
  assert.equal((await ler(tenant, perigosa)).status, 'SUBMITTED', 'o perigoso também');
  const s = await situacao(comuns);
  assert.equal(s.enviados.length, 0);
  assert.equal(s.esperando.length, 3, 'os comuns esperam a vaga');
});
