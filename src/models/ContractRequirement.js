'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractRequirement — tabela "legal"."contract_requirements"
 * Checklist/documentos exigidos para um contrato específico (Caderno Anexo I "7. Checklist
 * documental"). Gerado por tipo de contrato + regras + características das
 * partes/imóvel — ver requirementsEngine.service.js#generateRequirementsForContract.
 *
 * FIX AUD-009 (auditoria externa, 09/10/2026): a migration 20260101000291 já está aplicada
 * neste banco (confirmado via `SELECT to_regclass('legal.contract_requirements')`); a nota de
 * ambiente anterior dizia o contrário e sobreviveu depois que a dependência real passou a
 * existir — mesmo padrão do fallback de bootstrap encontrado em
 * construction/projects.service.js#hasOpenCriticalNonconformity. O gate que usa esta tabela
 * (assertRequirementsSatisfied, requirements.service.js) agora é chamado de verdade em
 * contracts.service.js#transitionContractStatus — ver comentário lá.
 */
module.exports = (sequelize) => {
  const ContractRequirement = sequelize.define(
    'ContractRequirement',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      contractId: { type: DataTypes.UUID, allowNull: false, field: 'contract_id' },
      requirementCode: { type: DataTypes.STRING(64), allowNull: false, field: 'requirement_code' },
      description: { type: DataTypes.TEXT, allowNull: false, field: 'description' },
      requirementType: { type: DataTypes.STRING(32), allowNull: false, field: 'requirement_type' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING', field: 'status' },
      satisfiedByFileId: { type: DataTypes.UUID, allowNull: true, field: 'satisfied_by_file_id' },
      satisfiedAt: { type: DataTypes.DATE, allowNull: true, field: 'satisfied_at' },
      waivedReason: { type: DataTypes.TEXT, allowNull: true, field: 'waived_reason' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'legal',
      tableName: 'contract_requirements',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ContractRequirement;
};
