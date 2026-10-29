'use strict';

// Fábricas jurídicas dos testes da NAY Jurídica (M9-D038): contrato com duas versões, requisitos, processo e prazo, pelos serviços de
// aplicação do Marco 5, na transação do teste (rollback). `semVersao` cria o contrato sem nenhuma versão (prazo sem fonte exata).
const contractsService = require('../../../src/features/legal/contracts.service');
const contractVersionsService = require('../../../src/features/legal/contractVersions.service');
const requirementsService = require('../../../src/features/legal/requirements.service');
const legalCasesService = require('../../../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../../../src/features/legal/legalDeadlines.service');
const { ContractRequirement } = require('../../../src/models');
const { uniqueSuffix } = require('../../testHelpers');

const DAY = 86400000;
const V1 = 'Cláusula 1 — objeto\nCláusula 2 — aluguel mensal\nCláusula 3 — foro';
const V2 = 'Cláusula 1 — objeto\nCláusula 2 — aluguel mensal reajustado\nCláusula 3 — foro\nCláusula 4 — reajuste anual pelo IPCA';

async function cenarioJuridico(tenant, tx, { semVersao = false } = {}) {
  const base = { groupId: tenant.groupId, companyId: tenant.companyId };
  const contract = await contractsService.createContract({ ...base, contractType: 'LEASE_RESIDENTIAL', totalValue: 2500 }, tenant.userId, tx);
  const requirements = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, tx);
  await ContractRequirement.update({ status: 'SATISFIED', satisfiedAt: new Date() }, { where: { id: requirements[0].id }, transaction: tx });
  let v1 = null;
  let v2 = null;
  if (!semVersao) {
    v1 = await contractVersionsService.createContractVersion(contract.id, { content: V1, requireDocument: false }, tenant.userId, tx);
    v2 = await contractVersionsService.createContractVersion(contract.id, { content: V2, requireDocument: false }, tenant.userId, tx);
  }
  const legalCase = await legalCasesService.createLegalCase({ ...base, contractId: contract.id, caseType: 'LITIGATION', caseNumber: `QAM9-${uniqueSuffix()}`, summary: 'Despejo por falta de pagamento' }, tenant.userId, tx);
  const dueAt = new Date(Date.now() + 10 * DAY);
  const deadline = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'Contestação', dueAt, sourceDocument: 'Mandado de citação' }, tenant.userId, tx);
  const fresh = await contractsService.getContract(contract.id, tx);
  return { contract: fresh, requirements, v1, v2, legalCase, deadline, dueDay: dueAt.toISOString().slice(0, 10) };
}

/** Impressão digital do que a NAY Jurídica não pode alterar: versões, status dos contratos, requisitos e prazos. */
async function impressao(tx, q) {
  const [row] = await q(`SELECT
    (SELECT COUNT(*) FROM legal.contract_versions)::int AS versoes,
    (SELECT md5(COALESCE(string_agg(id::text || content_hash, ',' ORDER BY id), '')) FROM legal.contract_versions) AS conteudo,
    (SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) FROM legal.contracts) AS contratos,
    (SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) FROM legal.contract_requirements) AS requisitos,
    (SELECT md5(COALESCE(string_agg(id::text || status || due_at::text, ',' ORDER BY id), '')) FROM legal.legal_deadlines) AS prazos,
    (SELECT COUNT(*) FROM legal.contracts)::int AS total_contratos`, {}, tx);
  return row;
}

module.exports = { cenarioJuridico, impressao, V1, V2, DAY };
