'use strict';

const { sequelize, Group, Company } = require('../../models');
const { pollAllInboundEmail, readInboundParams } = require('../../features/integrations/email/inbound');
const { tenantTx } = require('../../features/integrations/dispatch/worker/tenantTx');

/**
 * emailInboundPollJob (Marco 9, M9-D235): a cada `integration.email.inbound_poll_interval_min` (5) lê as mensagens novas das connections de e-mail configuradas para leitura
 * periódica (`inboundMode: POLL`), pelo mesmo pipeline do webhook (cursor retomável, antivírus, dado pessoal). O relógio acorda de TICK_MS em TICK_MS; o parâmetro decide a hora.
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();

async function isDue(ctx, now) {
  const { pollIntervalMin } = await tenantTx(ctx, (transaction) => readInboundParams(ctx, transaction));
  const last = lastRun.get(ctx.companyId);
  return !last || now.getTime() - last >= pollIntervalMin * 60 * 1000;
}

async function runEmailInboundPollJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, connections: 0, received: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        if (!(await isDue({ groupId: group.id, companyId: company.id }, now))) continue;
        lastRun.set(company.id, now.getTime());
        const r = await pollAllInboundEmail({ group, company });
        summary.companies += 1;
        summary.connections += r.connections;
        summary.received += r.received;
        summary.errors += r.errors;
      } catch (err) {
        summary.errors += 1;
        console.error(`[EmailInboundPollJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startEmailInboundPollJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runEmailInboundPollJob().finally(() => { running = false; }).catch((err) => {
      console.error('[EmailInboundPollJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runEmailInboundPollJob, startEmailInboundPollJob, resetPollSchedule: () => lastRun.clear() };
