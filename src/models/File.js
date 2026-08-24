'use strict';

const { DataTypes } = require('sequelize');

/**
 * File — tabela "people"."files"
 * Metadado de arquivo binário — o binário em si vive em storage dedicado (S3-compatível), nunca no banco relacional.
 */
module.exports = (sequelize) => {
  const File = sequelize.define(
    'File',
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
      storageKey: {
        type: DataTypes.STRING(512),
        allowNull: false,
        field: 'storage_key',
        comment: "Chave/caminho no storage externo",
      },
      fileName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'file_name',
      },
      mimeType: {
        type: DataTypes.STRING(128),
        allowNull: true,
        field: 'mime_type',
      },
      sizeBytes: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'size_bytes',
      },
      checksumSha256: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'checksum_sha256',
      },
      uploadedByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'uploaded_by_user_id',
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
      tableName: 'files',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return File;
};
