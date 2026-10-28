'use strict';

const { DataTypes } = require('sequelize');

/**
 * IntegrationProviderHealth — "integration"."provider_health" (Marco 9, M9-D206).
 * Saúde, latência e quota por connection. `windowMinutes = 0` é a linha ATUAL (circuito e último health check);
 * 5, 60 e 1440 são as janelas agregadas. Sem segredo e sem payload.
 */
module.exports = (sequelize) => {
  const IntegrationProviderHealth = sequelize.define(
    'IntegrationProviderHealth',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      companyId: { type: DataTypes.UUID, allowNull: false, field: 'company_id' },
      connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
      providerCode: { type: DataTypes.STRING(48), allowNull: false, field: 'provider_code' },
      windowStart: { type: DataTypes.DATE, allowNull: false, field: 'window_start' },
      windowMinutes: { type: DataTypes.INTEGER, allowNull: false, field: 'window_minutes' },
      callsTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'calls_total' },
      callsSuccess: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'calls_success' },
      callsFailed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'calls_failed' },
      successRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true, field: 'success_rate' },
      latencyP50Ms: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_p50_ms' },
      latencyP95Ms: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_p95_ms' },
      latencyP99Ms: { type: DataTypes.INTEGER, allowNull: true, field: 'latency_p99_ms' },
      rateLimitCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'rate_limit_count' },
      authFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'auth_failures' },
      retriesTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'retries_total' },
      dlqCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'dlq_count' },
      backlogCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'backlog_count' },
      quotaLimit: { type: DataTypes.INTEGER, allowNull: true, field: 'quota_limit' },
      quotaRemaining: { type: DataTypes.INTEGER, allowNull: true, field: 'quota_remaining' },
      quotaResetsAt: { type: DataTypes.DATE, allowNull: true, field: 'quota_resets_at' },
      circuitState: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'CLOSED', field: 'circuit_state' },
      circuitOpenedAt: { type: DataTypes.DATE, allowNull: true, field: 'circuit_opened_at' },
      circuitCooldownS: { type: DataTypes.INTEGER, allowNull: true, field: 'circuit_cooldown_s' },
      consecutiveFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'consecutive_failures' },
      halfOpenSuccesses: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'half_open_successes' },
      checkConsecutiveFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'check_consecutive_failures' },
      healthStatus: { type: DataTypes.STRING(10), allowNull: true, field: 'health_status' },
      lastSampleAt: { type: DataTypes.DATE, allowNull: true, field: 'last_sample_at' },
      lastCheckAt: { type: DataTypes.DATE, allowNull: true, field: 'last_check_at' },
      lastCheckOk: { type: DataTypes.BOOLEAN, allowNull: true, field: 'last_check_ok' },
      lastCheckLatencyMs: { type: DataTypes.INTEGER, allowNull: true, field: 'last_check_latency_ms' },
    },
    {
      schema: 'integration',
      tableName: 'provider_health',
      timestamps: true,
      createdAt: false,
      updatedAt: 'updated_at',
      underscored: true,
    }
  );
  return IntegrationProviderHealth;
};
