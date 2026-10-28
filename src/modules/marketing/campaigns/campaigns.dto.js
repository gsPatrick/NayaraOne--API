'use strict';

const { computeAttainment, formatAttainment, costPerResult } = require('./campaigns.result');

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Audiência na consulta: só a contagem; a lista de pessoas nunca sai (Caderno §14: lista exportada não é requisito). */
function audienceDto(row) {
  const filter = { ...(row.filter_json || {}) };
  if (Array.isArray(filter.personIds)) {
    filter.personCount = filter.personIds.length;
    delete filter.personIds;
  }
  return { id: row.id, kind: row.kind, purpose: row.purpose, filter, sizeFrozen: row.size_frozen, frozenAt: iso(row.frozen_at) };
}

const stepDto = (row) => ({
  id: row.id, stepNo: row.step_no, channel: row.channel, templateId: row.template_id, contentItemId: row.content_item_id,
  offsetMinutes: row.offset_minutes, status: row.status, statusReason: row.status_reason,
});

/** Campanha completa para a resposta de POST e GET /marketing/campaigns: objetivo, público (contagem), custo e resultado. */
function campaignDto(row, audiences, steps, audienceSize) {
  const resultValue = num(row.result_value);
  const attainment = computeAttainment(resultValue, row.target_value);
  return {
    id: row.id, code: row.code, name: row.name, status: row.status, objective: row.objective, objectiveMetric: row.objective_metric,
    targetValue: num(row.target_value), budgetAmount: num(row.budget_amount), budgetJustification: row.budget_justification,
    costActual: num(row.cost_actual), channels: row.channels || [], startsAt: iso(row.starts_at), endsAt: iso(row.ends_at),
    ownerUserId: row.owner_user_id, killSwitchActive: row.kill_switch_active,
    resultValue, attainment, attainmentDisplay: formatAttainment(attainment), costPerResult: costPerResult(num(row.cost_actual), resultValue),
    audienceSize, audiences: audiences.map(audienceDto), steps: steps.map(stepDto),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

module.exports = { campaignDto, audienceDto, stepDto };
