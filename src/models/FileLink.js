'use strict';

const { DataTypes } = require('sequelize');

/**
 * FileLink — tabela "people"."file_links"
 * Vínculo polimórfico de um arquivo a qualquer entidade do sistema (contrato, imóvel, RDO etc.).
 */
module.exports = (sequelize) => {
  const FileLink = sequelize.define(
    'FileLink',
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
      fileId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'file_id',
      },
      relatedEntityType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'related_entity_type',
      },
      relatedEntityId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'related_entity_id',
      },
      purpose: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'purpose',
        comment: "Finalidade do vínculo, ex. CONTRACT_SIGNED_PDF",
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
      deletedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'deleted_by',
      },
    },
    {
      schema: 'people',
      tableName: 'file_links',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return FileLink;
};
