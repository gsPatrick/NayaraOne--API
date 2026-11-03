'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SupplierQualification = sequelize.define(
    'SupplierQualification',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      supplierPersonId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_person_id' },
      documentFileIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'document_file_ids' },
      validUntil: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_until' },
      highRisk: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'high_risk' },
      dueDiligenceStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'NOT_REQUIRED', field: 'due_diligence_status' },
      dueDiligenceNotes: { type: DataTypes.TEXT, allowNull: true, field: 'due_diligence_notes' },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'approved_by_user_id' },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    {
      schema: 'procurement', tableName: 'supplier_qualifications', timestamps: true,
      createdAt: 'created_at', updatedAt: 'updated_at', paranoid: true, deletedAt: 'deleted_at', underscored: true,
    }
  );
  return SupplierQualification;
};
