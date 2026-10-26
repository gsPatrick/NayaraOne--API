'use strict';

const { sequelize, ExternalCaseRouting } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * claimExternalRouting — grava o roteamento (provider + id externo -> empresa/caso) SEM nunca tomar
 * o de outro dono. É um INSERT ... ON CONFLICT DO NOTHING seguido da comparação do dono: duas
 * empresas que recebem o mesmo id do provider disputam a mesma chave primária, e só uma ganha (o
 * runtime nem tem UPDATE nessa tabela). Quem perde recebe conflito, nunca sobrescreve.
 * Devolve { created } (false = já era deste mesmo caso).
 */
async function claimExternalRouting(financingCase, externalCaseId, transaction) {
  const [rows] = await sequelize.query(
    `INSERT INTO "correspondent"."external_case_routing" (external_case_id, provider_code, financing_case_id, group_id, company_id, created_at)
     VALUES (:externalCaseId, :providerCode, :financingCaseId, :groupId, :companyId, now())
     ON CONFLICT (provider_code, external_case_id) DO NOTHING
     RETURNING external_case_id`,
    {
      replacements: {
        externalCaseId,
        providerCode: financingCase.providerCode,
        financingCaseId: financingCase.id,
        groupId: financingCase.groupId,
        companyId: financingCase.companyId,
      },
      transaction,
    }
  );
  if (Array.isArray(rows) && rows.length > 0) return { created: true };
  const owner = await ExternalCaseRouting.findOne({ where: { providerCode: financingCase.providerCode, externalCaseId }, transaction });
  if (!owner || owner.companyId !== financingCase.companyId || owner.financingCaseId !== financingCase.id) {
    throw AppError.conflict('Este identificador externo já pertence a outro caso neste provider.', 'EXTERNAL_CASE_ID_CONFLICT');
  }
  return { created: false };
}

module.exports = { claimExternalRouting };
