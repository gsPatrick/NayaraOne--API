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
      // true = o binário em disco foi gravado cifrado (marcador NAYENC1). Arquivos anteriores à
      // migration 20260101000395 ficam false (legado, podem estar em texto puro). Com true, a
      // leitura recusa conteúdo sem o marcador — sem isso, remover o marcador fazia a API servir
      // bytes adulterados como se fossem "legado" (I4, revisão de 18/10/2026).
      encryptedAtRest: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'encrypted_at_rest',
      },
      // STOPGAP (ver migration 20260101000173) — binário guardado direto no Postgres enquanto
      // não existe storage de objetos real. Nunca incluído em queries por padrão
      // (excludeContentByDefault em files.service.js) para não pesar toda leitura de File.
      content: {
        type: DataTypes.BLOB('long'),
        allowNull: true,
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
      // `content` (BLOB) NUNCA vem por padrão — evita pesar toda leitura de File que só quer
      // metadado (a imensa maioria dos casos). Quem precisa do binário usa File.scope('withContent').
      defaultScope: { attributes: { exclude: ['content'] } },
      scopes: { withContent: { attributes: {} } },
    }
  );

  return File;
};
