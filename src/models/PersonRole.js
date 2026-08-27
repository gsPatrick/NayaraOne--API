'use strict';

const { DataTypes } = require('sequelize');

/**
 * PersonRole — tabela "people"."person_roles" (TAB-0101)
 * Papel de negócio que uma pessoa assume (CLIENTE, PROPRIETARIO, LOCATARIO, FORNECEDOR etc.).
 * PK confirmada: PRIMARY KEY(person_id, role_code, company_id). A coluna "id" (uuid) é mantida
 * como identificador estável para a API (rotas /people/:id/roles/:roleId), com UNIQUE próprio.
 */
module.exports = (sequelize) => {
  const PersonRole = sequelize.define(
    'PersonRole',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
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
        primaryKey: true,
      },
      personId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'person_id',
        primaryKey: true,
      },
      roleCode: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: 'role_code',
        primaryKey: true,
        comment: 'CLIENTE|PROPRIETARIO|LOCATARIO|FORNECEDOR|CORRETOR|COMPRADOR|FIADOR|COLABORADOR|LOCADOR (lista aberta)',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ends_at',
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
      tableName: 'person_roles',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      underscored: true,
    }
  );

  return PersonRole;
};
