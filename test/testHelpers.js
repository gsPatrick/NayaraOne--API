'use strict';

require('dotenv').config();

const { sequelize, Group, Company, User } = require('../src/models');

/**
 * Helpers de teste (Marco 3) — rodam contra o banco real de dev (`nayara_one_dev`) via
 * `nayara_runtime` (mesmo usuário/RLS da aplicação em runtime; ver .env). Reutiliza o
 * tenant de seed criado por `scripts/seed-dev.js` (idempotente — roda `npm run seed` antes
 * dos testes se o tenant de seed ainda não existir).
 *
 * `withTenantTransaction` replica exatamente o que src/middlewares/tenant.middleware.js faz
 * em runtime: abre uma transação e roda `SET LOCAL app.group_id/app.company_id/app.user_id`
 * antes de qualquer query, garantindo que os testes exercitam o mesmo caminho de RLS que a
 * aplicação usa em produção — não um bypass de teste.
 */

const SEED_ADMIN_EMAIL = 'admin@nayaraone.dev';

async function getSeedTenant() {
  const group = await Group.findOne({ where: { name: 'Nayara One — Grupo Dev' } });
  if (!group) {
    throw new Error('Tenant de seed não encontrado. Rode "npm run seed" antes dos testes.');
  }
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    return Company.findOne({ where: { groupId: group.id, name: 'Nayara One — Empresa Dev' }, transaction });
  });
  if (!company) {
    throw new Error('Empresa de seed não encontrada. Rode "npm run seed" antes dos testes.');
  }
  // core.users não tem RLS (é global), então pode ser lido fora de contexto de tenant. Usamos
  // o usuário admin de seed como actor — várias tabelas (ex.: property_price_history.changed_by_user_id)
  // têm FK para core.users, então um UUID arbitrário não seria aceito pelo banco.
  const adminUser = await User.findOne({ where: { email: SEED_ADMIN_EMAIL } });
  if (!adminUser) {
    throw new Error('Usuário admin de seed não encontrado. Rode "npm run seed" antes dos testes.');
  }
  return { groupId: group.id, companyId: company.id, userId: adminUser.id };
}

async function withTenantTransaction(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return fn(transaction);
  });
}

/**
 * withRollbackTenantTransaction — mesma configuração de SET LOCAL de `withTenantTransaction`,
 * mas usa uma transação NÃO gerenciada pelo Sequelize (sem commit automático ao final do
 * callback), permitindo que o próprio teste decida fazer rollback explícito no `finally` —
 * usado para que dados de teste nunca fiquem persistidos no banco de dev compartilhado.
 */
// Suíte completa roda dezenas de arquivos de teste em paralelo contra a mesma empresa semente
// — isso pode formar deadlock real do Postgres (40P01) entre duas transações concorrentes de
// arquivos DIFERENTES disputando recursos da mesma empresa em ordem invertida (ex.:
// margin_rule de um lado, outra tabela do outro). Não é bug de produto: em runtime real, cada
// requisição tem sua própria transação por request, não dezenas rodando ombro a ombro na MESMA
// empresa de teste. Como a transação já é descartável por design aqui (rollback sempre), é
// seguro reabrir uma transação nova e re-executar o teste do zero quando isso acontece.
async function withRollbackTenantTransaction(tenant, fn, retriesLeft = 5) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return await fn(transaction);
  } catch (err) {
    const isDeadlock = err?.parent?.code === '40P01' || err?.original?.code === '40P01';
    if (isDeadlock && retriesLeft > 0) {
      // Backoff com jitter antes de re-tentar: o retry imediato re-colidia com a MESMA
      // transação longa do outro arquivo (visto no CI run 39124077182 — deadlock persistente
      // em construction.dashboard mesmo com 5 retries). Espera crescente dá tempo do peer
      // terminar antes da nova tentativa.
      const attempt = 6 - retriesLeft;
      const waitMs = 300 * attempt + Math.floor(Math.random() * 400);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return withRollbackTenantTransaction(tenant, fn, retriesLeft - 1);
    }
    throw err;
  } finally {
    await transaction.rollback().catch(() => {});
  }
}

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4): createFinancialEntry agora exige costCenterId para despesa (PAYABLE) e
// resultCenterId para receita (RECEIVABLE). Helpers de conveniência para os muitos testes que
// já criavam lançamentos antes dessa exigência existir.
async function createTestCostCenter(tenant, transaction, suffix = uniqueSuffix()) {
  const { CostCenter } = require('../src/models');
  return CostCenter.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, code: `CC-TEST-${suffix}`, name: `Centro de custo de teste ${suffix}` },
    { transaction }
  );
}

async function createTestResultCenter(tenant, transaction, suffix = uniqueSuffix()) {
  const { ResultCenter } = require('../src/models');
  return ResultCenter.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, code: `RC-TEST-${suffix}`, name: `Centro de resultado de teste ${suffix}` },
    { transaction }
  );
}

/**
 * settleFinancialEntryWithApproval — FIX FIN-004 (ver comentário em
 * financialEntries.service.js#settleFinancialEntry): liquidar um PAYABLE direto agora exige
 * aprovação prévia (via payment_intent OU via ApprovalRequest aprovada). Testes que não são
 * sobre o fluxo de aprovação em si (ex.: imutabilidade pós-SETTLED, antifraude, relatório
 * semanal, idempotência de replay) usam este helper pra abrir+aprovar uma ApprovalRequest LOW
 * (1 aprovador) antes de liquidar, em vez de repetir o boilerplate em cada teste.
 */
// Cria e aprova uma ApprovalRequest pro lançamento, sem liquidar — reusável tanto pra baixa
// integral (settleFinancialEntry) quanto parcial (settleFinancialEntryPartial), já que o gate
// de aprovação de PAYABLE+bankAccountId é idêntico nas duas (achado A01, auditoria Nayara
// 15/10/2026: baixa parcial contornava a aprovação exigida da baixa integral).
async function approveFinancialEntryForSettlement(tenant, entryId, actorUserId, transaction) {
  const approvalsService = require('../src/features/finance/approvals.service');
  const { User } = require('../src/models');
  const suffix = uniqueSuffix();
  const [approver] = await User.findOrCreate({
    where: { email: `homo-qa-settle-approver-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Aprovador de liquidação ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  const request = await approvalsService.createApprovalRequest(
    { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entryId, riskLevel: 'LOW' },
    actorUserId,
    transaction
  );
  return approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction);
}

// F03 (conferência Nayara 18/10/2026): PAYABLE com conta bancária não é mais dado como pago sem
// confirmação do banco — a baixa direta virou exceção formal que exige comprovante (arquivo real)
// e motivo. Este helper representa exatamente essa baixa manual: envia um comprovante de teste e
// informa o motivo. Para lançamentos sem conta bancária o comprovante é simplesmente ignorado.
async function createManualSettlementEvidence(tenant, actorUserId, transaction) {
  const filesService = require('../src/features/files/files.service');
  const file = await filesService.uploadFile(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: 'comprovante-pagamento-teste.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from(`COMPROVANTE DE TESTE ${uniqueSuffix()}`).toString('base64'),
      category: 'generic',
    },
    actorUserId,
    transaction
  );
  return { evidenceFileId: file.id, reason: 'Baixa manual de teste — pagamento feito fora da integração bancária, comprovante anexado.' };
}

// Revisão independente (A4): o comprovante é ANEXADO ao lançamento antes da aprovação, e a
// aprovação (de outra pessoa) vem depois — quem aprova vê o comprovante. Este helper faz a
// sequência completa: envia o comprovante, anexa, aprova e devolve o objeto de baixa manual.
async function prepareManualSettlement(tenant, entryId, actorUserId, transaction) {
  const financialEntriesService = require('../src/features/finance/financialEntries.service');
  const manualSettlement = await createManualSettlementEvidence(tenant, actorUserId, transaction);
  await financialEntriesService.attachSettlementEvidence(entryId, manualSettlement, actorUserId, transaction);
  await approveFinancialEntryForSettlement(tenant, entryId, actorUserId, transaction);
  return manualSettlement;
}

async function settleFinancialEntryWithApproval(tenant, entryId, actorUserId, transaction) {
  const financialEntriesService = require('../src/features/finance/financialEntries.service');
  const { FinancialEntry } = require('../src/models');
  const entry = await FinancialEntry.findByPk(entryId, { transaction });
  if (entry && entry.nature === 'PAYABLE') {
    const manualSettlement = await prepareManualSettlement(tenant, entryId, actorUserId, transaction);
    return financialEntriesService.settleFinancialEntry(entryId, actorUserId, transaction, { manualSettlement });
  }
  return financialEntriesService.settleFinancialEntry(entryId, actorUserId, transaction);
}

// F02 (conferência Nayara 18/10/2026): fechar um período exige as conferências humanas do Caderno
// §16 (caixa de terceiros; comissões/repasses) e mês sem pendência de extrato/conciliação/
// classificação. Testes que fecham período usam um mês exclusivo bem no futuro (o banco de dev é
// compartilhado e os meses correntes têm dados de outros testes) e registram as conferências.
function uniqueClosingTestMonth() {
  const year = 2066 + Math.floor(Math.random() * 10);
  const month = 1 + Math.floor(Math.random() * 12);
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function confirmPeriodChecksForTest(tenant, referenceMonth, actorUserId, transaction) {
  const periodClosuresService = require('../src/features/finance/periodClosures.service');
  for (const checkType of ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES']) {
    await periodClosuresService.confirmPeriodCheck(
      { groupId: tenant.groupId, companyId: tenant.companyId, referenceMonth, checkType, note: `Conferência de teste (${checkType})` },
      actorUserId,
      transaction
    );
  }
}

// Dispensa todo o checklist documental (JUR-003/JUR-015) de um contrato, com motivo — para
// testes que não são sobre o checklist em si, mas agora precisam resolvê-lo antes de avançar
// o contrato além de DOCUMENTS_PENDING, já que assertRequirementsSatisfied passou a gerar e
// cobrar o checklist automaticamente na primeira chamada (ver requirements.service.js). Chame
// ANTES de transitionContractStatus(..., 'DOCUMENTS_PENDING', ...), nunca depois — o próprio
// gate roda na transição de ENTRADA também.
async function waiveAllContractRequirements(contractId, actorUserId, transaction) {
  const requirementsService = require('../src/features/legal/requirements.service');
  await requirementsService.generateRequirementsForContract(contractId, {}, actorUserId, transaction);
  const items = await requirementsService.listRequirements(contractId, transaction);
  for (const item of items) {
    if (item.status === 'PENDING') {
      await requirementsService.satisfyRequirement(item.id, { waivedReason: 'Teste de regressão — fora do escopo deste cenário' }, actorUserId, transaction);
    }
  }
}


// Revisão 18/10/2026 (D2): todo recebimento de dinheiro de terceiro (caução) exige contrato e
// titular (locatário/comprador/fiador). Cria um contrato de locação com um locatário de teste.
async function createThirdPartyLink(tenant, transaction) {
  const { Contract, Person, ContractParty } = require('../src/models');
  const suffix = uniqueSuffix();
  const contract = await Contract.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', contractNumber: `TP-LINK-${suffix}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const holder = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Locatário teste ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  await ContractParty.create({ groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }, { transaction });
  return { contractId: contract.id, thirdPartyHolderPersonId: holder.id };
}

module.exports = {
  createThirdPartyLink,
  prepareManualSettlement,
  settleFinancialEntryWithApproval,
  approveFinancialEntryForSettlement,
  createManualSettlementEvidence,
  uniqueClosingTestMonth,
  confirmPeriodChecksForTest,
  sequelize,
  getSeedTenant,
  withTenantTransaction,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
  waiveAllContractRequirements,
};
