'use strict';

// M9-D009 — valor estruturado da memória: texto livre e conversa recusados, só os quatro tipos, validade obrigatória, dado pessoal
// só com finalidade, conversa inteira só sob a regra única (parâmetro Ligado + as quatro condições).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { sequelize, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { memoria, comPerm, dados, origemRun, rejeita } = require('../_helpers/iaMemoria');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ana = () => comPerm(ctxDe(tenantA), 'ai:use');
const admin = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');
const CPF = '529.982.247-25';

test('m9d009_texto_livre_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const chat = 'Cliente: oi, queria saber do Aurora. Atendente: claro! '.repeat(80);
    assert.ok(chat.length > 3000);
    const err = await rejeita(memoria.save(ana(), dados(run, { value: { text: chat } }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    assert.match(err.message, /fatos estruturados/);
    // Campo previsto no schema, mas maior que o limite do parâmetro: também é conversa, não fato.
    await rejeita(memoria.save(ana(), dados(run, { value: { decision: 'x'.repeat(301) } }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    // Lista de mensagens, texto puro e lista no lugar do objeto.
    await rejeita(memoria.save(ana(), dados(run, { value: { messages: [{ role: 'user', content: 'oi' }] } }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    await rejeita(memoria.save(ana(), dados(run, { value: 'Cliente: oi' }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    // O limite é parâmetro da empresa.
    const ctx = ana();
    await upsertSetting('ia.memoria.valor_max_caracteres', 400, tenantA, ctx.userId, tx);
    const ok = await memoria.save(ctx, dados(run, { value: { decision: 'x'.repeat(350) } }), tx);
    assert.equal(ok.memory.value.decision.length, 350);
  });
});

test('m9d009_tipo_fora_dos_quatro_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const e1 = await rejeita(memoria.save(ana(), dados(run, { type: 'CHAT_HISTORY' }), tx), 400, 'AI_MEMORY_TYPE_INVALID');
    assert.equal(e1.message, 'Tipo de memória não permitido.');
    await rejeita(memoria.save(ana(), dados(run, { type: undefined }), tx), 400, 'AI_MEMORY_TYPE_INVALID');
    const sem = await rejeita(memoria.save(ana(), dados(undefined), tx), 400, 'AI_MEMORY_SOURCE_REQUIRED');
    assert.equal(sem.message, 'Informe a origem da memória.');
    await rejeita(memoria.save(ana(), dados(run, { sourceId: 'x' }), tx), 400, 'AI_MEMORY_INVALID');
    await rejeita(memoria.save(ana(), dados(run, { sourceId: '11111111-1111-4111-8111-111111111111' }), tx), 400, 'AI_MEMORY_SOURCE_INVALID');
    // Campo que o schema do tipo não conhece e campo obrigatório ausente.
    await rejeita(memoria.save(ana(), dados(run, { value: { decision: 'ok', cor: 'azul' } }), tx), 400, 'AI_MEMORY_VALUE_INVALID');
    await rejeita(memoria.save(ana(), dados(run, { value: { rationale: 'sem decisão' } }), tx), 400, 'AI_MEMORY_VALUE_INVALID');
    await rejeita(memoria.save(admin(), dados(run, { type: 'RECOMMENDATION_OUTCOME', value: { recommendation_id: 'x', outcome: 'EXECUTED' } }), tx), 400, 'AI_MEMORY_VALUE_INVALID');
  });
});

test('m9d009_expires_at_obrigatorio_e_padrao_em_dias', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const agora = new Date('2026-10-27T15:00:00-03:00');
    const a = await memoria.save(ana(), dados(run), tx, { now: agora });
    assert.equal(a.memory.expiresAt, '2027-04-25T18:00:00.000Z', '27/10/2026 + 180 dias = 25/04/2027 (mesma hora em São Paulo)');
    const s = await memoria.save(ana(), dados(run, { scope: 'SESSION' }), tx, { now: agora });
    assert.equal(s.memory.expiresAt, '2026-10-28T18:00:00.000Z', 'SESSION: 1 dia');
    await rejeita(memoria.save(ana(), dados(run, { expiresAt: null }), tx, { now: agora }), 400, 'AI_MEMORY_EXPIRES_INVALID');
    await rejeita(memoria.save(ana(), dados(run, { expiresAt: '2026-10-01T00:00:00Z' }), tx, { now: agora }), 400, 'AI_MEMORY_EXPIRES_INVALID');
    // Os dois prazos são parâmetros da empresa.
    const ctx = ana();
    await upsertSetting('ia.memoria.validade_dias', 30, tenantA, ctx.userId, tx);
    await upsertSetting('ia.memoria.validade_sessao_dias', 2, tenantA, ctx.userId, tx);
    assert.equal((await memoria.save(ctx, dados(run), tx, { now: agora })).memory.expiresAt, '2026-11-26T18:00:00.000Z');
    assert.equal((await memoria.save(ctx, dados(run, { scope: 'SESSION' }), tx, { now: agora })).memory.expiresAt, '2026-10-29T18:00:00.000Z');
  });
});

test('m9d009_pii_sem_finalidade_removida', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    // DECISION não está na lista de tipos que aceitam dado pessoal: o campo sai e a gravação segue.
    const a = await memoria.save(ana(), dados(run, { purpose: 'contato', value: { decision: 'Ligar para o cliente', rationale: `CPF ${CPF}, fone (11) 91234-5678` } }), tx);
    assert.equal(a.memory.value.rationale, undefined);
    assert.deepEqual(a.piiRemoved, ['rationale']);
    assert.equal(a.memory.value.decision, 'Ligar para o cliente');
    // Campo obrigatório com dado pessoal fica com o texto redigido.
    const b = await memoria.save(ana(), dados(run, { value: { decision: `Falar com ${CPF}` } }), tx);
    assert.match(b.memory.value.decision, /\[REDIGIDO:cpf\]/);
    // Tipo que permite (COMPANY_PREFERENCE) SEM finalidade: sai; COM finalidade: fica.
    const pref = (extra = {}) => dados(run, { type: 'COMPANY_PREFERENCE', value: { preference: 'Contato por WhatsApp à tarde', details: 'cliente@exemplo.com' }, ...extra });
    const c = await memoria.save(admin(), pref(), tx);
    assert.equal(c.memory.value.details, undefined);
    const d = await memoria.save(admin(), pref({ purpose: 'Contato combinado com o cliente' }), tx);
    assert.equal(d.memory.value.details, 'cliente@exemplo.com');
    assert.deepEqual(d.piiRemoved, []);
    // Segredo nunca fica, nem com finalidade.
    const e = await memoria.save(admin(), pref({ purpose: 'teste', value: { preference: 'x', details: 'senha: abc123456789' } }), tx);
    assert.equal(e.memory.value.details, undefined);
    assert.deepEqual(e.piiRemoved, ['details']);
    // O tipo que aceita dado pessoal é parâmetro da empresa.
    const ctx = admin();
    await upsertSetting('ia.memoria.tipos_com_dado_pessoal', 'DECISION', tenantA, ctx.userId, tx);
    const f = await memoria.save(ctx, dados(run, { purpose: 'contato', value: { decision: 'ok', rationale: 'fone (11) 91234-5678' } }), tx);
    assert.equal(f.memory.value.rationale, 'fone (11) 91234-5678');
  });
});

const comTranscript = (run, extra = {}) => dados(run, { scope: 'SESSION', value: { decision: 'Fechar o negócio', transcript: `Cliente: aceito. Meu CPF é ${CPF}. Atendente: ótimo.` }, ...extra });

test('m9d009_conversa_inteira_recusada_com_parametro_desligado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    await rejeita(memoria.save(admin(), comTranscript(run), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    await rejeita(memoria.save(admin(), dados(run, { value: { decision: 'x', text: 'y'.repeat(4000) } }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
  });
});

test('m9d009_conversa_inteira_aceita_so_com_parametro_ligado_ai_admin_session_e_expiracao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const adm = admin();
    await upsertSetting('ia.memoria.guardar_conversa_inteira', true, tenantA, adm.userId, tx);
    const agora = new Date('2026-10-27T12:00:00-03:00');
    const ok = await memoria.save(adm, comTranscript(run), tx, { now: agora });
    assert.match(ok.memory.value.transcript, /\[REDIGIDO:cpf\]/, 'o texto passa pelo redactor');
    assert.ok(!ok.memory.value.transcript.includes(CPF));
    assert.equal(ok.memory.expiresAt, '2026-10-28T15:00:00.000Z', 'validade da conversa: 24 horas (ia.memoria.transcript_validade_horas)');
    assert.equal((await memoria.save(adm, comTranscript(run, { type: 'RECOMMENDATION_OUTCOME', value: { recommendation_id: run, outcome: 'EXECUTED', transcript: 'ok' } }), tx)).memory.memoryType, 'RECOMMENDATION_OUTCOME');
    // Os dois limites são parâmetros.
    await upsertSetting('ia.memoria.transcript_max_caracteres', 100, tenantA, adm.userId, tx);
    await rejeita(memoria.save(adm, comTranscript(run, { value: { decision: 'x', transcript: 'a'.repeat(101) } }), tx), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    await upsertSetting('ia.memoria.transcript_validade_horas', 1, tenantA, adm.userId, tx);
    await rejeita(memoria.save(adm, comTranscript(run, { expiresAt: '2026-10-27T18:00:00Z' }), tx, { now: agora }), 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    assert.equal((await memoria.save(adm, comTranscript(run), tx, { now: agora })).memory.expiresAt, '2026-10-27T16:00:00.000Z');
  });
});

test('m9d009_conversa_inteira_recusada_ligado_sem_ai_admin_ou_sem_session_ou_restricted', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const adm = admin();
    await upsertSetting('ia.memoria.guardar_conversa_inteira', true, tenantA, adm.userId, tx);
    const bloqueada = (promessa) => rejeita(promessa, 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
    await bloqueada(memoria.save(ana(), comTranscript(run), tx));                                                      // sem ai:admin
    await bloqueada(memoria.save(adm, comTranscript(run, { scope: 'COMPANY' }), tx));                                  // fora de SESSION
    await bloqueada(memoria.save(adm, comTranscript(run, { scope: 'USER' }), tx));
    await bloqueada(memoria.save(adm, comTranscript(run, { classification: 'RESTRICTED' }), tx));                      // RESTRICTED
    await bloqueada(memoria.save(adm, comTranscript(run, { type: 'COMPANY_PREFERENCE', value: { preference: 'x', transcript: 'oi' } }), tx)); // tipo fora dos dois
    await bloqueada(memoria.save(adm, comTranscript(run, { value: { decision: 'x', transcript: '' } }), tx));
    // Conversa fora do campo `transcript` (lista de mensagens) continua recusada, mesmo com tudo ligado.
    await bloqueada(memoria.save(adm, comTranscript(run, { value: { decision: 'x', messages: [{ role: 'user', content: 'oi' }] } }), tx));
  });
});
