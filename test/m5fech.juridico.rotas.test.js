'use strict';

/**
 * Fechamento do Marco 5 — Jurídico por HTTP real (JWT + middlewares + rotas + RLS): rotas novas do
 * processo (partes, documentos, linha do tempo, dossiê na grafia do Guia §14), conclusão de prazo
 * (§19) e JUR-TS-011 (export sem permissão).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M5FECH_JURIDICO_HTTP_PORT || '5538';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix, createTestResultCenter } = require('./testHelpers');
const { newUser, newCase, newDeadline, fakeFile } = require('./m5fech.juridico.helpers');
const peopleService = require('../src/features/people/people.service');
const evidencePackagesService = require('../src/modules/legal/cases/evidence-package.service');
const noticesService = require('../src/modules/legal/contracts/application/notices.service');
const { signAccessToken } = require('../src/utils/jwt');
const { EvidencePackageAccessLog, LegalDeadline } = require('../src/models');

const GHOST = '00000000-0000-4000-8000-000000000000';
let tenant;
let baseUrl;
const tokenFor = (permissions, userId = tenant.userId) => signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['m5fech'], permissions });

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => { await sequelize.close(); process.exit(0); });

async function call(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, code: json && json.error ? json.error.code : null };
}

test('JR rotas: partes, documentos e linha do tempo do processo pela API; sem legal:create 403; processo inexistente/de outra empresa 404 (§14)', async () => {
  const fx = await withTenantTransaction(tenant, async (t) => ({
    legalCase: await newCase(tenant, t),
    person: await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Parte HTTP JR ${uniqueSuffix()}` }, tenant.userId, t),
    file: await fakeFile(tenant, t),
  }));
  const writer = tokenFor(['legal:read', 'legal:create']);
  const reader = tokenFor(['legal:read']);
  const id = fx.legalCase.id;
  assert.deepEqual([(await call('POST', `/legal/cases/${id}/parties`, reader, { personId: fx.person.id, partyRole: 'DEFENDANT' })).status], [403]);
  const party = await call('POST', `/legal/cases/${id}/parties`, writer, { personId: fx.person.id, partyRole: 'DEFENDANT' });
  assert.equal(party.status, 201, JSON.stringify(party.body));
  assert.equal((await call('GET', `/legal/cases/${id}/parties`, reader)).body.data.length, 1);
  assert.equal((await call('GET', `/legal/cases/${GHOST}/parties`, reader)).code, 'LEGAL_CASE_NOT_FOUND');
  const doc = await call('POST', `/legal/cases/${id}/documents`, writer, { fileId: fx.file.id, purpose: 'EVIDENCE' });
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  assert.equal(doc.body.data.checksumSha256, fx.file.checksumSha256);
  assert.equal((await call('POST', `/legal/cases/${id}/documents`, writer, { fileId: GHOST })).code, 'LEGAL_CASE_DOCUMENT_FILE_NOT_FOUND');
  assert.equal((await call('GET', `/legal/cases/${id}/documents`, reader)).body.data[0].fileId, fx.file.id);
  const timeline = await call('GET', `/legal/cases/${id}/timeline`, reader);
  assert.equal(timeline.status, 200);
  assert.ok(['CASE_OPENED', 'PARTY', 'CASE_CHANGE'].every((type) => timeline.body.data.items.some((i) => i.type === type)));
  assert.equal((await call('GET', `/legal/cases/${GHOST}/timeline`, reader)).status, 404);
  assert.equal((await call('GET', `/legal/cases/${id}/timeline`, tokenFor(['finance:read']))).code, 'PERMISSION_DENIED');
});

test('JR rotas: POST /legal/cases/:id/evidence-package (grafia do Guia §14) gera o dossiê com manifesto e hash, igual à rota no plural', async () => {
  const legalCase = await withTenantTransaction(tenant, (t) => newCase(tenant, t));
  const writer = tokenFor(['legal:read', 'legal:create']);
  const items = [{ type: 'NOTE', description: 'Nota fictícia do dossiê' }];
  const singular = await call('POST', `/legal/cases/${legalCase.id}/evidence-package`, writer, { manifestItems: items });
  assert.equal(singular.status, 201, JSON.stringify(singular.body));
  const plural = await call('POST', `/legal/cases/${legalCase.id}/evidence-packages`, writer, { manifestItems: items });
  assert.equal(plural.status, 201);
  assert.equal(singular.body.data.packageHash, plural.body.data.packageHash, 'mesmo manifesto, mesmo hash');
  assert.equal(singular.body.data.packageHash, evidencePackagesService.computePackageHash(singular.body.data.manifestJson));
  assert.equal((await call('POST', `/legal/cases/${legalCase.id}/evidence-package`, tokenFor(['legal:read']), { manifestItems: items })).code, 'PERMISSION_DENIED');
  assert.equal((await call('POST', `/legal/cases/${legalCase.id}/evidence-package`, writer, {})).code, 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
});

test('JR rotas: concluir prazo — sem legal:update 403; com legal:update sem ser responsável nem ter legal:approve 403 LEGAL_DEADLINE_NOT_RESPONSIBLE; sem prova 422; o responsável conclui (§19)', async () => {
  const fx = await withTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const outsider = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: null, escalationUserId: null });
    return { owner, outsider, d: await newDeadline(legalCase.id, tenant, t, { responsibleUserId: owner.id }) };
  });
  const body = { status: 'DONE', conclusionNote: 'Contestação protocolada.' };
  const path = `/legal/deadlines/${fx.d.id}`;
  assert.equal((await call('PATCH', path, tokenFor(['legal:read', 'legal:create'], fx.owner.id), body)).code, 'PERMISSION_DENIED');
  const outsider = await call('PATCH', path, tokenFor(['legal:read', 'legal:update'], fx.outsider.id), body);
  assert.deepEqual([outsider.status, outsider.code], [403, 'LEGAL_DEADLINE_NOT_RESPONSIBLE']);
  const noProof = await call('PATCH', path, tokenFor(['legal:update'], fx.owner.id), { status: 'DONE' });
  assert.deepEqual([noProof.status, noProof.code], [422, 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED']);
  assert.equal((await withTenantTransaction(tenant, (t) => LegalDeadline.findByPk(fx.d.id, { transaction: t }))).status, 'PENDING');
  const ok = await call('PATCH', path, tokenFor(['legal:update'], fx.owner.id), body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'DONE');
});

test('JUR-TS-011: exportar dossiê sem a permissão específica legal:evidence:export é negado (403 PERMISSION_DENIED, inclusive só com legal:read) sem registro EXPORTED; outra empresa/inexistente 404; com a permissão a DLP ainda exige finalidade e MFA (classe HIGH)', async () => {
  // Usuário novo, sem nenhum MFA recente: o resultado não depende de outro teste ter feito step-up com o admin do seed.
  const { pkg, exporter } = await withTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    return { pkg: await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'NOTE', description: 'Prova fictícia (sem arquivo)' }], tenant.userId, t), exporter: await newUser(tenant, t) };
  });
  const exportedCount = () => withTenantTransaction(tenant, (t) => EvidencePackageAccessLog.count({ where: { evidencePackageId: pkg.id, action: 'EXPORTED' }, transaction: t }));
  const path = `/legal/evidence-packages/${pkg.id}/export`;
  const EXPORT = ['legal:read', 'legal:evidence:export'];
  const denied = await call('GET', path, tokenFor(['finance:read']));
  assert.deepEqual([denied.status, denied.code], [403, 'PERMISSION_DENIED']);
  // §19 "Permissão específica": legal:read sozinho não exporta.
  const readOnly = await call('GET', path, tokenFor(['legal:read']));
  assert.deepEqual([readOnly.status, readOnly.code], [403, 'PERMISSION_DENIED']);
  assert.equal(readOnly.body.error.details.required, 'legal:evidence:export');
  assert.equal((await call('GET', `/legal/evidence-packages/${GHOST}/export`, tokenFor(EXPORT))).code, 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND');
  const noPurpose = await call('GET', path, tokenFor(EXPORT, exporter.id));
  assert.deepEqual([noPurpose.status, noPurpose.code], [422, 'GOV_DLP_PURPOSE_REQUIRED']);
  const noMfa = await call('GET', `${path}?purpose=JURIDICO&justification=${encodeURIComponent('Entrega do dossiê ao advogado da causa')}`, tokenFor(EXPORT, exporter.id));
  assert.deepEqual([noMfa.status, noMfa.code], [403, 'MFA_STEP_UP_REQUIRED']);
  assert.equal(await exportedCount(), 0, 'nenhuma exportação recusada entra na custódia como EXPORTED');
});

test('JR rotas: recebível do processo exige legal:approve E finance:create e só sai com valor confirmado; versões da notificação pela API', async () => {
  const fx = await withTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const legalCase = await newCase(tenant, t, { estimatedAmount: 9000 });
    const notice = await noticesService.createNotice({ legalCaseId: legalCase.id, channel: 'EMAIL', content: 'Aviso v1' }, tenant.userId, t);
    return { rc, legalCase, notice };
  });
  const body = { basis: 'FINAL_JUDGMENT', basisReference: 'Sentença fictícia transitada', dueAt: '2030-06-01', resultCenterId: fx.rc.id };
  const path = `/legal/cases/${fx.legalCase.id}/receivables`;
  assert.equal((await call('POST', path, tokenFor(['legal:read', 'legal:approve']), body)).code, 'PERMISSION_DENIED', 'falta finance:create');
  assert.equal((await call('POST', path, tokenFor(['legal:read', 'finance:create']), body)).code, 'PERMISSION_DENIED', 'falta legal:approve');
  const full = tokenFor(['legal:read', 'legal:update', 'legal:approve', 'finance:create']);
  assert.equal((await call('POST', path, full, body)).code, 'LEGAL_CASE_RECEIVABLE_NOT_CONFIRMED', 'estimativa não vira recebível');
  assert.equal((await call('PATCH', `/legal/cases/${fx.legalCase.id}`, full, { confirmedAmount: 7000 })).status, 200);
  const ok = await call('POST', path, full, body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(Number(ok.body.data.amount), 7000);
  assert.equal((await call('GET', path, tokenFor(['legal:read']))).body.data.length, 1);

  const versions = `/legal/notices/${fx.notice.id}/versions`;
  assert.equal((await call('POST', versions, tokenFor(['legal:read']), { content: 'v2', reason: 'Correção' })).code, 'PERMISSION_DENIED');
  const v2 = await call('POST', versions, full, { content: 'Aviso v2 corrigido', reason: 'Correção do destinatário' });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  const list = await call('GET', versions, tokenFor(['legal:read']));
  assert.deepEqual(list.body.data.map((v) => v.versionNumber), [1, 2]);
  assert.equal(list.body.data[0].content, 'Aviso v1', 'a versão anterior está preservada');
});

test('Pentest JR (HTTP): objeto no lugar de texto/uuid no dossiê ({"$gt":""}) é 400 com o código do Jurídico, nunca 500', async () => {
  const legalCase = await withTenantTransaction(tenant, (t) => newCase(tenant, t));
  const writer = tokenFor(['legal:read', 'legal:create']);
  const res = await call('POST', `/legal/cases/${legalCase.id}/evidence-package`, writer, { manifestItems: [{ type: { $gt: '' }, description: { $gt: '' }, fileId: { $gt: '' }, hash: { $gt: '' } }, { type: { $gt: '' }, description: { $gt: '' } }] });
  assert.deepEqual([res.status, res.code], [400, 'LEGAL_EVIDENCE_PACKAGE_VALIDATION']);
  const auto = await call('POST', `/legal/cases/${legalCase.id}/evidence-packages/auto`, writer, { extraManifestItems: { $gt: '' } });
  assert.equal(auto.status, 400);
});

