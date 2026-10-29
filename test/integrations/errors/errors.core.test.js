'use strict';

// Marco 9, M9-D207 — integration.integration_errors (falhas operacionais de qualquer integração).
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... (a prova de
// concorrência COMMITA dados e depois apaga).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const { Group, Company, AuditLog } = require('../../../src/models');
const errors = require('../../../src/features/integrations/errors');
const settingsService = require('../../../src/features/settings/settings.service');

let tenant;
let ctx;
let otherTenant;

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  const grupoB = await Group.findOne({ where: { name: 'CI — Grupo Fictício B' } });
  if (grupoB) {
    const empresaB = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction: t });
      return Company.findOne({ where: { groupId: grupoB.id, name: 'CI — Empresa Fictícia B' }, transaction: t });
    });
    if (empresaB) otherTenant = { groupId: grupoB.id, companyId: empresaB.id, userId: tenant.userId };
  }
});

after(async () => {
  await sequelize.close();
});

const base = (over = {}) => ({
  providerCode: 'financing-manual', source: 'DISPATCH', errorClass: 'UNKNOWN', errorCode: 'QA_M9_FALHA', message: 'Falha de teste.', ...over,
});

async function recusa(promessa, code, status) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode ?? err.status, status);
    return true;
  });
}

const linhaBruta = async (id, transaction) => {
  const [rows] = await sequelize.query('SELECT * FROM integration.integration_errors WHERE id = :id', { replacements: { id }, transaction });
  return rows[0];
};

async function emTransacaoCommitada(tn, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tn.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tn.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tn.userId }, transaction });
    const r = await fn(transaction);
    await transaction.commit();
    return r;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

test('errors_sanitiza_payload_remove_pii_e_segredo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const longa = 'palavra comum '.repeat(40);
    const row = await errors.recordError(ctx, base({
      message: 'Falha para joao@exemplo.com, CPF 123.456.789-09, fone (11) 98888-7777 com Bearer abcdef0123456789abcdef0123456789abcdef.',
      payload: {
        cpf: '123.456.789-09', email: 'maria@exemplo.com', phone: '(11) 98888-7777', cnpj: '12.345.678/0001-95',
        token: 'abcdef0123456789abcdef0123456789abcdef', authorization: 'Bearer abc.def.ghi', password: 'hunter2',
        status: 'PAID', valor: 100.5, ok: true, note: longa, aninhado: { secret: 'zzz', texto: 'contato fulano@x.com.br' },
      },
    }), transaction);
    const bruta = await linhaBruta(row.id, transaction);
    const tudo = JSON.stringify(bruta);
    for (const proibido of ['123.456.789-09', 'joao@exemplo.com', 'maria@exemplo.com', '98888-7777', '12.345.678/0001-95', 'abcdef0123456789', 'hunter2', 'Bearer abc.def', 'fulano@x.com.br', 'zzz']) {
      assert.ok(!tudo.includes(proibido), `não pode gravar: ${proibido}`);
    }
    assert.equal(bruta.sanitized_payload.status, 'PAID');
    assert.equal(bruta.sanitized_payload.valor, 100.5);
    assert.equal(bruta.sanitized_payload.ok, true);
    assert.equal(bruta.sanitized_payload.note.length, 200, 'strings truncadas a 200 caracteres');
    assert.equal(bruta.sanitized_payload.cpf, '[REDACTED]');
    assert.equal(bruta.sanitized_payload.token, '[REDACTED]');
    assert.match(bruta.payload_hash, /^[0-9a-f]{64}$/);
    assert.ok(bruta.message.length <= 500);
  });
});

test('errors_sanitiza_allowlist_de_campos', async () => {
  const saida = errors.sanitizeForError({ status: 'PAID', extra: 'fora', cpf: '123.456.789-09' }, { allowlist: ['status', 'cpf'] });
  assert.deepEqual(saida.sanitized, { status: 'PAID', cpf: '[REDACTED]' });
  assert.equal(saida.hash.length, 64);
  const texto = errors.sanitizeForError('erro em https://api.banco.com/x?token=abc com 10.0.0.1 e a@b.co');
  assert.ok(!/https?:|10\.0\.0\.1|a@b\.co/.test(texto));
});

test('errors_agrupa_repeticoes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const connId = (await sequelize.query(
      `SELECT id FROM integration.connections WHERE company_id = :c LIMIT 1`, { replacements: { c: tenant.companyId }, transaction }))[0][0]?.id || null;
    let primeira;
    for (let i = 0; i < 5; i += 1) {
      const r = await errors.recordError(ctx, base({ connectionId: connId, errorClass: 'AUTH', errorCode: 'HTTP_401', httpStatus: 401 }), transaction);
      if (i === 0) primeira = r;
      else assert.equal(r.id, primeira.id, 'mesma linha');
    }
    const bruta = await linhaBruta(primeira.id, transaction);
    assert.equal(bruta.attempts, 5);
    assert.equal(bruta.status, 'OPEN');
    // outro código ou outra referência: linha nova
    const outra = await errors.recordError(ctx, base({ connectionId: connId, errorClass: 'AUTH', errorCode: 'HTTP_403' }), transaction);
    assert.notEqual(outra.id, primeira.id);
    const ref1 = '11111111-1111-4111-8111-111111111111';
    const ref2 = '22222222-2222-4222-8222-222222222222';
    const a = await errors.recordError(ctx, base({ sourceRefId: ref1 }), transaction);
    const b = await errors.recordError(ctx, base({ sourceRefId: ref1 }), transaction);
    const c = await errors.recordError(ctx, base({ sourceRefId: ref2 }), transaction);
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, c.id);
    // com referência o agrupamento não depende da janela
    await sequelize.query(`UPDATE integration.integration_errors SET created_at = now() - interval '3 hours' WHERE id = :id`, { replacements: { id: a.id }, transaction });
    assert.equal((await errors.recordError(ctx, base({ sourceRefId: ref1 }), transaction)).id, a.id);
    // sem referência a janela (padrão 10 min) fecha o grupo
    await sequelize.query(`UPDATE integration.integration_errors SET created_at = now() - interval '11 minutes' WHERE id = :id`, { replacements: { id: primeira.id }, transaction });
    const nova = await errors.recordError(ctx, base({ connectionId: connId, errorClass: 'AUTH', errorCode: 'HTTP_401' }), transaction);
    assert.notEqual(nova.id, primeira.id, 'fora da janela abre outra linha');
  });
});

test('errors_janela_de_agrupamento_e_configuravel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('integration.errors.group_window_min', 30, tenant, tenant.userId, transaction);
    const a = await errors.recordError(ctx, base({ errorCode: 'QA_JANELA' }), transaction);
    await sequelize.query(`UPDATE integration.integration_errors SET created_at = now() - interval '20 minutes' WHERE id = :id`, { replacements: { id: a.id }, transaction });
    const b = await errors.recordError(ctx, base({ errorCode: 'QA_JANELA' }), transaction);
    assert.equal(b.id, a.id, 'com janela de 30 min, 20 min atrás ainda agrupa');
    const p = await errors.readErrorParams(ctx, transaction);
    assert.equal(p.groupWindowMin, 30);
    assert.equal(p.retentionDays, 180);
  });
});

test('errors_severidade_padrao', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const sev = async (over) => (await errors.recordError(ctx, base(over), transaction)).severity;
    assert.equal(await sev({ errorClass: 'AUTH', errorCode: 'S1' }), 'HIGH');
    assert.equal(await sev({ errorClass: 'SECURITY', errorCode: 'S2' }), 'HIGH');
    assert.equal(await sev({ errorClass: 'VALIDATION', errorCode: 'S3' }), 'MEDIUM');
    assert.equal(await sev({ errorClass: 'UNKNOWN', errorCode: 'S4', dangerous: true }), 'CRITICAL');
    assert.equal(await sev({ errorClass: 'TRANSIENT', errorCode: 'S5' }), 'LOW');
    assert.equal(await sev({ errorClass: 'RATE_LIMIT', errorCode: 'S6' }), 'LOW');
    // esgotadas as tentativas (padrão 5), TRANSIENT e RATE_LIMIT viram HIGH
    let ultimo;
    for (let i = 0; i < 5; i += 1) ultimo = await errors.recordError(ctx, base({ errorClass: 'TRANSIENT', errorCode: 'S7' }), transaction);
    assert.equal(ultimo.severity, 'HIGH');
    assert.equal((await linhaBruta(ultimo.id, transaction)).severity, 'HIGH');
    // listas fechadas
    await recusa(errors.recordError(ctx, base({ source: 'OUTRA' }), transaction), 'INTEGRATION_ERROR_INVALID', 400);
    await recusa(errors.recordError(ctx, base({ errorClass: 'XYZ' }), transaction), 'INTEGRATION_ERROR_INVALID', 400);
  });
});

test('errors_resolver_exige_nota', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const e = await errors.recordError(ctx, base({ errorCode: 'QA_NOTA' }), transaction);
    for (const nota of [undefined, '', '  ', 'ab', 'x'.repeat(501)]) {
      await recusa(errors.resolveError(e.id, { note: nota }, ctx, transaction), 'INTEGRATION_ERROR_NOTE_REQUIRED', 422);
    }
    const r = await errors.resolveError(e.id, { note: 'Credencial renovada pelo operador' }, ctx, transaction);
    assert.equal(r.status, 'RESOLVED');
    assert.equal(r.resolvedBy, tenant.userId);
    assert.ok(r.resolvedAt);
    const auditoria = await AuditLog.findAll({ where: { entityId: e.id, action: 'integration.error.resolved' }, transaction });
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].beforeJson.status, 'OPEN');
    assert.equal(auditoria[0].afterJson.status, 'RESOLVED');
    await recusa(errors.resolveError(e.id, { note: 'de novo, por favor' }, ctx, transaction), 'INTEGRATION_ERROR_ALREADY_CLOSED', 409);
    const ig = await errors.recordError(ctx, base({ errorCode: 'QA_IGNORAR' }), transaction);
    const igno = await errors.resolveError(ig.id, { note: 'Ruído conhecido do fornecedor', outcome: 'IGNORED' }, ctx, transaction);
    assert.equal(igno.status, 'IGNORED');
    await recusa(errors.resolveError(ig.id, { note: 'tentando reabrir' }, ctx, transaction), 'INTEGRATION_ERROR_ALREADY_CLOSED', 409);
  });
});

test('errors_maquina_de_estados_no_banco', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const e = await errors.recordError(ctx, base({ errorCode: 'QA_ESTADOS' }), transaction);
    const muda = async (para) => {
      await sequelize.query('SAVEPOINT s1', { transaction });
      try {
        await sequelize.query('UPDATE integration.integration_errors SET status = :s WHERE id = :id', { replacements: { s: para, id: e.id }, transaction });
        await sequelize.query('RELEASE SAVEPOINT s1', { transaction });
        return true;
      } catch (err) {
        await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction });
        return false;
      }
    };
    assert.equal(await muda('QUALQUER'), false, 'CHECK da lista fechada');
    assert.equal(await muda('RETRYING'), true);
    assert.equal(await muda('OPEN'), true);
    assert.equal(await muda('RESOLVED'), true);
    assert.equal(await muda('OPEN'), false, 'RESOLVED é final');
    assert.equal(await muda('IGNORED'), false, 'RESOLVED é final');
  });
});

test('errors_resolver_concorrente', async () => {
  for (let rodada = 0; rodada < 3; rodada += 1) {
    let id;
    try {
      id = (await emTransacaoCommitada(tenant, (t) => errors.recordError(ctx, base({ errorCode: `QA_CONC_${rodada}` }), t))).id;
      const resultados = await Promise.allSettled([0, 1].map((n) => emTransacaoCommitada(tenant, (t) => errors.resolveError(id, { note: `Resolvido pela pessoa ${n}` }, ctx, t))));
      const ok = resultados.filter((r) => r.status === 'fulfilled');
      const falhas = resultados.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1, 'uma resolução vence');
      assert.equal(falhas.length, 1);
      assert.equal(falhas[0].reason.code, 'INTEGRATION_ERROR_ALREADY_CLOSED');
      assert.equal(falhas[0].reason.statusCode ?? falhas[0].reason.status, 409);
      const auditorias = await emTransacaoCommitada(tenant, (t) => AuditLog.count({ where: { entityId: id, action: 'integration.error.resolved' }, transaction: t }));
      assert.equal(auditorias, 1, 'uma única auditoria');
    } finally {
      // M9-D244: o runtime não apaga erros de integração (só integration.purge_expired()); a linha de teste fica no banco descartável.
      if (id) await emTransacaoCommitada(tenant, (t) => sequelize.query("UPDATE integration.integration_errors SET status = 'IGNORED' WHERE id = :id AND status = 'OPEN'", { replacements: { id }, transaction: t }));
    }
  }
});

test('errors_rls_isolamento', async () => {
  assert.ok(otherTenant, 'a empresa fictícia B precisa existir (seed-ci-two-tenants)');
  const e = await withRollbackTenantTransaction(tenant, async (transaction) => errors.recordError(ctx, base({ errorCode: 'QA_RLS' }), transaction));
  assert.ok(e.id);
  let idA;
  try {
    idA = (await emTransacaoCommitada(tenant, (t) => errors.recordError(ctx, base({ errorCode: 'QA_RLS_COMMIT' }), t))).id;
    await withRollbackTenantTransaction(otherTenant, async (transaction) => {
      const ctxB = { groupId: otherTenant.groupId, companyId: otherTenant.companyId, userId: otherTenant.userId };
      const lista = await errors.listErrors(ctxB, {}, transaction);
      assert.ok(!lista.items.some((i) => i.id === idA), 'B não lista erro de A');
      const [bruto] = await sequelize.query('SELECT id FROM integration.integration_errors WHERE id = :id', { replacements: { id: idA }, transaction });
      assert.equal(bruto.length, 0);
      await recusa(errors.resolveError(idA, { note: 'tentando resolver o de outra empresa' }, ctxB, transaction), 'INTEGRATION_ERROR_NOT_FOUND', 404);
      await sequelize.query('SAVEPOINT s1', { transaction });
      await assert.rejects(sequelize.query(
        `INSERT INTO integration.integration_errors (group_id, company_id, provider_code, source, error_class, error_code, severity, message)
         VALUES (:g, :c, 'x', 'DISPATCH', 'UNKNOWN', 'X', 'LOW', 'm')`, { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction }));
    });
    const listaA = await emTransacaoCommitada(tenant, (t) => errors.listErrors(ctx, {}, t));
    assert.ok(listaA.items.some((i) => i.id === idA));
  } finally {
    // M9-D244: sem DELETE para o runtime; a linha de teste é encerrada em vez de apagada.
    if (idA) await emTransacaoCommitada(tenant, (t) => sequelize.query("UPDATE integration.integration_errors SET status = 'IGNORED' WHERE id = :id AND status = 'OPEN'", { replacements: { id: idA }, transaction: t }));
  }
});

test('errors_company_id_not_null', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [[col]] = await sequelize.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'integration' AND table_name = 'integration_errors' AND column_name = 'company_id'`, { transaction });
    assert.equal(col.is_nullable, 'NO');
    await recusa(errors.recordError({ groupId: tenant.groupId }, base(), transaction), 'INTEGRATION_ERROR_COMPANY_REQUIRED', 400);
  });
});

test('errors_webhook_canal_desconhecido_contador_sem_payload', async () => {
  const transaction = await sequelize.transaction();
  try {
    const [[antes]] = await sequelize.query('SELECT count(*)::int AS n FROM integration.integration_errors', { transaction });
    const [colunas] = await sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'integration' AND table_name = 'platform_unknown_webhooks'`, { transaction });
    const nomes = colunas.map((c) => c.column_name);
    assert.ok(nomes.length > 0, 'a tabela do contador agregado existe');
    assert.ok(!nomes.includes('company_id'), 'sem empresa');
    assert.ok(!nomes.some((n) => /payload|body|header|raw/.test(n)), 'sem payload');
    for (let i = 0; i < 3; i += 1) await errors.recordUnknownWebhook('canal-que-nao-existe-xyz', transaction);
    await errors.recordUnknownWebhook('financing-sandbox', transaction);
    await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
    const [linhas] = await sequelize.query('SELECT provider_code, hits FROM integration.platform_unknown_webhooks ORDER BY provider_code', { transaction });
    const desconhecido = linhas.find((l) => l.provider_code === '(desconhecido)');
    assert.equal(desconhecido.hits, 3, 'códigos fora do catálogo são agregados num só contador');
    assert.equal(linhas.find((l) => l.provider_code === 'financing-sandbox').hits, 1);
    const [[depois]] = await sequelize.query('SELECT count(*)::int AS n FROM integration.integration_errors', { transaction });
    assert.equal(depois.n, antes.n, 'nenhuma linha de erro de empresa');
  } finally {
    await transaction.rollback().catch(() => {});
  }
});

test('errors_incidente_de_credencial_vencida_abre_erro', async () => {
  const { reportSecretIncident } = require('../../../src/features/integrations/secrets/secretIncidents');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await reportSecretIncident({
      code: 'INTEGRATION_SECRET_EXPIRED', connectionId: null, companyId: tenant.companyId, groupId: tenant.groupId,
      providerCode: 'financing-manual', environment: 'SANDBOX', deadline: new Date(),
    }, { transaction });
    const lista = await errors.listErrors(ctx, { source: 'SECRET' }, transaction);
    const achado = lista.items.find((i) => i.errorCode === 'INTEGRATION_SECRET_EXPIRED');
    assert.ok(achado, 'erro de integração aberto');
    assert.equal(achado.errorClass, 'AUTH');
    assert.equal(achado.severity, 'HIGH');
    assert.equal(achado.status, 'OPEN');
  });
});
