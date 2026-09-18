'use strict';

const { DataTypes } = require('sequelize');

/**
 * SignatureProviderRouting — tabela "legal"."signature_provider_routing".
 * SEM RLS (ver comentário na migration 20260101000172) — só ids opacos de roteamento, nunca
 * dado de negócio. Único ponto do sistema onde uma tabela é consultada sem contexto de tenant.
 */
module.exports = (sequelize) => {
  const SignatureProviderRouting = sequelize.define(
    'SignatureProviderRouting',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      externalSignatureId: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'external_signature_id',
      },
      providerEnvelopeId: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'provider_envelope_id',
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
    },
    {
      schema: 'legal',
      tableName: 'signature_provider_routing',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    }
  );

  return SignatureProviderRouting;
};
