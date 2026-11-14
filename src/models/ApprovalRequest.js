'use strict';

const { DataTypes } = require('sequelize');

/**
 * ApprovalRequest — tabela "finance"."approval_requests"
 * Solicitação de aprovação (maker-checker) para operações financeiras/críticas.
 */
module.exports = (sequelize) => {
  const ApprovalRequest = sequelize.define(
    'ApprovalRequest',
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
      relatedEntityType: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'related_entity_type',
      },
      relatedEntityId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'related_entity_id',
      },
      requestedByUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'requested_by_user_id',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'PENDING',
        field: 'status',
      },
      riskLevel: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
        field: 'risk_level',
      },
      // Achado A10 (auditoria Nayara, 15/10/2026): snapshot do lock_version da entidade
      // relacionada, capturado NO SERVIDOR no momento da criação da solicitação (nunca confiado
      // do cliente). decideApprovalStep valida isso sempre que presente — omitir o campo na
      // decisão não dispensa mais a checagem de staleness.
      lockVersionAtRequest: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'lock_version_at_request',
      },
      // M4PG (Caderno §5 "approval_requests: Snapshot de aprovação"; Guia §4 createFromRule): retrato aprovável e o hash dele, o nº de
      // aprovadores e a versão da regra que os definiu (REG-FIN-002) ou a origem PARAMETERS, o motivo (estorno/reabertura) e o valor.
      snapshotJson: { type: DataTypes.JSONB, allowNull: true, field: 'snapshot_json' },
      snapshotHash: { type: DataTypes.STRING(64), allowNull: true, field: 'snapshot_hash' },
      requiredApprovals: { type: DataTypes.INTEGER, allowNull: true, field: 'required_approvals' },
      ruleVersionId: { type: DataTypes.UUID, allowNull: true, field: 'rule_version_id' },
      riskSource: { type: DataTypes.STRING(16), allowNull: true, field: 'risk_source' },
      reason: { type: DataTypes.TEXT, allowNull: true, field: 'reason' },
      amount: { type: DataTypes.DECIMAL(18, 2), allowNull: true, field: 'amount' },
      payloadJson: { type: DataTypes.JSONB, allowNull: true, field: 'payload_json' },
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
    },
    {
      schema: 'finance',
      tableName: 'approval_requests',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return ApprovalRequest;
};
