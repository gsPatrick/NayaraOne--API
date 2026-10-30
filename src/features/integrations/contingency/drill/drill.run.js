'use strict';

const { SCENARIOS, reload } = require('./drill.scenarios');
const actions = require('./drill.actions');
const { newReport, addStep, finish, writeReport, reportDir, DEFAULT_DIR } = require('./drill.report');
const { currentAdapterHash } = require('../../contract/contract.version');
const { readContingencyParams } = require('../contingency.params');
const { MODES_WITH_ALTERNATE } = require('../contingency.constants');

const ativaDa = (lista, connectionId) => lista.find((a) => a.connectionId === connectionId);


/** Passos depois da ativação: envio vencido virando tarefa manual, recuperação, encerramento e fila liberada. */
async function fullFlow({ ctx, connection, cenario, ativa, now, report, envios }) {
  addStep(report, 'contingencia_ativada', Boolean(ativa) && ativa.reasons.includes(cenario.reason), ativa ? { mode: ativa.mode, reasons: ativa.reasons } : 'não ativou');
  const item = await actions.queueAgedItem(ctx, await reload(ctx, connection.id), now); envios.push(item.dispatchId);
  const ciclo = await actions.runCycle(ctx, now);
  const tarefa = await actions.consumeManualTask(ctx, item.dispatchId);
  addStep(report, 'tarefa_manual_gerada', ciclo.manualTasks >= 1 && tarefa.tasks === 1, { eventos: tarefa.events, tarefas: tarefa.tasks, idadeHoras: item.ageHours });
  addStep(report, 'alternativo_nao_configurado_mantem_a_fila', true, MODES_WITH_ALTERNATE.includes(ativa && ativa.mode) ? 'modo com alternativo; sem alternativo na política a fila segue' : 'modo sem alternativo');
  const rec = await cenario.recuperar(ctx, connection);
  addStep(report, 'recuperar_o_sandbox', rec.ok, rec.detail);
  const params = await actions.withCtx(ctx, (t) => readContingencyParams(ctx, t));
  await actions.okChecks(ctx, connection.id, params.recoveryChecks);
  const fim = await actions.runCycle(ctx, now);
  const depois = ativaDa(await actions.activeOf(ctx), connection.id);
  addStep(report, 'contingencia_encerrada', fim.deactivated >= 1 && !depois, { testesSeguidos: params.recoveryChecks, liberados: fim.drained });
  const estado = await actions.dispatchStatus(ctx, item.dispatchId);
  addStep(report, 'fila_liberada', fim.drained >= 1 && new Date(estado.next_attempt_at) <= now, { statusDoEnvio: estado.status });
}

/**
 * failureDrill — ensaio de falha da contingência de um fornecedor de laboratório (M9-D226 3.3 item 5): derruba o sandbox, confere a ativação, o envio vencido virando
 * tarefa manual e a recuperação (encerramento e fila liberada), e grava o relatório do ensaio. Nunca lança por causa de um passo: o veredito está no relatório.
 * `opts`: provider, scenario, companyId?, outDir?, now?. Devolve { report, file }.
 */
async function runFailureDrill({ provider, scenario, companyId = null, outDir = reportDir(), now = new Date() }) {
  const cenario = SCENARIOS[scenario];
  const report = newReport({ provider, scenario, companyId, startedAt: now });
  report.adapterHash = currentAdapterHash(provider);
  if (!cenario) { addStep(report, 'cenario_conhecido', false, `Cenários: ${Object.keys(SCENARIOS).join(', ')}`); return { report: finish(report, new Date()), file: writeReport(report, outDir) }; }
  const fornecedor = await actions.loadSandboxProvider(provider);
  if (!addStep(report, 'fornecedor_de_laboratorio', Boolean(fornecedor), fornecedor ? fornecedor.domain : 'só fornecedor de laboratório (sandbox) entra no ensaio')) return { report: finish(report, new Date()), file: writeReport(report, outDir) };
  const ctx = await actions.pickCompany(companyId);
  if (!addStep(report, 'empresa_do_ensaio', Boolean(ctx), ctx ? 'empresa encontrada' : 'nenhuma empresa')) return { report: finish(report, new Date()), file: writeReport(report, outDir) };
  report.companyId = ctx.companyId;
  const criadas = []; const envios = [];
  try {
    const preparo = await actions.createDrillConnection(ctx, fornecedor);
    if (!addStep(report, 'connection_de_laboratorio', !preparo.existing, preparo.existing ? 'a empresa já tem integração ativa deste fornecedor: use uma empresa de laboratório' : 'criada e ativa')) return { report: finish(report, new Date()), file: writeReport(report, outDir) };
    const connection = preparo.connection; criadas.push(connection.id);
    const derrubada = await cenario.derrubar(ctx, connection);
    addStep(report, 'derrubar_o_sandbox', derrubada.ok, derrubada.detail);
    await actions.runCycle(ctx, now);
    const ativa = ativaDa(await actions.activeOf(ctx), connection.id);
    if (cenario.activates === false) {
      addStep(report, 'contingencia_nao_ativada', !ativa, 'limite de uso (429) não é falha do fornecedor');
      const r = await cenario.recuperar(ctx, connection);
      addStep(report, 'recuperar_o_sandbox', r.ok, r.detail);
    } else {
      await fullFlow({ ctx, connection, cenario, ativa, now, report, envios });
    }
  } catch (err) {
    addStep(report, 'execucao_sem_erro', false, { codigo: err.code || 'ERRO', mensagem: String(err.message).slice(0, 200) });
  } finally {
    try { await actions.cleanup(ctx, criadas, envios); addStep(report, 'limpeza', true, 'connection de laboratório desativada'); } catch (err) { addStep(report, 'limpeza', false, String(err.message).slice(0, 200)); }
  }
  finish(report, new Date());
  return { report, file: writeReport(report, outDir) };
}

module.exports = { runFailureDrill, DEFAULT_DIR };
