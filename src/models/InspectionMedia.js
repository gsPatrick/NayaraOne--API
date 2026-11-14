'use strict';

const { DataTypes } = require('sequelize');

/**
 * InspectionMedia — tabela "legal"."inspection_media" (Caderno M5 §4 e §11 "Fotos/vídeos têm hash, timestamp e
 * vínculo ao item"): cada foto/vídeo de um item de vistoria, com o SHA-256 do arquivo e a data/hora do registro.
 * Linha só de inclusão (o runtime não tem UPDATE/DELETE): mídia de vistoria assinada não muda.
 */
module.exports = (sequelize) => sequelize.define(
  'InspectionMedia',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    inspectionId: { type: DataTypes.UUID, allowNull: false, field: 'inspection_id' },
    itemId: { type: DataTypes.UUID, allowNull: false, field: 'item_id' },
    fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
    sha256: { type: DataTypes.STRING(64), allowNull: false, field: 'sha256' },
    capturedAt: { type: DataTypes.DATE, allowNull: false, field: 'captured_at' },
    mediaType: { type: DataTypes.STRING(16), allowNull: false, field: 'media_type' },
    fileLinkId: { type: DataTypes.UUID, allowNull: true, field: 'file_link_id' },
    createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
  },
  { schema: 'legal', tableName: 'inspection_media', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
