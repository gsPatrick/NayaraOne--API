'use strict';

// M9-D413 — apoio dos testes da definição de automações.
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../src/models');

const uid = () => crypto.randomUUID();
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

/** Definição completa e válida (a base de todos os testes; cada teste tira ou muda um item). */
function validBody(tenant, over = {}) {
  return {
    name: `QA-M9 Lead novo ${uid().slice(0, 6)}`,
    ownerUserId: tenant.userId,
    riskLevel: 'MEDIUM',
    triggerType: 'EVENT',
    triggerConfig: { eventType: 'crm.opportunity.created' },
    conditions: ['LEAD_SEM_RETORNO'],
    actions: [{ actionType: 'CREATE_TASK', title: 'Ligar para o lead' }, { actionType: 'SEND_MESSAGE', channel: 'WHATSAPP' }],
    cooldown: { amount: 72, unit: 'HOURS' },
    frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' },
    validFrom: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const versionRow = async (t, flowId, no) => (await q(t, 'SELECT * FROM marketing.automation_versions WHERE flow_id = :flowId AND version_no = :no', { flowId, no }))[0];
const flowRow = async (t, flowId) => (await q(t, 'SELECT * FROM marketing.automation_flows WHERE id = :flowId', { flowId }))[0];
const statuses = async (t, flowId) => (await q(t, 'SELECT version_no, status FROM marketing.automation_versions WHERE flow_id = :flowId ORDER BY version_no', { flowId })).map((r) => `${r.version_no}:${r.status}`);

async function otherUser(t, tenant) {
  return (await q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId }))[0].id;
}

module.exports = { uid, q, validBody, versionRow, flowRow, statuses, otherUser };
