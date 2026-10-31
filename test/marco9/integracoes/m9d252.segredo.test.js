'use strict';

// Marco 9, M9-D252 — teste adversarial 9 do livro (seção 19): o marcador SECRET-CANARY entra por connection, webhook e erro de provider e NÃO aparece em log (capturado em memória), auditoria,
// resposta HTTP nem integration_errors. Banco descartável (grava linhas COMMITADAS). Tokens assinados só pelo teste, contra o app de teste.
process.env.PORT = process.env.M9D252_SEGREDO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../../src/utils/logger');
require('../../../app');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const { signAccessToken } = require('../../../src/utils/jwt');
const errors = require('../../../src/features/integrations/errors');
const { registrarAuditoria } = require('../../../src/engines/audit/auditLog.service');
const { SecretValue } = require('../../../src/features/integrations/secrets/SecretValue');

const SECRET_CANARY = 'SECRET-CANARY-d252-9b41';
let tenant; let ctx; let baseUrl; let token; let removerTap;
const linhasDeLog = []; const respostas = []; const idsErro = []; const idsConexao = [];

async function comoTenant(fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    const r = await fn(transaction);
    await transaction.commit();
    return r;
  } catch (err) { await transaction.rollback().catch(() => {}); throw err; }
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: ['integration:read', 'integration:manage', 'integration:retry'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  removerTap = logger.addLogTap((linha) => linhasDeLog.push(linha));
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => {
  removerTap();
  await comoTenant(async (t) => {
    if (idsErro.length) await sequelize.query("UPDATE integration.integration_errors SET status = 'IGNORED' WHERE id IN (:ids) AND status = 'OPEN'", { replacements: { ids: idsErro }, transaction: t });
    if (idsConexao.length) await sequelize.query('DELETE FROM integration.connections WHERE id IN (:ids)', { replacements: { ids: idsConexao }, transaction: t });
  });
  await sequelize.close();
  process.exit(0);
});

async function chamar(method, caminho, { corpo, cabecalhos = {}, semAuth = false } = {}) {
  const r = await fetch(`${baseUrl}${caminho}`, { method, headers: { 'Content-Type': 'application/json', ...(semAuth ? {} : { Authorization: `Bearer ${token}` }), ...cabecalhos }, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  respostas.push(texto);
  return { status: r.status, texto };
}

test('adv_secret_em_log_canario_nao_aparece', async () => {
  // 1) connection: segredo em configuração, em política, em campo solto e dentro de uma URL de conexão; todos recusados com 422; uma conexão válida sem segredo é criada.
  for (const corpo of [
    { configJson: { apiKey: SECRET_CANARY } }, { policyJson: { auth: { password: SECRET_CANARY } } }, { token: SECRET_CANARY }, { configJson: { url: `postgres://dono:${SECRET_CANARY}@interno/db` } },
  ]) {
    const r = await chamar('POST', '/admin/integrations/registry/connections', { corpo: { providerCode: 'financing-manual', environment: 'SANDBOX', label: 'QA-M9 canario d252', ...corpo } });
    assert.equal(r.status, 422, r.texto);
    assert.match(r.texto, /INTEGRATION_SECRET_IN_CONFIG/);
  }
  const boa = await chamar('POST', '/admin/integrations/registry/connections', { corpo: { providerCode: 'financing-manual', environment: 'SANDBOX', label: `QA-M9 canario d252 ok ${Date.now()}` } });
  assert.equal(boa.status, 201, boa.texto);
  idsConexao.push(JSON.parse(boa.texto).data.id);

  // 2) webhook: o corpo bruto, o cabeçalho de assinatura e a query carregam o canário.
  const hook = await chamar('POST', `/correspondent/webhooks/financing/financing-sandbox?token=${SECRET_CANARY}`, {
    semAuth: true,
    cabecalhos: { 'x-webhook-signature': SECRET_CANARY, authorization: `Bearer ${SECRET_CANARY}` },
    corpo: { externalCaseId: 'caso-canario-d252', externalEventId: `ev-${Date.now()}`, status: 'PAID', token: SECRET_CANARY, rawBody: SECRET_CANARY, nested: { client_secret: SECRET_CANARY } },
  });
  assert.ok([200, 401].includes(hook.status), hook.texto);

  // 3) erro de provider com o canário na mensagem, no payload e em lista aninhada; depois a listagem de erros pela API.
  const e = await comoTenant((t) => errors.recordError(ctx, {
    providerCode: 'financing-sandbox', source: 'DISPATCH', errorClass: 'AUTH', errorCode: 'QA_M9_CANARIO_D252',
    message: `Credencial recusada: token ${SECRET_CANARY} e api_key=${SECRET_CANARY} e Authorization: Bearer ${SECRET_CANARY}`,
    payload: { authorization: `Bearer ${SECRET_CANARY}`, detalhe: `client_secret=${SECRET_CANARY}`, aninhado: { senha: SECRET_CANARY, lista: [`password: ${SECRET_CANARY}`] } },
  }, t));
  idsErro.push(e.id);
  assert.equal((await chamar('GET', '/admin/integrations/errors?status=OPEN')).status, 200);

  // 4) logs diretos (erro, SecretValue, objeto aninhado) e auditoria de integração com o canário.
  logger.error(new Error(`falha do provider com token ${SECRET_CANARY}`));
  logger.warn({ err: { message: `Bearer ${SECRET_CANARY}` }, conexao: { secret: SECRET_CANARY, cofre: new SecretValue(SECRET_CANARY) } }, `segredo ${SECRET_CANARY} no texto: api_key=${SECRET_CANARY}`);
  await comoTenant((t) => registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId, action: 'integration.connection.updated', entityType: 'IntegrationConnection',
    beforeJson: { client_secret: SECRET_CANARY }, afterJson: { nota: `password=${SECRET_CANARY}`, aninhado: { token: SECRET_CANARY } }, reason: `Troca de credencial d252 api_key=${SECRET_CANARY}`,
  }, t));
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  // 5) varredura de logs, respostas, auditoria e integration_errors.
  const logs = linhasDeLog.join('');
  assert.ok(logs.includes('[REDACTED]'), 'o logger em memória capturou linhas redigidas');
  assert.ok(!logs.includes('SECRET-CANARY'), `canário em log:\n${logs.split('\n').filter((l) => l.includes('SECRET-CANARY')).join('\n')}`);
  assert.ok(!respostas.join('\n').includes('SECRET-CANARY'), 'canário em resposta HTTP');
  const auditoria = await comoTenant((t) => sequelize.query('SELECT row_to_json(a)::text AS linha FROM audit.audit_log a WHERE reason LIKE :r OR action = :a ORDER BY occurred_at DESC LIMIT 200',
    { replacements: { r: 'Troca de credencial d252%', a: 'integration.connection.updated' }, transaction: t, type: sequelize.QueryTypes.SELECT }));
  assert.ok(auditoria.some((l) => l.linha.includes('Troca de credencial d252') && l.linha.includes('[REDACTED]')), 'a auditoria de teste foi gravada, redigida');
  assert.ok(!auditoria.some((l) => l.linha.includes('SECRET-CANARY')), 'canário na auditoria');
  const linhasErro = await comoTenant((t) => sequelize.query('SELECT row_to_json(x)::text AS linha FROM integration.integration_errors x', { transaction: t, type: sequelize.QueryTypes.SELECT }));
  assert.ok(linhasErro.some((l) => l.linha.includes('QA_M9_CANARIO_D252')), 'o erro de teste foi gravado');
  assert.ok(!linhasErro.some((l) => l.linha.includes('SECRET-CANARY')), 'canário em integration_errors');
});
