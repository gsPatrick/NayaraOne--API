'use strict';

// M9-D809 — AUD-016 (JUR-010): o dossiê reúne todos os anexos do contrato (com o hash real) e o download de anexo RESTRICTED passa pelo guard da DLP: sem MFA e sem justificativa
// recusa, e cada pedido gera export_job. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/dlpEnv');
const { request, LONG } = require('../_helpers/dlpGuardKit');
const { contratoComAnexo } = require('../_helpers/m9d809Legal');
const guardService = require('../../../src/features/core-governance/dlp/guard.service');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const evidenceService = require('../../../src/features/legal/evidencePackages.service');
const { withTenantTransaction } = require('../../testHelpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => { resolver.resetResolver(); if (env.DISPOSABLE) await env.cleanJobs(); });
after(async () => { await env.sequelize.close(); });

test('m9d809 AUD-016 anexo RESTRICTED do dossiê exige MFA e justificativa para baixar', { skip: skip() }, async () => {
  const t = tenants.A;
  const { contractId, fileId } = await contratoComAnexo(t);

  // 1) o anexo do contrato entra no manifesto do dossiê, com o hash do arquivo (cadeia de custódia)
  const manifesto = await withTenantTransaction(t, (tx) => evidenceService.assembleManifestFromContractAttachments(contractId, tx));
  assert.ok(manifesto.some((item) => item.type === 'CONTRACT_VERSION_DOCUMENT'), 'o documento da versão do contrato consta no dossiê');

  // 2) o download do anexo RESTRICTED passa pelo guard: o pedido do download é um export_job kind DOWNLOAD
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  const pedido = (over = {}) => guardService.decide(t, request({ actorUserId: t.userId, kind: 'DOWNLOAD', action: 'EXPORT', resourceType: 'files.file', resourceIds: [fileId], estimatedRows: 1, ...over }));

  const semMfa = await pedido({ mfaOk: false });
  assert.equal(semMfa.decision, 'DENY');
  assert.equal(semMfa.blockReason, 'MFA');
  assert.equal(semMfa.errorCode, 'MFA_STEP_UP_REQUIRED');
  assert.equal(semMfa.classification, 'RESTRICTED');
  const jobSemMfa = await env.jobRow(semMfa.job.id);
  assert.deepEqual([jobSemMfa.status, jobSemMfa.kind, jobSemMfa.block_reason], ['BLOCKED', 'DOWNLOAD', 'MFA'], 'o pedido recusado fica registrado como export_job');

  const semJustificativa = await pedido({ mfaOk: true, justification: '' });
  assert.equal(semJustificativa.decision, 'DENY');
  assert.equal((await env.jobRow(semJustificativa.job.id)).status, 'BLOCKED');
  assert.notEqual(semJustificativa.blockReason, 'MFA', 'com MFA, o que falta é a justificativa');

  const completo = await pedido({ mfaOk: true, justification: LONG });
  assert.equal(completo.decision, 'ALLOW');
  const jobCompleto = await env.jobRow(completo.job.id);
  assert.deepEqual([jobCompleto.status, jobCompleto.kind, jobCompleto.classification, jobCompleto.justification], ['APPROVED', 'DOWNLOAD', 'RESTRICTED', LONG]);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs WHERE company_id = $1 AND kind = $2', [t.companyId, 'DOWNLOAD'])).rows[0].n, 3, 'cada pedido gera o seu export_job');
});
