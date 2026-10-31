'use strict';

// Apoio dos testes M9-D907 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados; `cleanup` apaga o que a demanda grava.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./m9d904Env');
const dry = require('../../../src/features/migration-v2/dryrun');
const { exportReport } = require('../../../src/features/migration-v2/dryrun/dry.export');
const types = require('../../../src/features/migration-v2/rollback/types.service');
const report = require('../../../src/features/migration-v2/rollback/report.service');
const items = require('../../../src/features/migration-v2/rollback/items.service');
const cutover = require('../../../src/features/migration-v2/rollback/cutover.service');
const logService = require('../../../src/features/migration-v2/rollback/log.service');
const tower = require('../../../src/features/migration-v2/control/tower.service');
const dispatchService = require('../../../src/features/integrations/dispatch');

const { openTenantTx, adminQuery, tenantOf } = env;
const actor = (tenant) => ({ userId: tenant.userId });
const tx = (tenant, fn) => openTenantTx(tenant, (t) => fn(tenantOf(tenant), t));

const listTypes = (tenant) => tx(tenant, (tn, t) => types.listTypes(tn, t));
const putTypes = (tenant, list) => tx(tenant, (tn, t) => types.putTypes(tn, actor(tenant), { types: list }, t));
// O GO exige o relatório do DRY3 exportado e assinado (M9-D908; sem efeito colateral de import, M9-D907 L6): os testes que não tratam desse pré-requisito recebem um relatório verde, a menos que já tenham escolhido o seu.
const decide = async (tenant, decision, extra = {}) => {
  if (decision === 'GO' && !process.env.MIGRATION_DRY3_REPORT_PATH) await markRollbackSimulated(tenant, true);
  return tx(tenant, (tn, t) => cutover.decide(tn, actor(tenant), { decision, ...extra }, t));
};
const getReport = (tenant, query = {}) => tx(tenant, (tn, t) => report.getReport(tn, query, t));
const resolveItem = (tenant, id, body = {}) => tx(tenant, (tn, t) => items.resolveItem(tn, actor(tenant), id, body, t));
const record = (tenant, op) => tx(tenant, (tn, t) => logService.recordExternalOp(tn, op, t));
// Execução sem fonte nem entidade só para a Torre olhar a empresa toda: sem ela a Torre usa a execução mais recente, que pode ser de outro teste e filtrar os blockers. Já nasce encerrada: a M9-D900 conta as execuções ativas da empresa.
const towerBlockers = async (tenant, code) => {
  const runId = (await adminQuery("INSERT INTO governance.mig_runs (group_id, company_id, status, finished_at) VALUES ($1, $2, 'SUCCEEDED', now()) RETURNING id", [tenant.groupId, tenant.companyId])).rows[0].id;
  return (await tx(tenant, (tn, t) => tower.getTower(tn, actor(tenant), { runId }, t))).blockers.filter((b) => !code || b.code === code);
};

/** Tipos completos mínimos para o GO (o inventário semeado já vem completo; o teste só ajusta o que precisa). */
const goodType = (code, extra = {}) => ({
  code, module: 'QA', reversibility: 'IRREVERSIBLE', compensation: `Compensação de ${code}.`, procedure: `Procedimento de ${code}.`, owner: 'QA-M9', entity: 'QA907_ENTITY', ...extra,
});

/** Conexão e envio reais (tabela integration.dispatches), pelo caminho de produção: createDispatch. */
async function connection(tenant, domain = 'BANK') {
  const h = require('../../integrations/dispatch/dispatchHelpers');
  return h.conexao({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, domain);
}
const sendDispatch = (tenant, connectionId, operation, key, snapshot = { amount: '100.00' }, extra = {}) => openTenantTx(tenant, (t) => dispatchService.createDispatch(
  { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, { connectionId, operation, idempotencyKey: key, snapshot, aggregateId: extra.aggregateId, criticalityOp: extra.criticalityOp }, t
));

const logRows = async (tenant, where = 'true') => (await adminQuery(`SELECT * FROM governance.external_op_log WHERE company_id = $1 AND ${where} ORDER BY executed_at, id`, [tenant.companyId])).rows;
const itemRows = async (tenant) => (await adminQuery('SELECT * FROM governance.rollback_items WHERE company_id = $1 ORDER BY created_at, id', [tenant.companyId])).rows;
const fail = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));

/**
 * Relatório DRY3 exportado e assinado com o critério da simulação de rollback (M9-D908): o GO só reconhece o relatório do arquivo exportado, não o banco do ensaio. Usa um arquivo
 * temporário e uma chave de assinatura só de teste (nunca a de um ambiente real).
 */
async function markRollbackSimulated(tenant, ok = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d907-'));
  process.env.MIGRATION_DRY3_REPORT_PATH = path.join(dir, 'dry3-report.json');
  process.env.MIGRATION_DRY3_SIGNING_KEY = 'chave-de-teste-nao-usar-em-producao';
  dry.install();
  exportReport({ id: `qa-m9-${tenant.companyId}`, conclusion: 'APROVADO', criteria: { rollback_simulated: { ok } }, commit: 'qa-m9-commit' });
}

/** Apaga o relatório exportado do teste e solta o caminho (o GO volta a não encontrar relatório). */
function dropExportedReport() {
  try { if (process.env.MIGRATION_DRY3_REPORT_PATH) fs.rmSync(process.env.MIGRATION_DRY3_REPORT_PATH, { force: true }); } catch (_err) { /* caminho de teste inexistente (ENOTDIR): nada a apagar */ }
  delete process.env.MIGRATION_DRY3_REPORT_PATH;
}

/** Apaga o que a demanda gravou na empresa (itens, registro, decisões, tipos, parâmetro, envios e conexões de teste, blockers). */
async function cleanup(tenant) {
  const c = tenant.companyId;
  await adminQuery('DELETE FROM governance.rollback_items WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.external_op_log WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.external_op_types WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.cutover_decisions WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.mig_dry_reports WHERE company_id = $1', [c]);
  await adminQuery("DELETE FROM governance.mig_blockers WHERE company_id = $1 AND code LIKE 'GOV_ROLLBACK_%'", [c]);
  await adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'migracao.rollback.itens_por_pagina'", [c]);
  await adminQuery("ALTER TABLE integration.dispatches DISABLE TRIGGER USER").catch(() => {});
  await adminQuery("DELETE FROM integration.dispatches WHERE company_id = $1 AND idempotency_key LIKE 'qa907-%'", [c]).catch(() => {});
  await adminQuery("ALTER TABLE integration.dispatches ENABLE TRIGGER USER").catch(() => {});
  dropExportedReport();
  await env.cleanup(tenant);
}

module.exports = { ...env, actor, tx, listTypes, putTypes, decide, getReport, resolveItem, record, towerBlockers, goodType, markRollbackSimulated, connection, sendDispatch, logRows, itemRows, fail, cleanup, logService, dispatchService };
