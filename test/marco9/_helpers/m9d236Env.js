'use strict';

// Apoio dos testes da assinatura digital (M9-D236): contrato em SIGNING com duas partes e versão aprovada, connection do fornecedor de assinatura com canal e segredo
// do webhook, pedido de assinatura pelo serviço do Jurídico e eventos assinados nos dois formatos de laboratório. Roda em banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
const crypto = require('node:crypto');
const env = require('./m9d212Env');
const { waiveAllContractRequirements } = require('../../testHelpers');
const settingsService = require('../../../src/features/settings/settings.service');
const signaturesService = require('../../../src/modules/legal/signatures/signature.service');
const contractsService = require('../../../src/modules/legal/contracts/application/contract.service');
const contractVersionsService = require('../../../src/modules/legal/contracts/application/contractVersions.service');
const peopleService = require('../../../src/features/people/people.service');
const personContactsService = require('../../../src/features/people/personContacts.service');
const { File } = require('../../../src/models');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');

const { comTenant, sql, uniqueSuffix } = env;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Contrato de locação em SIGNING com locador e locatário (com e-mail) e a versão aprovada. Devolve { contract, version, landlord, tenantPerson }. */
async function criarContrato(tenant) {
  const suffix = uniqueSuffix();
  return comTenant(tenant, async (t) => {
    const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 }, tenant.userId, t);
    const mk = (nome) => peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `QA-M9 ${nome} ${suffix}` }, tenant.userId, t);
    const tenantPerson = await mk('Locatário');
    const landlord = await mk('Locador');
    await personContactsService.createContact(tenantPerson.id, { contactType: 'EMAIL', valueNormalized: `locatario-${suffix}@qa-m9.test`, isPrimary: true }, tenant.userId, t);
    await personContactsService.createContact(landlord.id, { contactType: 'EMAIL', valueNormalized: `locador-${suffix}@qa-m9.test`, isPrimary: true }, tenant.userId, t);
    await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, t);
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
    await waiveAllContractRequirements(contract.id, tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, t);
    const file = await File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/assinatura/${suffix}.pdf`, fileName: `contrato-${suffix}.pdf`, mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
    const version = await contractVersionsService.createContractVersion(contract.id, { content: `conteúdo do contrato ${suffix}`, documentFileId: file.id }, tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, t);
    return { contract, version, landlord, tenantPerson, suffix };
  });
}

/** Escolhe o fornecedor da empresa e devolve o canal ATIVO dele (connection com segredo do webhook no cofre). `setting`: sandbox | sandbox-alt | clicksign. */
async function conectar(tenant, setting, providerCode, { config } = {}) {
  await comTenant(tenant, (t) => settingsService.upsertSetting('legal.signature_provider', setting, tenant, tenant.userId, t));
  await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: providerCode });
  const canal = await env.criarCanal(tenant, { provider: providerCode });
  if (config) await sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: canal.conn.id, cfg: JSON.stringify(config) });
  await comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', env.ctxDe(tenant), t));
  return canal;
}

const pedirAssinatura = (tenant, version, pessoas) => comTenant(tenant, (t) => signaturesService.initiateSignature(version.id, pessoas.map((p) => p.id), tenant.userId, t));
const assinaturas = (tenant, versionId) => sql(tenant, 'SELECT * FROM legal.signatures WHERE contract_version_id = :v ORDER BY created_at, id', { v: versionId });
const envelopeDe = async (tenant, versionId) => (await sql(tenant, 'SELECT * FROM legal.signature_envelopes WHERE contract_version_id = :v ORDER BY created_at DESC', { v: versionId }))[0];
const statusContrato = async (tenant, contractId) => (await sql(tenant, 'SELECT status FROM legal.contracts WHERE id = :id', { id: contractId }))[0].status;

/** Eventos do formato A (signature-sandbox): signer.signed, envelope.completed, envelope.cancelled. */
const eventoA = (tipo, { envelopeId, signer, signedAt, evidence, documentSha256 } = {}) => ({
  id: `evt-a-${uniqueSuffix()}`, type: tipo, envelope: { id: envelopeId, status: tipo === 'envelope.completed' ? 'completed' : (tipo === 'envelope.cancelled' ? 'cancelled' : 'pending') },
  ...(signer ? { signer } : {}), ...(signedAt ? { signedAt } : {}), ...(evidence ? { evidence } : {}), ...(documentSha256 ? { documentSha256 } : {}),
});

/** Eventos do formato B (signature-alt-sandbox): party.signed, doc.completed, doc.voided (horário em segundos, nomes e códigos diferentes). */
const eventoB = (tipo, { envelopeId, signer, signedAt, evidence, documentSha256 } = {}) => ({
  event_id: `evt-b-${uniqueSuffix()}`, event_type: tipo,
  document: { ref: envelopeId, state: tipo === 'doc.completed' ? 'COMPLETED' : (tipo === 'doc.voided' ? 'VOIDED' : 'WAITING'), ...(documentSha256 ? { original_hash: documentSha256 } : {}) },
  ...(signer ? { party: { uid: signer.id, mail: signer.email, name: signer.name } } : {}),
  ...(evidence || signedAt ? { evidence: { at: Math.floor(new Date(signedAt || Date.now()).getTime() / 1000), remote_ip: evidence && evidence.ip, ua: evidence && evidence.userAgent, auth: evidence && evidence.authMethod } } : {}),
});

/** POST do formato B: HMAC-SHA256 em base64 do corpo bruto no cabeçalho x-alt-signature. */
function enviarB(canal, obj) {
  const corpo = Buffer.from(JSON.stringify(obj));
  return env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, corpo, { 'x-alt-signature': crypto.createHmac('sha256', canal.segredo).update(corpo).digest('base64') });
}

const EVIDENCIA = Object.freeze({ ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (QA-M9)', authMethod: 'EMAIL_TOKEN' });

module.exports = {
  ...env, sha, criarContrato, conectar, pedirAssinatura, assinaturas, envelopeDe, statusContrato, eventoA, eventoB, enviarB, EVIDENCIA, signaturesService,
};
