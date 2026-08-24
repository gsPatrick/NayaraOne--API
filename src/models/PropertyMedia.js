'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyMedia — tabela "real_estate"."property_media"
 * Fotos/vídeos de um imóvel. Estrutura de colunas é INFERÊNCIA (ver migration
 * 20260101000080). REG-IMO-001 (vídeo obrigatório para publicação) consulta esta tabela por
 * property_id + media_type='VIDEO'.
 */
module.exports = (sequelize) => {
  const PropertyMedia = sequelize.define(
    'PropertyMedia',
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
      mediaType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        field: 'media_type',
        comment: 'PHOTO|VIDEO',
      },
      storageKey: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'storage_key',
      },
      originalName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'original_name',
      },
      mimeType: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'mime_type',
      },
      sizeBytes: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'size_bytes',
      },
      position: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'position',
      },
      classification: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'classification',
      },
      qualityStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'quality_status',
        comment: 'PENDING|APPROVED|REJECTED',
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
      tableName: 'property_media',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PropertyMedia;
};
