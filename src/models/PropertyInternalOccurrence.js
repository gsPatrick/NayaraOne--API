'use strict';

const { DataTypes } = require('sequelize');

/**
 * PropertyInternalOccurrence — tabela "real_estate"."property_internal_occurrences"
 * Informações não publicáveis sobre um imóvel (citação literal do Caderno Técnico: "aceita
 * permuta, pega veículo, problema documental, não financia, negociação específica, risco,
 * observação de proprietário"). "Conteúdo nunca vai automaticamente para site/portais/IA
 * pública" — nenhum service de properties/offers deve incluir este model em sua resposta;
 * apenas propertyInternalOccurrences.service.js (rota interna dedicada) o acessa.
 */
module.exports = (sequelize) => {
  const PropertyInternalOccurrence = sequelize.define(
    'PropertyInternalOccurrence',
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
      occurrenceType: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'occurrence_type',
        comment: 'TRADE_ACCEPTED|VEHICLE_TRADE|DOCUMENT_ISSUE|NO_FINANCING|SPECIFIC_NEGOTIATION|RISK|OWNER_NOTE',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'description',
      },
      visibility: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'INTERNAL',
        field: 'visibility',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'created_by',
      },
    },
    {
      schema: 'real_estate',
      tableName: 'property_internal_occurrences',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return PropertyInternalOccurrence;
};
