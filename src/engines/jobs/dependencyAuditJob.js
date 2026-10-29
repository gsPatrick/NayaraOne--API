'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { runNpmAudit, parseAuditReport, auditCompany, readDepAuditParams } = require('../../features/integrations/depaudit');

/**
 * dependencyAuditJob (Marco 9, M9-D248): uma vez por dia, a partir da hora `integration.sdk.audit_hour` (America/Sao_Paulo),
 * roda `npm audit` nas dependências de produção e, para cada empresa, grava `SDK_VULNERABILITY` em integration_errors (gravidade
 * do aviso) e avisa quem gerencia integrações quando surge aviso novo. Falha de uma empresa não derruba as demais.
 */
const TICK_MS = 15 * 60 * 1000;
const lastRunDay = new Map();

const spParts = (now) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

/** `force` ignora a hora e o "já rodou hoje" (execução sob demanda e testes); `runner` injeta o resultado do npm audit. */
async function runDependencyAuditJob({ now = new Date(), force = false, runner = runNpmAudit, exceptions, packageJson } = {}) {
  const summary = { ran: false, companies: 0, blocking: 0, alerted: 0, errors: 0 };
  const { day, hour } = spParts(now);
  const groups = await Group.findAll();
  const alvos = [];
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    companies.forEach((company) => alvos.push({ group, company }));
  }
  const prontas = [];
  for (const { group, company } of alvos) {
    const { auditHour } = await tenantTx(group, company, (transaction) => readDepAuditParams({ groupId: group.id, companyId: company.id }, transaction));
    if (force || (hour >= auditHour && lastRunDay.get(company.id) !== day)) prontas.push({ group, company });
  }
  if (!prontas.length) return summary;
  const advisories = parseAuditReport(await runner());
  summary.ran = true;
  for (const { group, company } of prontas) {
    try {
      const r = await tenantTx(group, company, (transaction) => auditCompany({ groupId: group.id, companyId: company.id }, { advisories, exceptions, packageJson, now }, transaction));
      summary.companies += 1; summary.blocking += r.blocking; summary.alerted += r.alerted;
      if (!force) lastRunDay.set(company.id, day);
    } catch (err) {
      summary.errors += 1;
      logger.error({ companyId: company.id, err: err.message }, '[DependencyAuditJob] Falha na empresa.');
    }
  }
  return summary;
}

function startDependencyAuditJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runDependencyAuditJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err: err.message }, '[DependencyAuditJob] Falha na execução agendada.');
    });
  }, tickMs);
}

module.exports = { runDependencyAuditJob, startDependencyAuditJob };
