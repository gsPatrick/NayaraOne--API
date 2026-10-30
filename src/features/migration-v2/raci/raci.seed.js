'use strict';

const { sequelize } = require('../../../models');

/**
 * As dez atividades do corte (M9-D902 §3.1), com código fixo. Regra inferida do contexto: o livro pede o RACI "por atividade" sem listá-las; esta semente reúne as atividades
 * dos demais itens da migração v2. Título, ordem e fase são editáveis no banco; o código não muda (os outros documentos o referenciam).
 */
const ACTIVITY_SEEDS = Object.freeze([
  { code: 'FREEZE_LEGACY_WRITES', title: 'Congelar escritas no legado', phase: 'CUTOVER' },
  { code: 'LAST_DELTA_LOAD', title: 'Última carga delta', phase: 'CUTOVER' },
  { code: 'FINAL_RECONCILIATION', title: 'Reconciliação final', phase: 'CUTOVER' },
  { code: 'PARALLEL_COMPARE_CLOSE', title: 'Encerramento da janela de comparação paralela', phase: 'PRE' },
  { code: 'SECTOR_ACTIVATION', title: 'Ativação por setor (canary)', phase: 'PRE' },
  { code: 'CLOCK_TZ_CHECK', title: 'Verificação de relógio e fuso', phase: 'PRE' },
  { code: 'GO_NO_GO', title: 'GO/NO-GO', phase: 'CUTOVER' },
  { code: 'ROLLBACK_EXECUTION', title: 'Execução do rollback', phase: 'CUTOVER' },
  { code: 'USER_COMMUNICATION', title: 'Comunicação a usuários', phase: 'POST' },
  { code: 'LEGACY_DECOMMISSION', title: 'Encerramento do legado', phase: 'POST' },
]);

/** Garante as atividades da empresa (idempotente; nunca sobrescreve título nem fase já ajustados). */
async function ensureActivities(tenant, transaction) {
  const values = ACTIVITY_SEEDS.map((_, i) => `(:groupId, :companyId, :code${i}, :title${i}, ${i + 1}, :phase${i})`).join(', ');
  const replacements = { groupId: tenant.groupId, companyId: tenant.companyId };
  ACTIVITY_SEEDS.forEach((seed, i) => { replacements[`code${i}`] = seed.code; replacements[`title${i}`] = seed.title; replacements[`phase${i}`] = seed.phase; });
  await sequelize.query(
    `INSERT INTO governance.cutover_activities (group_id, company_id, code, title, sort_order, phase) VALUES ${values} ON CONFLICT (company_id, code) DO NOTHING`,
    { transaction, replacements }
  );
}

module.exports = { ACTIVITY_SEEDS, ensureActivities };
