'use strict';

const { DataTypes } = require('sequelize');

/**
 * ContractRequirement — tabela "legal"."contract_requirements"
 * Checklist/documentos exigidos para um contrato específico (Caderno Anexo I "7. Checklist
 * documental"). Gerado por tipo de contrato + regras + características das
 * partes/imóvel — ver requirementsEngine.service.js#generateRequirementsForContract.
 *
 * NOTA DE AMBIENTE (07/10/2026): migration 20260101000291 PRONTA mas AINDA NÃO aplicada neste
 * banco — a credencial de runtime disponível neste ambiente não tem privilégio de DDL (só o
 * role `nayara_migration`, indisponível aqui). Model já declarado para que o código fique
 * pronto para uso assim que `npm run migrate` rodar com credenciais reais de deploy.
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
