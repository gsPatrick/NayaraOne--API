'use strict';

// Marco 9, M9-D205 — máquina de estados, UNKNOWN, DEAD_LETTER, retenção e redação do snapshot.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, config, criar, forcar, ler, chave, dispatch } = require('./dispatchHelpers');
const { AuditLog } = require('../../../src/models');

let tenant;
let con;

before(async () => { ({ tenant } = await carregarTenants()); con = await conexao(tenant, 'BANK'); });
after(async () => { await sequelize.close(); });

const ctx = (extra) => ctxDe(tenant, extra);
const ir = (id, para, patch, opts, extra) => comTenant(tenant, (t) => dispatch.transitionDispatch(ctx(extra), id, para, patch || {}, opts || {}, t));
const novoEm = async (status, extra = {}) => {
  const d = (await criar(tenant, con.id, chave(), extra)).dispatch;
  if (status !== 'PENDING') await forcar(tenant, d.id, `status = '${status}'`);
  return d;
};
const erro409 = (e) => e.statusCode === 409 && e.code === 'INTEGRATION_DISPATCH_INVALID_TRANSITION';

test('dispatch_state_machine_tabela_completa', async () => {
  const ESPERADO = {
    PENDING: ['SENDING', 'CANCELLED'],
    SENDING: ['SUBMITTED', 'CONFIRMED', 'RETRY_WAIT', 'UNKNOWN', 'FAILED'],
    SUBMITTED: ['CONFIRMED', 'UNKNOWN', 'FAILED'],
    RETRY_WAIT: ['SENDING', 'DEAD_LETTER', 'CANCELLED'],
    UNKNOWN: ['SUBMITTED', 'CONFIRMED', 'FAILED', 'RETRY_WAIT', 'DEAD_LETTER'],
    FAILED: ['RETRY_WAIT', 'DEAD_LETTER'],
    DEAD_LETTER: ['RETRY_WAIT'],
    CONFIRMED: [],
    CANCELLED: [],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(dispatch.TRANSITIONS)), ESPERADO);
  // As 81 combinações, com as condições de quem pede: com todas as autorizações, vale exatamente a tabela.
  const liberado = { humanRetry: true, reconciled: true, criticalityOp: 'SAFE' };
  for (const de of dispatch.STATUSES) {
    for (const para of dispatch.STATUSES) {
      const ok = ESPERADO[de].includes(para);
      assert.equal(dispatch.refusalReason(de, para, liberado) === null, ok, `${de} -> ${para}`);
    }
  }
  // No banco: PENDING -> SENDING -> CONFIRMED, com auditoria antes/depois.
  const d = await novoEm('PENDING');
  const s = await ir(d.id, 'SENDING');
  assert.equal(s.status, 'SENDING');
  assert.equal(s.attempts, 1);
  const c = await ir(d.id, 'CONFIRMED', { externalRequestId: 'req-9', externalResourceId: 'pg-77' });
  assert.equal(c.status, 'CONFIRMED');
  assert.ok(c.confirmedAt);
  assert.equal(c.externalResourceId, 'pg-77');
  const trilha = await comTenant(tenant, (t) => AuditLog.findAll({ where: { entityType: 'IntegrationDispatch', entityId: d.id, action: 'integration.dispatch.status_changed' }, order: [['created_at', 'ASC']], transaction: t }));
  assert.ok(trilha.length >= 3, 'criação + 2 transições');
  const ultima = trilha[trilha.length - 1];
  assert.equal(ultima.beforeJson.status, 'SENDING');
  assert.equal(ultima.afterJson.status, 'CONFIRMED');
  for (const para of ['PENDING', 'SENDING', 'RETRY_WAIT', 'CANCELLED']) {
    await assert.rejects(ir(d.id, para), erro409, `CONFIRMED -> ${para}`);
  }
  await assert.rejects(ir(d.id, 'SUBMITTED'), (e) => e.statusCode === 409 && /CONFIRMED -> SUBMITTED/.test(e.message));
});

test('dispatch_unknown_nao_vai_a_retry_direto', async () => {
  const perigosa = await novoEm('UNKNOWN', { criticalityOp: 'DANGEROUS' });
  await assert.rejects(ir(perigosa.id, 'RETRY_WAIT'), erro409, 'operação perigosa não tenta de novo sem reconciliar');
  assert.equal((await ler(tenant, perigosa.id)).status, 'UNKNOWN');
  const apos = await ir(perigosa.id, 'RETRY_WAIT', {}, { reconciled: true });
  assert.equal(apos.status, 'RETRY_WAIT', 'depois da reconciliação (D215) pode');
  const segura = await novoEm('UNKNOWN', { criticalityOp: 'SAFE' });
  assert.equal((await ir(segura.id, 'RETRY_WAIT')).status, 'RETRY_WAIT', 'operação SAFE vai direto');
});

test('dispatch_unknown_pode_voltar_a_submitted', async () => {
  const d = await novoEm('UNKNOWN');
  const r = await ir(d.id, 'SUBMITTED', { externalRequestId: 'req-ok' });
  assert.equal(r.status, 'SUBMITTED');
  assert.equal(r.unknownSince, null, 'saiu do UNKNOWN');
  for (const para of ['PENDING', 'SENDING', 'CANCELLED']) {
    const u = await novoEm('UNKNOWN');
    await assert.rejects(ir(u.id, para), erro409, `UNKNOWN -> ${para}`);
  }
});

test('dispatch_dead_letter_so_sai_por_retry_humano', async () => {
  const d = await novoEm('DEAD_LETTER');
  await forcar(tenant, d.id, 'attempts = 8, max_attempts = 8');
  const antes = await ler(tenant, d.id);
  await assert.rejects(ir(d.id, 'RETRY_WAIT'), erro409, 'pelo worker é 409');
  await assert.rejects(comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx(), d.id, t)), (e) => e.statusCode === 403, 'sem integration:retry é 403');
  const r = await comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx({ permissions: ['integration:retry'] }), d.id, t));
  assert.equal(r.status, 'RETRY_WAIT');
  assert.equal(r.maxAttempts, 11, 'max_attempts aumenta em 3');
  assert.equal(r.attempts, 8, 'attempts é mantido');
  const depois = await ler(tenant, d.id);
  assert.equal(depois.idempotency_key, antes.idempotency_key, 'mesma chave');
  assert.equal(depois.payload_hash, antes.payload_hash, 'mesmo hash');
  const f = await novoEm('FAILED');
  await assert.rejects(ir(f.id, 'RETRY_WAIT'), erro409, 'FAILED também só pelo retry humano');
  assert.equal((await comTenant(tenant, (t) => dispatch.retryDispatchManually(ctx({ permissions: new Set(['integration:retry']) }), f.id, t))).status, 'RETRY_WAIT');
});

test('dispatch_retencao_redige_payload', async () => {
  await config(tenant, 'integration.dispatch.payload_retention_days', 90);
  await config(tenant, 'integration.dispatch.retention_days', 365);
  const novo = await novoEm('CONFIRMED');
  const velho = await novoEm('CONFIRMED');
  const cancelado = await novoEm('CANCELLED');
  const apagar = await novoEm('CONFIRMED');
  const pendente = await novoEm('PENDING');
  await forcar(tenant, novo.id, "confirmed_at = now() - interval '29 days'");
  await forcar(tenant, velho.id, "confirmed_at = now() - interval '91 days'");
  await forcar(tenant, cancelado.id, "updated_at = now() - interval '91 days'");
  await forcar(tenant, apagar.id, "confirmed_at = now() - interval '366 days'");
  await forcar(tenant, pendente.id, "created_at = now() - interval '400 days', updated_at = now() - interval '400 days'");
  const r = await comTenant(tenant, (t) => dispatch.purgeDispatches(ctx(), t));
  assert.ok(r.redacted >= 2 && r.deleted >= 1);
  assert.deepEqual((await ler(tenant, novo.id)).payload_snapshot, { valor: '100.00', favorecido: 'X' }, 'com 29 dias o conteúdo fica');
  const v = await ler(tenant, velho.id);
  assert.deepEqual(v.payload_snapshot, { redacted: true, hash: v.payload_hash }, 'com 91 dias vira só o hash');
  assert.equal(v.payload_hash, dispatch.hashPayload({ valor: '100.00', favorecido: 'X' }), 'o hash original permanece');
  const c = await ler(tenant, cancelado.id);
  assert.deepEqual(c.payload_snapshot, { redacted: true, hash: c.payload_hash });
  assert.equal(await ler(tenant, apagar.id), undefined, 'passado 1 ano, o envio sai');
  assert.deepEqual((await ler(tenant, pendente.id)).payload_snapshot, { valor: '100.00', favorecido: 'X' }, 'envio em andamento nunca é redigido');
});

const redigir = (id, shape) => comTenant(tenant, (t) => sequelize.query('UPDATE integration.dispatches SET payload_snapshot = CAST(:s AS jsonb) WHERE id = :id', { replacements: { id, s: JSON.stringify(shape) }, transaction: t }));

test('dispatch_snapshot_so_pode_ser_redigido_pela_funcao_de_expurgo', async () => {
  const d = await novoEm('CONFIRMED');
  await forcar(tenant, d.id, "confirmed_at = now() - interval '100 days'");
  await comTenant(tenant, (t) => dispatch.purgeDispatches(ctx(), t));
  const lido = await ler(tenant, d.id);
  assert.deepEqual(lido.payload_snapshot, { redacted: true, hash: lido.payload_hash }, 'a função de expurgo é o caminho');
  // Mesmo dentro da exceção (marca ligada), só a forma exata com o hash da linha é aceita.
  const o = await novoEm('CONFIRMED');
  const comMarca = (shape) => comTenant(tenant, async (t) => {
    await sequelize.query("SET LOCAL integration.purge_mode = 'on'", { transaction: t });
    await sequelize.query('UPDATE integration.dispatches SET payload_snapshot = CAST(:s AS jsonb) WHERE id = :id', { replacements: { id: o.id, s: JSON.stringify(shape) }, transaction: t });
  });
  await assert.rejects(comMarca({ redacted: true, hash: 'f'.repeat(64) }), /INTEGRATION_DISPATCH_IMMUTABLE/, 'hash diferente do da linha');
  await assert.rejects(comMarca({ redacted: true, hash: (await ler(tenant, o.id)).payload_hash, extra: 1 }), /INTEGRATION_DISPATCH_IMMUTABLE/, 'forma diferente');
  await assert.rejects(comMarca({ valor: '1' }), /INTEGRATION_DISPATCH_IMMUTABLE/, 'qualquer outro conteúdo');
});

test('dispatch_snapshot_redacao_fora_do_expurgo_recusada', async () => {
  const d = await novoEm('CONFIRMED');
  const hash = (await ler(tenant, d.id)).payload_hash;
  await assert.rejects(redigir(d.id, { redacted: true, hash }), /INTEGRATION_DISPATCH_IMMUTABLE/, 'sem a marca da função, a mesma redação é recusada');
  assert.deepEqual((await ler(tenant, d.id)).payload_snapshot, { valor: '100.00', favorecido: 'X' });
  // A marca não vaza entre transações: depois da função, a sessão seguinte volta a recusar.
  await comTenant(tenant, (t) => dispatch.purgeDispatches(ctx(), t));
  await assert.rejects(redigir(d.id, { redacted: true, hash }), /INTEGRATION_DISPATCH_IMMUTABLE/);
});
