'use strict';

// Dados de partida de qualidade de dados, DLP e exportação para o contract test (M9-D842, não é teste). Banco descartável.
const { withTenantTransaction } = require('../../testHelpers');
const dq = require('./m9d805Env');
const bulk = require('./m9d808Env');
const exportsEnv = require('./exportsEnv');
const { encryptSecret } = require('../../../src/utils/mfaCrypto');
const { generateExport } = require('../../../src/features/core-governance/dlp/exports/export.run');
const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');

/** Par de pessoas duplicadas na fila de merge; o gestor é curador do domínio PESSOAS. */
async function dqQueueItem(_vars, { tenants }) {
  const A = tenants.A;
  const item = await withTenantTransaction(A, async (tx) => {
    await stewardship.designate(A, dq.actorOf(A), 'PESSOAS', { designations: [{ role: 'STEWARD', userId: A.userId }] }, tx);
    const first = await dq.person(A, tx, { legalName: 'QA-M9 Contrato Duplicada' });
    const second = await dq.person(A, tx, { legalName: 'QA-M9 Contrato Duplicada' });
    return dq.candidate(A, tx, 'PERSON', first.id, second.id);
  });
  return { queueItemId: item.id };
}

/** Três imóveis numa cidade única, para o lote de alteração em massa. */
async function bulkProperties(_vars, { tenants }) {
  const { city } = await withTenantTransaction(tenants.A, (tx) => bulk.properties(tenants.A, tx, 3));
  return { bulkCity: city };
}

/** Anomalia de acesso em massa aberta para o perfil maker, à espera da revisão humana. */
async function dlpAnomaly(vars, { tenants }) {
  const A = tenants.A;
  const { rows: [row] } = await exportsEnv.adminQuery(
    `INSERT INTO governance.access_anomalies (group_id, company_id, user_id, kind, status, window_minutes, trigger_signals)
     VALUES ($1, $2, $3, 'READ', 'OPEN', 10, '{"total":3}'::jsonb) RETURNING id`, [A.groupId, A.companyId, vars.makerUserId]
  );
  return { anomalyId: row.id };
}

/** Três lançamentos numa competência nova: a exportação financeira tem o que exportar. */
async function exportEntries(_vars, { tenants }) {
  const month = exportsEnv.uniqueMonth();
  exportsEnv.useMonth(month);
  await exportsEnv.seedEntries(tenants.A, 3);
  return { exportMonth: month };
}

/** Gera o arquivo do pedido como o job assíncrono faz e confere que ficou pronto, antes do download. */
async function exportReady(vars, { tenants }) {
  await generateExport({ groupId: tenants.A.groupId, companyId: tenants.A.companyId }, vars.exportId);
  const job = await exportsEnv.jobOf(vars.exportId);
  if (!job || job.status !== 'READY') throw new Error(`o pedido de exportação ficou ${job && job.status} em vez de READY`);
  return {};
}

/** MFA habilitado para o gestor SEM verificação recente (inserção no cluster descartável, nenhum endpoint de MFA): as ações críticas passam a pedir o passo de verificação. */
async function mfaEnabled(_vars, { tenants }) {
  const A = tenants.A;
  await exportsEnv.adminQuery(
    `INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, now(), '{}', now(), now()) ON CONFLICT (user_id) DO NOTHING`, [A.userId, A.groupId, A.companyId, encryptSecret('JBSWY3DPEHPK3PXP')]
  );
  return {};
}

module.exports = { mfaEnabled, dqQueueItem, bulkProperties, dlpAnomaly, exportEntries, exportReady };
