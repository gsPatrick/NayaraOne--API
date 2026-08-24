'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyDocument — tabela "real_estate"."property_documents"
 * Matrícula, IPTU etc. de um imóvel. Estrutura de colunas é INFERÊNCIA (ver migration
 * 20260101000081).
 */
module.exports = (sequelize) => {
  const PropertyDocument = sequelize.define(
    'PropertyDocument',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      groupId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'group_id',
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      propertyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'property_id',
      },
      documentType: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'document_type',
        comment: 'IPTU|CONDO_FEE|REGISTRY|REGULARIZATION_CERTIFICATE',
      },
      label: {
        type: DataTypes.STRING(150),
        allowNull: true,
        field: 'label',
      },
      valueNumber: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'value_number',
      },
      valueAmount: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'value_amount',
      },
      status: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'status',
        comment: 'REGULARIZADO|EM_ANALISE|PENDENTE',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'created_by',
      },
      updatedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'updated_by',
      },
    },
    {
      schema: 'real_estate',
      tableName: 'property_documents',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PropertyDocument;
};
