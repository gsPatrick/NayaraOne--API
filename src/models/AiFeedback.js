'use strict';

const { DataTypes } = require('sequelize');

/** AiFeedback — tabela "ai"."feedback" (M9-D032): joinha ou não gostei de uma pessoa sobre um run da NAY. Só vira dado de avaliação. */
module.exports = (sequelize) => sequelize.define(
  'AiFeedback',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
    companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
    runId: { type: DataTypes.UUID, allowNull: false, field: 'run_id' },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    rating: { type: DataTypes.STRING(4), allowNull: false, field: 'rating' },
    category: { type: DataTypes.STRING(40), allowNull: true, field: 'category' },
    comment: { type: DataTypes.STRING(500), allowNull: true, field: 'comment' },
  },
  { schema: 'ai', tableName: 'feedback', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true }
);
