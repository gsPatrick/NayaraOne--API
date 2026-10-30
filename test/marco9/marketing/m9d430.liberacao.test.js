'use strict';

// M9-D430 — liberação por canal: parâmetro marketing.channel.<canal>.liberado + serviço releaseChannel (sem rota, sem tabela), pré-requisitos,
// permissão, auditoria, recusa da escrita direta e o envio que só usa SANDBOX enquanto o canal não está liberado. Postgres real (RLS), com rollback.
// Rodar só em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 <arquivo>
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { upsertSetting, getSetting } = require('../../../src/features/settings/settings.service');
const adapters = require('../../../src/features/marketing/publications/adapters');
const { sanitizePublicFields } = require('../../../src/features/marketing/content/sanitize');

const publico = (objeto) => sanitizePublicFields(objeto).payload; // canal de publicação só recebe PublicPayload (M9-D440)

const { CHANNELS, SCENARIOS, releaseKey, releaseChannel, approveConsentPolicy, homologateAdapter, recordChannelDrill, isChannelReleased, sendToChannel, resetSandbox, listChannelStatus } = adapters;
let A;
let B;
before(async () => { ({ tenantA: A, tenantB: B } = await prepararTenants()); });
after(async () => { await sequelize.close(); });
beforeEach(() => resetSandbox());

const DIRETORIA = ['marketing:killswitch:manage'];
const como = (tenant, permissions = DIRETORIA) => ({ tenant, actor: tenant.userId, permissions });
const run = (fn, tenant = A) => withRollbackTenantTransaction(tenant, fn);
const prontos = async (t, canal, tenant = A) => {
  await approveConsentPolicy(canal, { reason: 'Política de consentimento revisada pelo jurídico.' }, como(tenant), t);
  await homologateAdapter(canal, { reason: 'Adapter homologado em LAB.' }, como(tenant), t);
  await recordChannelDrill(canal, { ok: true, scenarios: [...SCENARIOS] }, como(tenant), t);
};
const rejeita = (fn, status, code) => assert.rejects(fn, (e) => e.statusCode === status && e.code === code, `esperava ${status} ${code}`);

test('o_parametro_nasce_desligado_para_os_9_canais_e_tem_a_chave_do_livro', async () => {
  await run(async (t) => {
    for (const canal of CHANNELS) {
      assert.equal(releaseKey(canal), `marketing.channel.${canal.toLowerCase()}.liberado`);
      assert.equal(await isChannelReleased(canal, A, t), false);
      assert.equal(await getSetting(releaseKey(canal), A, t, 'desligado'), 'desligado');
    }
  });
});

test('canal_nao_liberado_so_usa_sandbox: a resposta nasce marcada sandbox e produção é recusada com 409', async () => {
  await run(async (t) => {
    const r = await sendToChannel('WHATSAPP', { to: '+5511999990000', texto: 'Olá' }, { tenant: A, transaction: t, idempotencyKey: 'chave-lib-000001' });
    assert.deepEqual([r.sandbox, r.mode, r.status], [true, 'SANDBOX', 'SENT']);
    const p = await sendToChannel('SITE', publico({ slug: 'casa', titulo: 'Casa' }), { tenant: A, transaction: t, idempotencyKey: 'chave-lib-000002', scenario: 'REJECTED' });
    assert.deepEqual([p.sandbox, p.status], [true, 'REJECTED'], 'o cenário de teste vale no sandbox');
    await rejeita(() => sendToChannel('WHATSAPP', { to: '+5511999990000', texto: 'Olá' }, { tenant: A, transaction: t, idempotencyKey: 'chave-lib-000003', mode: 'PRODUCTION' }), 409, 'MKT_CHANNEL_NOT_RELEASED');
    await rejeita(() => adapters.resolveChannelAdapter('PORTAL', { tenant: A, transaction: t, mode: 'PRODUCTION' }), 409, 'MKT_CHANNEL_NOT_RELEASED');
  });
});

test('release_channel_exige_prerequisitos_permissao_e_audita', async () => {
  await run(async (t) => {
    // sem permissão: 403 e nada gravado
    await rejeita(() => releaseChannel('EMAIL', { reason: 'Liberar' }, como(A, ['marketing:automation:manage']), t), 403, 'MKT_FORBIDDEN');
    assert.equal(await isChannelReleased('EMAIL', A, t), false);
    // sem pré-requisitos: 422 listando os itens (o contrato roda ao vivo e passa; faltam os três registros)
    const falta = await assert.rejects(() => releaseChannel('EMAIL', { reason: 'Liberar' }, como(A), t), (e) => {
      assert.equal(e.statusCode, 422);
      assert.equal(e.code, 'MKT_CHANNEL_RELEASE_PREREQ_MISSING');
      assert.equal(e.message, 'Faltam pré-requisitos para liberar o canal.');
      assert.deepEqual(e.details.missing, ['FAILURE_DRILL', 'CONSENT_POLICY', 'ADAPTER_HOMOLOGATION']);
      return true;
    });
    assert.equal(falta, undefined);
    assert.equal(await isChannelReleased('EMAIL', A, t), false, 'nada é gravado');
    // motivo é obrigatório
    await prontos(t, 'EMAIL');
    await rejeita(() => releaseChannel('EMAIL', { reason: '  ' }, como(A), t), 422, 'MKT_VALIDATION');
    await rejeita(() => releaseChannel('ORKUT', { reason: 'x' }, como(A), t), 422, 'MKT_VALIDATION');
    // drill incompleto não vale
    await recordChannelDrill('SITE', { ok: true, scenarios: ['OK', 'TIMEOUT'] }, como(A), t);
    await approveConsentPolicy('SITE', { reason: 'Política aprovada.' }, como(A), t);
    await homologateAdapter('SITE', { reason: 'Homologado.' }, como(A), t);
    await rejeita(() => releaseChannel('SITE', { reason: 'Liberar' }, como(A), t), 422, 'MKT_CHANNEL_RELEASE_PREREQ_MISSING');
    // com tudo: libera, audita e é idempotente
    const r = await releaseChannel('EMAIL', { reason: 'Homologação concluída em LAB.' }, como(A), t);
    assert.deepEqual([r.channel, r.released, r.replay], ['EMAIL', true, false]);
    assert.equal(await isChannelReleased('EMAIL', A, t), true);
    assert.equal(await isChannelReleased('WHATSAPP', A, t), false, 'é canal por canal');
    assert.equal(await isChannelReleased('EMAIL', B, t).catch(() => false), false, 'outra empresa continua desligada');
    const [linha] = await sequelize.query(`SELECT user_id, action, reason, before_json, after_json FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.channel.released' AND after_json->>'channel' = 'EMAIL'`,
      { replacements: { c: A.companyId }, transaction: t, type: 'SELECT' });
    assert.equal(linha.user_id, A.userId);
    assert.equal(linha.reason, 'Homologação concluída em LAB.');
    assert.equal(linha.before_json.released, false);
    assert.equal(linha.after_json.released, true);
    assert.deepEqual(linha.after_json.prerequisites.map((p) => p.item), ['CONTRACT_TESTS', 'FAILURE_DRILL', 'CONSENT_POLICY', 'ADAPTER_HOMOLOGATION']);
    const hist = await adapters.channelHomologation('EMAIL', A, t);
    assert.deepEqual([hist.homologatedBy, hist.homologatedAt instanceof Date], [A.userId, true], 'homologated_by/at são o autor e a data da alteração do parâmetro');
    const repetida = await releaseChannel('EMAIL', { reason: 'De novo' }, como(A), t);
    assert.equal(repetida.replay, true);
    const status = await listChannelStatus(A, t);
    assert.equal(status.find((s) => s.channel === 'EMAIL').released, true);
    assert.equal(status.find((s) => s.channel === 'PORTAL').released, false);
  });
});

test('prerequisito_e_da_empresa_e_do_canal: a evidência de uma não libera a outra', async () => {
  await run(async (t) => {
    await prontos(t, 'EMAIL', A);
    await rejeita(() => releaseChannel('WHATSAPP', { reason: 'Liberar' }, como(A), t), 422, 'MKT_CHANNEL_RELEASE_PREREQ_MISSING');
    await rejeita(() => releaseChannel('EMAIL', { reason: 'Liberar' }, como(B), t), 422, 'MKT_CHANNEL_RELEASE_PREREQ_MISSING');
  });
});

test('registrar_evidencia_tambem_exige_a_permissao_e_motivo', async () => {
  await run(async (t) => {
    await rejeita(() => approveConsentPolicy('EMAIL', { reason: 'ok' }, como(A, []), t), 403, 'MKT_FORBIDDEN');
    await rejeita(() => homologateAdapter('EMAIL', { reason: '' }, como(A), t), 422, 'MKT_VALIDATION');
    await rejeita(() => recordChannelDrill('EMAIL', { ok: 'sim', scenarios: [] }, como(A), t), 422, 'MKT_VALIDATION');
  });
});

test('parametro_liberado_nao_e_editavel_pela_tela_nem_por_upsert_direto', async () => {
  await run(async (t) => {
    for (const valor of ['ligado', 'desligado']) {
      await rejeita(() => upsertSetting(releaseKey('INSTAGRAM'), valor, A, A.userId, t), 403, 'MKT_CHANNEL_RELEASE_SERVICE_ONLY');
    }
    await rejeita(() => upsertSetting(releaseKey('INSTAGRAM'), 'talvez', A, A.userId, t), 422, 'MKT_PARAM_INVALID');
    assert.equal(await isChannelReleased('INSTAGRAM', A, t), false);
  });
});

test('desligar_o_canal_so_pelo_servico_e_audita', async () => {
  await run(async (t) => {
    await prontos(t, 'FACEBOOK');
    await releaseChannel('FACEBOOK', { reason: 'Liberar' }, como(A), t);
    await rejeita(() => adapters.revokeChannelRelease('FACEBOOK', { reason: 'Incidente' }, como(A, []), t), 403, 'MKT_FORBIDDEN');
    const r = await adapters.revokeChannelRelease('FACEBOOK', { reason: 'Incidente com a conta.' }, como(A), t);
    assert.deepEqual([r.released, r.replay], [false, false]);
    assert.equal(await isChannelReleased('FACEBOOK', A, t), false);
    const [n] = await sequelize.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.channel.release_revoked'`, { replacements: { c: A.companyId }, transaction: t, type: 'SELECT' });
    assert.equal(n.n, 1);
  });
});

test('canal_liberado_sem_conexao_ativa_nao_cai_para_o_sandbox_escondido: produção pede a connection do bloco B', async () => {
  await run(async (t) => {
    await prontos(t, 'LINKEDIN');
    await releaseChannel('LINKEDIN', { reason: 'Liberar' }, como(A), t);
    await rejeita(() => adapters.resolveChannelAdapter('LINKEDIN', { tenant: A, transaction: t, mode: 'PRODUCTION' }), 404, 'INTEGRATION_CONNECTION_NOT_FOUND');
    const sandbox = await adapters.resolveChannelAdapter('LINKEDIN', { tenant: A, transaction: t, mode: 'SANDBOX' });
    assert.equal(sandbox.isSandbox, true, 'o sandbox continua disponível para teste mesmo com o canal liberado');
  });
});

test('parametros_do_sandbox_sao_lidos_da_empresa', async () => {
  await run(async (t) => {
    await upsertSetting('marketing.channel.sandbox.retry_after_s', 99, A, A.userId, t);
    await upsertSetting('marketing.channel.sandbox.slow_ms', 0, A, A.userId, t);
    const r = await sendToChannel('YOUTUBE', publico({ titulo: 'Tour' }), { tenant: A, transaction: t, idempotencyKey: 'chave-par-000001', scenario: 'HTTP_429' });
    assert.equal(r.error.retryAfterMs, 99000);
    const lento = await sendToChannel('TIKTOK', publico({ titulo: 'Tour' }), { tenant: A, transaction: t, idempotencyKey: 'chave-par-000002', scenario: 'SLOW' });
    assert.equal(lento.status, 'PUBLISHED');
    await assert.rejects(() => upsertSetting('marketing.channel.sandbox.retry_after_s', 0, A, A.userId, t), (e) => e.code === 'SETTING_INVALID_VALUE');
  });
});
