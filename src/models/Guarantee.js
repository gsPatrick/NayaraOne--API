'use strict';

const { DataTypes } = require('sequelize');

/**
 * Guarantee — tabela "legal"."guarantees"
 * Garantia locatícia vinculada a um contrato (fiador, seguro-fiança, depósito caução,
 * título de capitalização).
 */
module.exports = (sequelize) => {
  const Guarantee = sequelize.define(
    'Guarantee',
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
      guaranteeType: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'guarantee_type',
        comment: "GUARANTOR|INSURANCE|DEPOSIT|CAPITALIZATION_TITLE",
      },
      guarantorPersonId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'guarantor_person_id',
      },
      value: {
        type: DataTypes.DECIMAL(18, 2),
        allowNull: true,
        field: 'value',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'ACTIVE',
        field: 'status',
      },
      startsAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'ends_at',
      },
      lockVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'lock_version',
      },
      // NOTA DE AMBIENTE (07/10/2026): a coluna "replaced_by_guarantee_id" (ver migration
      // 20260101000289 e guarantees.service.js#replaceGuarantee, Caderno Anexo I "9. Garantias
      // locatícias" — "contrato não perde histórico quando a garantia é substituída") AINDA NÃO
      // existe fisicamente no banco deste ambiente: a credencial de runtime disponível aqui
      // (nayara_runtime) não tem privilégio de DDL (nem USAGE/CREATE em "legal", confirmado via
      // has_schema_privilege) — só o role `nayara_migration` roda migrations, e esse role não
      // está disponível neste sandbox. A migration está pronta para rodar com `npm run migrate`
      // (credenciais de deploy reais). Até lá, o campo fica DELIBERADAMENTE FORA do model —
      // declará-lo aqui faz TODO INSERT em legal.guarantees (inclusive os já existentes em
      // produção/testes) falhar com "column does not exist", quebrando funcionalidade que já
      // funciona. Reativar esta linha (e os campos/testes de replaceGuarantee que dependem
      // dela) IMEDIATAMENTE depois de rodar a migration:
      //
      //   replacedByGuaranteeId: { type: DataTypes.UUID, allowNull: true, field: 'replaced_by_guarantee_id' },
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
      tableName: 'guarantees',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      version: 'lockVersion',
      underscored: true,
    }
  );

  return Guarantee;
};
