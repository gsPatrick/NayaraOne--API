'use strict';

// M9-D809 — AUD-016 (JUR-010): o dossiê reúne todos os anexos do contrato (com o hash real) e o download de anexo RESTRICTED passa pelo guard da DLP: sem MFA e sem justificativa
// recusa, e cada pedido gera export_job. Desde a M9-D920 o teste chama as ROTAS reais (GET /files/:id/content e GET /legal/evidence-packages/:id/export), não só o guard. Banco descartável.
// porta aleatória: portas fixas colidem com a API de outro teste que esteja de pé ao mesmo tempo
process.env.PORT = process.env.M9D809_AUD016_TEST_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d920Env');
const evidenceService = require('../../../src/modules/legal/cases/evidence-package.service');
const legalCasesService = require('../../../src/modules/legal/cases/legal-case.service');
const contractsService = require('../../../src/modules/legal/contracts/application/contract.service');
const contractVersionsService = require('../../../src/modules/legal/contracts/application/contractVersions.service');
const { withTenantTransaction } = require('../../testHelpers');

let http; let A; let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { 'legal:read': true, 'governance:dlp:view-restricted': true } });
  http = await env.start(process.env.PORT);
  A = http.tenants.A;
});
afterEach(async () => { if (env.DISPOSABLE) await env.reset(); });
after(async () => { if (env.DISPOSABLE) { await env.reset(); await restore(); } await stopHttp({}); });

const jobsOf = async (kind) => (await env.adminQuery('SELECT * FROM governance.export_jobs WHERE kind = $1 ORDER BY requested_at', [kind])).rows;

test('m9d809 AUD-016 anexo RESTRICTED do dossiê exige MFA e justificativa para baixar', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'RESTRICTED', fileName: 'contrato.pdf' });
  const { contractId, caseId, packageId } = await withTenantTransaction(A, async (tx) => {
    const contract = await contractsService.createContract({ groupId: A.groupId, companyId: A.companyId, contractType: 'LEASE', totalValue: 1000 }, A.userId, tx);
    await contractVersionsService.createContractVersion(contract.id, { content: 'QA-M9 corpo do contrato', documentFileId: file.id }, A.userId, tx);
    const legalCase = await legalCasesService.createLegalCase({ groupId: A.groupId, companyId: A.companyId, contractId: contract.id, caseType: 'COLLECTION' }, A.userId, tx);
    const pack = await evidenceService.createEvidencePackageFromContractAttachments(legalCase.id, A.userId, tx);
    return { contractId: contract.id, caseId: legalCase.id, packageId: pack.id };
  });
  assert.ok(contractId && caseId);

  // 1) o anexo do contrato entra no manifesto do dossiê, com o hash real do arquivo (cadeia de custódia)
  const manifesto = (await env.adminQuery('SELECT manifest_json FROM legal.evidence_packages WHERE id = $1', [packageId])).rows[0].manifest_json;
  const item = manifesto.find((entry) => entry.type === 'CONTRACT_VERSION_DOCUMENT');
  assert.ok(item, 'o documento da versão do contrato consta no dossiê');
  assert.equal(item.hash, file.sha256);

  // 2) GET /files/:id/content do anexo RESTRICTED: sem MFA recusa e o pedido fica registrado como export_job kind DOWNLOAD
  await env.revokeMfa(A.userId);
  const semMfa = await env.raw(http, 'gestorA', `/files/${file.id}/content?${env.query()}`);
  assert.equal(semMfa.status, 403);
  const semMfaBody = await semMfa.json();
  assert.equal(semMfaBody.error.code, 'MFA_STEP_UP_REQUIRED');
  const bloqueado = (await jobsOf('DOWNLOAD')).find((job) => job.id === semMfaBody.error.details.exportJobId);
  assert.deepEqual([bloqueado.status, bloqueado.kind, bloqueado.block_reason, bloqueado.classification], ['BLOCKED', 'DOWNLOAD', 'MFA', 'RESTRICTED'], 'o pedido recusado fica registrado como export_job');

  await env.grantMfa(A);
  await env.clearSignals();
  const semJustificativa = await env.raw(http, 'gestorA', `/files/${file.id}/content`);
  assert.equal(semJustificativa.status, 422);
  const semBody = await semJustificativa.json();
  assert.equal(semBody.error.code, 'GOV_DLP_PURPOSE_REQUIRED');
  assert.equal((await jobsOf('DOWNLOAD')).find((job) => job.id === semBody.error.details.exportJobId).status, 'BLOCKED');

  await env.clearSignals();
  const completo = await env.raw(http, 'gestorA', `/files/${file.id}/content?${env.query()}`);
  assert.equal(completo.status, 200);
  assert.ok(Buffer.from(await completo.arrayBuffer()).equals(file.buffer));
  const aprovado = (await jobsOf('DOWNLOAD')).find((job) => job.status === 'READY');
  assert.deepEqual([aprovado.kind, aprovado.classification, aprovado.justification], ['DOWNLOAD', 'RESTRICTED', env.JUSTIFICATION]);
  assert.equal((await jobsOf('DOWNLOAD')).length, 3, 'cada pedido gera o seu export_job');

  // 3) a exportação do dossiê herda a classe do anexo e passa pelo guard
  await env.clearSignals();
  await env.revokeMfa(A.userId);
  const exportSemMfa = await http.call('gestorA', 'GET', `/legal/evidence-packages/${packageId}/export?${env.query()}`);
  assert.deepEqual([exportSemMfa.status, exportSemMfa.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  const exportJob = (await jobsOf('EXPORT')).find((job) => job.id === exportSemMfa.body.error.details.exportJobId);
  assert.deepEqual([exportJob.status, exportJob.classification, exportJob.resource_type], ['BLOCKED', 'RESTRICTED', 'legal.evidence_package'], 'a classe do anexo vale para o dossiê');
  await env.grantMfa(A);
  await env.clearSignals();
  const exportSemJustificativa = await http.call('gestorA', 'GET', `/legal/evidence-packages/${packageId}/export`);
  assert.deepEqual([exportSemJustificativa.status, exportSemJustificativa.body.error.code], [422, 'GOV_DLP_PURPOSE_REQUIRED']);
  await env.clearSignals();
  const exportOk = await http.call('gestorA', 'GET', `/legal/evidence-packages/${packageId}/export?${env.query()}`);
  assert.equal(exportOk.status, 200, JSON.stringify(exportOk.body));
  assert.equal(exportOk.body.data.evidencePackageId, packageId);
  assert.equal(exportOk.body.data.manifest.length, manifesto.length);
});
