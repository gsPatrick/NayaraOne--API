'use strict';

const { DataTypes } = require('sequelize');

/**
 * ProjectCodeSequence — tabela "construction"."project_code_sequences"
 * Contador atômico por (company_id, year) para gerar `Project.code` sem corrida de
 * concorrência — mesmo padrão de `legal.contract_number_sequences`.
 */
module.exports = (sequelize) => {
  const ProjectCodeSequence = sequelize.define(
    'ProjectCodeSequence',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      companyId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'company_id',
      },
      year: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'year',
      },
      lastSeq: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'last_seq',
      },
    },
    {
      tableName: 'project_code_sequences',
      schema: 'construction',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return ProjectCodeSequence;
};
