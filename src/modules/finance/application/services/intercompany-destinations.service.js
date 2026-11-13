'use strict';

const { Op } = require('sequelize');
const { Company, BankAccount } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { withCompanyContext, actorCanReadFinanceIn } = require('./intercompany-company-context');

/**
 * listDestinationBankAccounts — contas da empresa de destino para o pedido de transferência
 * (§15 "contas correspondentes"). O RLS esconde as contas de outra empresa; aqui o contexto é
 * trocado só para a leitura, e só se o usuário tem `finance:read` também no destino.
 */
async function listDestinationBankAccounts(actor, toCompanyId, transaction) {
  const { groupId, companyId: currentCompanyId, userId } = actor;
  const destination = toCompanyId ? await Company.findByPk(toCompanyId, { transaction }) : null;
  if (!destination || destination.groupId !== groupId || destination.id === currentCompanyId) {
    throw AppError.badRequest('A empresa de destino não existe ou não pertence a este grupo.', 'FINANCE_INTERCOMPANY_DESTINATION_INVALID');
  }
  return withCompanyContext(toCompanyId, currentCompanyId, transaction, async () => {
    if (!(await actorCanReadFinanceIn(toCompanyId, userId, transaction))) {
      throw AppError.forbidden('Sem permissão finance:read na empresa de destino.', 'FINANCE_INTERCOMPANY_DESTINATION_FORBIDDEN');
    }
    const accounts = await BankAccount.findAll({
      where: { companyId: toCompanyId, status: { [Op.ne]: 'BLOCKED' } },
      attributes: ['id', 'bankCode', 'agency', 'accountNumber', 'status'],
      order: [['bankCode', 'ASC']],
      transaction,
    });
    return accounts.map((a) => a.toJSON());
  });
}

/**
 * listDestinationCompanies — M45 F8: empresas do grupo (exceto a atual) com o indicador
 * `canReadFinance`. A tela lista como destino só as que o usuário pode ler; as demais aparecem
 * explicadas ("sem acesso ao Financeiro") em vez de devolver contas vazias.
 */
async function listDestinationCompanies(actor, transaction) {
  const { groupId, companyId: currentCompanyId, userId } = actor;
  const companies = await Company.findAll({ where: { groupId }, order: [['name', 'ASC']], transaction });
  const out = [];
  for (const company of companies) {
    if (company.id === currentCompanyId) continue;
    const canReadFinance = await withCompanyContext(company.id, currentCompanyId, transaction, () =>
      actorCanReadFinanceIn(company.id, userId, transaction)
    );
    out.push({ id: company.id, name: company.name, canReadFinance });
  }
  return out;
}

module.exports = {
  listDestinationBankAccounts,
  listDestinationCompanies,
};
