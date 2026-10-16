'use strict';

const { DataTypes } = require('sequelize');

/**
 * KeyDelivery — tabela "legal"."key_deliveries"
 * Controle de entrega/liberação de chaves de um imóvel locado.
 * SEM lock_version — ver comentário de decisão de engenharia na migration
 * 20260101000090-create-legal-key_deliveries.js.
 */
module.exports = (sequelize) => {
  const KeyDelivery = sequelize.define(
    'KeyDelivery',
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
      contractId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'contract_id',
      },
      inspectionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'inspection_id',
      },
      deliveredToPersonId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'delivered_to_person_id',
      },
      deliveredByUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'delivered_by_user_id',
      },
      deliveredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'delivered_at',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
        comment: "PENDING|RELEASED",
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'notes',
      },
      // GAP REAL (verificação cética Marco 5, ciclo 4 — mesmo padrão já corrigido em
      // src/models/Guarantee.js/replacedByGuaranteeId no início desta sessão): a migration
      // 20260101000290 JÁ está aplicada neste banco (colunas físicas existem), mas os 7
      // campos abaixo nunca foram declarados no model — keyDeliveries.service.js os atribuía
      // na instância em memória (refletidos só na resposta HTTP/auditoria), e `save()` nunca
      // persistia nada disso de fato, porque Sequelize só grava atributos declarados.
      // Resultado prático: toda entrega de chave liberada perdia silenciosamente a
      // quantidade/identificação das chaves, as fotos obrigatórias e quem assinou o termo.
      keysCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'keys_count',
      },
      keysIdentification: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'keys_identification',
      },
      photosRequired: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'photos_required',
      },
      photosFileIds: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'photos_file_ids',
      },
      termType: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'term_type',
        comment: 'KEY_DELIVERY|USED_PROPERTY_DELIVERY',
      },
      termSignedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'term_signed_at',
      },
      termSignedByPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'term_signed_by_person_id',
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
      schema: 'legal',
      tableName: 'key_deliveries',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return KeyDelivery;
};
