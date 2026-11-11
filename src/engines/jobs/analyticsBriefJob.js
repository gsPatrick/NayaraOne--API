'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock');
const { inCompany } = require('../../features/analytics/companyTx');
const briefs = require('../../features/analytics/briefs');
const { isAiEnabled, isAgentEnabled } = require('../../features/ai');
const { createBriefAgentRunner, CODE: AGENT_CODE } = require('../../features/ai/agents/nay_diretoria');

/**
 * analyticsBriefJob (Marco 9, M9-D693 3.1): briefing executivo da NAY Diretoria. Todo dia a partir de `analytics.brief.hora_diario` (padrão 06:30 de
 * São Paulo) gera o diário (D-1); a partir de `analytics.brief.hora_semanal` (padrão segunda 07:00) o semanal (semana anterior, segunda a domingo).
 * O relógio acorda de minuto em minuto; briefing já gravado do período (qualquer status) não é refeito. Empresa com a IA desligada ou sem o
 * agente habilitado fica de fora (nada é gravado e o Centro de Comando mostra "Briefing indisponível"); sem nenhum indicador com registro
 * no período também não há o que gravar. Falha de uma empresa não derruba as demais. Não há rota de geração sob demanda: o livro não pede.
 */
const TICK_MS = 60 * 1000;
const TYPES = ['DAILY', 'WEEKLY'];
// DI-BI-6: "sem fontes" fica em memória só por analytics.brief.reintento_falha_min (antes, pela vida do processo: o indicador que ganhava registro depois da primeira tentativa
// do dia nunca entrava no briefing daquele período até o servidor reiniciar)
const noSourcesMemo = new Map();

async function runType(group, company, briefType, { now, force, runAgent }, summary) {
  const scope = { groupId: group.id, companyId: company.id };
  const done = await inCompany(scope, async (transaction) => {
    const params = await briefs.readBriefParams(scope, transaction);
    if (!force && !briefs.isBriefDue(briefType, now, params)) return 'NOT_DUE';
    const period = briefs.coveredPeriod(briefType, now);
    const memo = `${company.id}:${briefType}:${period.endDate}`;
    const memoAt = noSourcesMemo.get(memo);
    if (!force && memoAt !== undefined && now.getTime() - memoAt < params.retryFailedMinutes * 60000) return 'NO_SOURCES';
    if (!(await isAiEnabled(scope, transaction)) || !(await isAgentEnabled(AGENT_CODE, scope, transaction))) return 'AI_OFF';
    try {
      const out = await briefs.generateBrief({ scope, briefType, now }, { runAgent }, transaction);
      return out.skipped ? 'EXISTS' : out.status;
    } catch (err) {
      if (err && err.code === 'ANALYTICS_BRIEF_NO_SOURCES') { noSourcesMemo.set(memo, now.getTime()); return 'NO_SOURCES'; }
      throw err;
    }
  });
  const key = { NOT_DUE: 'notDue', EXISTS: 'existing', AI_OFF: 'aiOff', NO_SOURCES: 'noSources', GENERATED: 'generated', FAILED: 'failed', BLOCKED_GROUNDING: 'blocked' }[done];
  summary[key] += 1;
}

/** Uma passada por todas as empresas e tipos. `force` ignora o horário e a memória (teste e execução manual). */
async function runAnalyticsBriefJob({ now = clock.now(), force = false, runAgent = createBriefAgentRunner(), types = TYPES } = {}) {
  if (force) noSourcesMemo.clear();
  const summary = { generated: 0, failed: 0, blocked: 0, existing: 0, notDue: 0, aiOff: 0, noSources: 0, errors: 0 };
  const groups = await Group.findAll();
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      for (const briefType of types) {
        try {
          await runType(group, company, briefType, { now, force, runAgent }, summary);
        } catch (err) {
          summary.errors += 1;
          logger.error({ err, companyId: company.id, briefType }, '[AnalyticsBriefJob] falha na empresa');
        }
      }
    }
  }
  return summary;
}

function startAnalyticsBriefJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsBriefJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsBriefJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsBriefJob, startAnalyticsBriefJob };
