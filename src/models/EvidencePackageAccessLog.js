'use strict';

const { DataTypes } = require('sequelize');

/**
 * EvidencePackageAccessLog — tabela "legal"."evidence_package_access_log"
 * Cadeia de custódia do dossiê de provas: cada visualização/exportação vira uma linha nova.
 * Append-only puro — nenhuma linha é editada ou removida.
 */
module.exports = (sequelize) => {
  const EvidencePackageAccessLog = sequelize.define(
    'EvidencePackageAccessLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      evidencePackageId: { type: DataTypes.UUID, allowNull: false, field: 'evidence_package_id' },
      accessedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'accessed_by_user_id' },
      action: { type: DataTypes.STRING(16), allowNull: false, field: 'action' },
      accessedAt: { type: DataTypes.DATE, allowNull: false, field: 'accessed_at', defaultValue: DataTypes.NOW },
    },
    {
      schema: 'legal',
      tableName: 'evidence_package_access_log',
      timestamps: false,
      underscored: true,
    }
  );

  return EvidencePackageAccessLog;
};
