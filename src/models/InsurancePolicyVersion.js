'use strict';

const { DataTypes } = require('sequelize');

/**
 * InsurancePolicyVersion — tabela "procurement"."insurance_policy_versions" (M9-D238): uma versão da apólice (inicial, endosso ou renovação) com o documento e o hash.
 * IMUTÁVEL no banco (gatilho): a versão seguinte é outra linha; a anterior é preservada. Só se acrescenta.
 */
module.exports = (sequelize) => sequelize.define(
  'InsurancePolicyVersion',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    policyId: { type: DataTypes.UUID, allowNull: false, field: 'policy_id' },
    version: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(12), allowNull: false },
    fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
    sha256: { type: DataTypes.CHAR(64), allowNull: false },
    effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false, field: 'effective_from' },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'expiry_date' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'received_at' },
    source: { type: DataTypes.STRING(8), allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
  },
  { schema: 'procurement', tableName: 'insurance_policy_versions', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true }
);
