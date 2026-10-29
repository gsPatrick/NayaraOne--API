'use strict';

// M9-D037 — leitura de obras para a NAY Obras, SEMPRE pelos serviços de aplicação do Marco 6 (projectHealth, dailyReports,
// nonconformities, maintenanceCases, projects) sob o RLS da transação do chamador. Nada é gravado aqui.
const { getProjectHealth } = require('../../../construction/projectHealth.service');
const { getProject, listProjects } = require('../../../construction/projects.service');
const { listDailyReports } = require('../../../construction/dailyReports.service');
const { listNonconformities } = require('../../../construction/nonconformities.service');
const { listMaintenanceCases } = require('../../../construction/maintenanceCases.service');
const { toCents, centsText, pctText } = require('./money');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const day = (d) => (d ? String(typeof d === 'string' ? d : new Date(d).toISOString()).slice(0, 10) : null);
const clip = (text, n = 300) => (text ? String(text).trim().slice(0, n) : null);

/** Orçado x realizado de uma obra: orçado = orçamento base + mudanças aprovadas; realizado = custo pago + estoque consumido (Marco 6). */
async function budgetVsActual(projectId, transaction) {
  const [project, health] = await Promise.all([getProject(projectId, transaction), getProjectHealth(projectId, transaction)]);
  const budgeted = toCents(health.baselineBudget) + toCents(health.approvedChanges);
  const actual = toCents(health.actualFinancialCost) + toCents(health.consumedInventoryCost);
  const deviation = actual - budgeted;
  return {
    projectId, code: project.code || null, name: project.name || null, budgeted: centsText(budgeted), actual: centsText(actual), deviation: centsText(deviation),
    deviationPct: pctText(deviation, budgeted), overBudget: deviation > 0n, projectedTotalCost: Number(health.projectedTotalCost).toFixed(2), asOf: health.updatedAt,
    sources: [
      { entity: 'construction.projects', id: projectId }, { entity: 'construction.budget_lines', id: projectId }, { entity: 'finance.financial_entries', id: projectId },
    ],
  };
}

/** Diário de obra (RDO) da janela: o que foi feito, ocorrências e bloqueios, cada um com a referência ao diário. */
async function dailyReportsOf(projectId, transaction, { windowDays, max }, now = new Date()) {
  const cutoff = day(new Date(now.getTime() - windowDays * 86400000));
  const { data } = await listDailyReports(projectId, transaction, { page: 1, pageSize: 200 });
  const inWindow = data.filter((r) => day(r.reportDate) >= cutoff);
  const reports = inWindow.slice(0, max).map((r) => ({
    id: r.id, reportDate: day(r.reportDate), servicesPerformed: clip(r.servicesPerformed), occurrences: clip(r.occurrences), blockages: clip(r.blockages),
    workforceCount: r.workforceCount ?? null, weather: r.weather || null,
  }));
  return { projectId, windowDays, from: cutoff, to: day(now), totalInWindow: inWindow.length, withBlockages: inWindow.filter((r) => r.blockages).length, reports, asOf: now.toISOString() };
}

/** Não conformidades de qualidade da obra (abertas primeiro), com severidade e fonte. */
async function nonConformitiesOf(projectId, transaction, { max }, now = new Date()) {
  const rows = await listNonconformities(projectId, transaction, {});
  const open = rows.filter((n) => n.status === 'OPEN');
  const ordered = [...open, ...rows.filter((n) => n.status !== 'OPEN')].slice(0, max);
  return {
    projectId, total: rows.length, open: open.length, closed: rows.length - open.length,
    items: ordered.map((n) => ({ id: n.id, severity: n.severity, status: n.status, description: clip(n.description), openedAt: iso(n.get ? n.get('created_at') : n.createdAt), closedAt: iso(n.closedAt), slaDueAt: iso(n.slaDueAt) })),
    asOf: now.toISOString(),
  };
}

/** Chamados de pós-obra/garantia da obra, com prazo de garantia e situação. */
async function warrantyCasesOf(projectId, transaction, { max }, now = new Date()) {
  const { data } = await listMaintenanceCases(transaction, { projectId, page: 1, pageSize: 200 });
  const open = data.filter((c) => !['CLOSED', 'RESOLVED', 'CANCELLED'].includes(c.status));
  return {
    projectId, total: data.length, open: open.length,
    items: data.slice(0, max).map((c) => ({ id: c.id, status: c.status, severity: c.severity, category: c.category || null, description: clip(c.description), warrantyDeadlineAt: iso(c.warrantyDeadlineAt), slaDueAt: iso(c.slaDueAt) })),
    asOf: now.toISOString(),
  };
}

/** Causa do atraso: a ocorrência/bloqueio do diário mais recente (referência ao diário); sem registro, a ausência é dita. */
async function delayCause(projectId, transaction) {
  const { data } = await listDailyReports(projectId, transaction, { page: 1, pageSize: 30 });
  const found = data.find((r) => (r.blockages && String(r.blockages).trim()) || (r.occurrences && String(r.occurrences).trim()));
  if (!found) return { text: 'Sem causa registrada no diário de obra', reportId: null, reportDate: null };
  return { text: clip(found.blockages && String(found.blockages).trim() ? found.blockages : found.occurrences, 200).replace(/[.\s]+$/, ''), reportId: found.id, reportDate: day(found.reportDate) };
}

/** Obras atrasadas (prazo planejado vencido e ainda em obra), da mais atrasada para a menos, com causa e orçado x realizado. */
async function delayedProjects(transaction, { max }, now = new Date()) {
  const { data } = await listProjects(transaction, { page: 1, pageSize: 200 });
  const candidates = data.filter((p) => p.endsAtPlanned && new Date(p.endsAtPlanned) < now);
  const out = [];
  for (const project of candidates) {
    const health = await getProjectHealth(project.id, transaction);
    if (!health.kpis.isOverdue) continue;
    const [cost, cause] = await Promise.all([budgetVsActual(project.id, transaction), delayCause(project.id, transaction)]);
    out.push({
      projectId: project.id, code: project.code || null, name: project.name || null, delayDays: health.kpis.scheduleDelayDays, plannedEnd: day(project.endsAtPlanned),
      cause, budgeted: cost.budgeted, actual: cost.actual, deviation: cost.deviation, deviationPct: cost.deviationPct, asOf: cost.asOf,
    });
  }
  out.sort((a, b) => b.delayDays - a.delayDays || String(a.code).localeCompare(String(b.code)));
  return { total: out.length, items: out.slice(0, max), asOf: now.toISOString() };
}

module.exports = { budgetVsActual, dailyReportsOf, nonConformitiesOf, warrantyCasesOf, delayedProjects, delayCause };
