'use strict';

// Marco 9, M9-D246 — teste de canário: um segredo marcador (SECRET-CANARY-7f3a) entra por connection, webhook e erro de provider
// e NÃO pode aparecer em nenhum log (capturado em memória), auditoria, resposta HTTP ou linha de integration_errors.
// Roda em banco descartável (grava linhas COMMITADAS e depois apaga). Tokens assinados só pelo teste, contra o app de teste.

process.env.PORT = process.env.REDACTION_CANARY_TEST_PORT || '21646';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../../../src/utils/logger');
require('../../../app');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const { signAccessToken } = require('../../../src/utils/jwt');
const errors = require('../../../src/features/integrations/errors');
const { registrarAuditoria } = require('../../../src/engines/audit/auditLog.service');
const { SecretValue } = require('../../../src/features/integrations/secrets/SecretValue');

const CANARIO = 'SECRET-CANARY-7f3a';
let tenant;
let ctx;
let baseUrl;
let token;
const linhasDeLog = [];
const respostas = [];
const idsErro = [];
const idsConexao = [];
let removerTap;

async function comoTenant(fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    const r = await fn(transaction);
    await transaction.commit();
    return r;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  token = signAccessToken({
    sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'],
    permissions: ['integration:read', 'integration:manage', 'integration:retry'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  removerTap = logger.addLogTap((linha) => linhasDeLog.push(linha));
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  removerTap();
  await comoTenant(async (t) => {
    if (idsErro.length) await sequelize.query('DELETE FROM integration.integration_errors WHERE id IN (:ids)', { replacements: { ids: idsErro }, transaction: t });
    if (idsConexao.length) await sequelize.query('DELETE FROM integration.connections WHERE id IN (:ids)', { replacements: { ids: idsConexao }, transaction: t });
  });
  await sequelize.close();
  process.exit(0);
});

async function chamar(method, caminho, { corpo, cabecalhos = {}, semAuth = false } = {}) {
  const r = await fetch(`${baseUrl}${caminho}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(semAuth ? {} : { Authorization: `Bearer ${token}` }), ...cabecalhos },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  respostas.push(texto);
  return { status: r.status, texto };
}

test('secret_canario_nao_aparece_em_logs_auditoria_respostas_erros', async () => {
  // 1) connection: segredo em configuração, em campo solto e em política (recusado com 422), e conexão válida sem segredo.
  for (const corpo of [
    { providerCode: 'financing-manual', environment: 'SANDBOX', label: 'QA-M9 canario a', configJson: { apiKey: CANARIO } },
    { providerCode: 'financing-manual', environment: 'SANDBOX', label: 'QA-M9 canario b', policyJson: { auth: { password: CANARIO } } },
    { providerCode: 'financing-manual', environment: 'SANDBOX', label: 'QA-M9 canario c', token: CANARIO },
    { providerCode: 'financing-manual', environment: 'SANDBOX', label: 'QA-M9 canario d', configJson: { url: `postgres://dono:${CANARIO}@interno/db` } },
  ]) {
    const r = await chamar('POST', '/admin/integrations/registry/connections', { corpo });
    assert.equal(r.status, 422, r.texto);
    assert.match(r.texto, /INTEGRATION_SECRET_IN_CONFIG/);
  }
  const boa = await chamar('POST', '/admin/integrations/registry/connections', {
    corpo: { providerCode: 'financing-manual', environment: 'SANDBOX', label: `QA-M9 canario ok ${Date.now()}` },
  });
  assert.equal(boa.status, 201, boa.texto);
  idsConexao.push(JSON.parse(boa.texto).data.id);

  // 2) webhook: o corpo bruto, o cabeçalho de assinatura e a query carregam o canário.
  const hook = await chamar('POST', `/correspondent/webhooks/financing/financing-sandbox?token=${CANARIO}`, {
    semAuth: true,
    cabecalhos: { 'x-webhook-signature': CANARIO, authorization: `Bearer ${CANARIO}` },
    corpo: { externalCaseId: 'caso-canario', externalEventId: `ev-${Date.now()}`, status: 'PAID', token: CANARIO, rawBody: CANARIO, nested: { client_secret: CANARIO } },
  });
  assert.ok([200, 401].includes(hook.status), hook.texto);

  // 3) erro de provider: mensagem, payload e referência com o canário; mais um erro de rota com o canário na mensagem.
  const e = await comoTenant((t) => errors.recordError(ctx, {
    providerCode: 'financing-sandbox', source: 'DISPATCH', errorClass: 'AUTH', errorCode: 'QA_M9_CANARIO',
    message: `Credencial recusada: token ${CANARIO} e api_key=${CANARIO} e Authorization: Bearer ${CANARIO}`,
    payload: { authorization: `Bearer ${CANARIO}`, detalhe: `client_secret=${CANARIO}`, aninhado: { senha: CANARIO, lista: [`password: ${CANARIO}`] } },
  }, t));
  idsErro.push(e.id);
  const lista = await chamar('GET', '/admin/integrations/errors?status=OPEN');
  assert.equal(lista.status, 200);

  // 4) logs diretos (erro com canário, SecretValue, objeto aninhado) e auditoria de integração com canário.
  logger.error(new Error(`falha do provider com token ${CANARIO}`));
  logger.warn({ err: { message: `Bearer ${CANARIO}` }, conexao: { secret: CANARIO, cofre: new SecretValue(CANARIO) } }, `segredo ${CANARIO} no texto: api_key=${CANARIO}`);
  await comoTenant((t) => registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId, action: 'integration.connection.updated',
    entityType: 'IntegrationConnection', beforeJson: { client_secret: CANARIO }, afterJson: { nota: `password=${CANARIO}`, aninhado: { token: CANARIO } },
    reason: `Troca de credencial api_key=${CANARIO}`,
  }, t));
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 5) varredura de tudo: logs, respostas, auditoria e integration_errors.
  const logs = linhasDeLog.join('');
  assert.ok(logs.length > 0 && logs.includes('[REDACTED]'), 'o logger em memória capturou linhas');
  assert.ok(!logs.includes(CANARIO), `canário em log:\n${logs.split('\n').filter((l) => l.includes(CANARIO)).join('\n')}`);
  assert.ok(!respostas.join('\n').includes(CANARIO), 'canário em resposta HTTP');
  const auditoria = await comoTenant((t) => sequelize.query('SELECT row_to_json(a)::text AS linha FROM audit.audit_log a WHERE correlation_id IS NOT NULL OR reason LIKE :r OR action = :a ORDER BY occurred_at DESC LIMIT 200',
    { replacements: { r: 'Troca de credencial%', a: 'integration.connection.updated' }, transaction: t, type: sequelize.QueryTypes.SELECT }));
  assert.ok(auditoria.some((l) => l.linha.includes('[REDACTED]')), 'a auditoria de teste foi gravada');
  assert.ok(!auditoria.some((l) => l.linha.includes(CANARIO)), 'canário na auditoria');
  const linhasErro = await comoTenant((t) => sequelize.query('SELECT row_to_json(e)::text AS linha FROM integration.integration_errors e', { transaction: t, type: sequelize.QueryTypes.SELECT }));
  assert.ok(linhasErro.some((l) => l.linha.includes('QA_M9_CANARIO')));
  assert.ok(!linhasErro.some((l) => l.linha.includes(CANARIO)), 'canário em integration_errors');
});

test('log_nunca_contem_corpo_bruto_de_webhook', async () => {
  const antes = linhasDeLog.length;
  const evento = `ev-${Date.now()}`;
  const corpo = { externalCaseId: 'caso-corpo-bruto', externalEventId: evento, status: 'PAID', anotacao: 'CORPO-BRUTO-DO-WEBHOOK-7f3a' };
  const r = await chamar('POST', '/correspondent/webhooks/financing/financing-sandbox', {
    semAuth: true, cabecalhos: { 'x-webhook-signature': 'assinatura-invalida' }, corpo,
  });
  assert.ok([200, 401].includes(r.status), r.texto);
  logger.info({ rawBody: JSON.stringify(corpo), providerPayload: corpo }, 'webhook recebido');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const novas = linhasDeLog.slice(antes).join('');
  assert.ok(!novas.includes('CORPO-BRUTO-DO-WEBHOOK-7f3a'), 'o corpo bruto do webhook nunca vai a log');
  const linha = linhasDeLog.slice(antes).find((l) => l.includes('webhook recebido'));
  const registro = JSON.parse(linha);
  assert.equal(registro.rawBody, '[REDACTED]');
  assert.equal(registro.providerPayload, '[REDACTED]');
});
