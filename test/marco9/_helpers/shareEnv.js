'use strict';

// Apoio dos testes M9-D823 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Links, pedidos e contratos de teste são gravados de verdade (commit).
const env = require('./exportsEnv');
const { Person, ContractParty } = require('../../../src/models');
const contractsService = require('../../../src/features/legal/contracts.service');
const { createShareLink } = require('../../../src/features/core-governance/dlp/share/share.service');

const tenantOf = (t) => ({ groupId: t.groupId, companyId: t.companyId });
const JUSTIFICATION = env.JUSTIFICATION;

/** Contrato de locação com uma parte (nome e CPF de teste), para o link mostrar campos em claro e mascarados. */
async function makeContract(tenant) {
  return env.inBusinessTx(tenant, async (transaction) => {
    const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 }, tenant.userId, transaction);
    const cpf = env.uniqueCpf();
    const person = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, legalName: 'Maria QA-M9 Locatária', taxIdNormalized: cpf }, { transaction });
    await ContractParty.create({ groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, personId: person.id, partyRole: 'TENANT' }, { transaction });
    contract.qaCpf = cpf;
    return contract;
  });
}

const body = (contract, over = {}) => ({
  resourceType: 'legal.contract', resourceId: contract.id, recipientLabel: 'Cliente QA-M9', purpose: 'CLIENTE_SOLICITOU', justification: JUSTIFICATION, ...over,
});

/** createShareLink como a rota faz: transação da requisição + chave de idempotência (nova por padrão). */
function share(tenant, contract, over = {}, { key, actorUserId, permissions } = {}) {
  const actor = actorUserId || tenant.userId;
  return env.inBusinessTx({ ...tenant, userId: actor }, (transaction) => createShareLink({
    tenant: tenantOf(tenant), actorUserId: actor, permissions: permissions || ['legal:read', 'governance:dlp:export'], body: body(contract, over), idempotencyKey: key || env.nextKey('share'), transaction,
  }));
}

const linkRow = async (id) => (await env.adminQuery('SELECT * FROM governance.share_links WHERE id = $1', [id])).rows[0] || null;

/** Remove links, pedidos, contadores e MFA de teste (auditoria e contratos só de acréscimo ficam). */
async function cleanShares() {
  await env.adminQuery('DELETE FROM governance.share_links');
  await env.adminQuery('DELETE FROM governance.public_access_counters');
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'governanca.api.rate_limit.%' OR key LIKE 'governanca.dlp.link.%'");
  await env.cleanExports();
}

module.exports = { ...env, tenantOf, makeContract, share, body, linkRow, cleanShares };
