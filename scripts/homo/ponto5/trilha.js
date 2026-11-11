'use strict';
/**
 * Ponto 5, parte 5: a trilha dos TRÊS eventos de auditoria do aceite (commit 14217771), conferida pela API (GET /audit-log) com
 * quem, o quê e quando:
 * 1. people.person.create — o cadastro de cada contato do ponto 5 e do gatilho, pelo administrador;
 * 2. people.consent.record — o registro do opt-in e do opt-out (com o motivo "opt-out"), pelo administrador;
 * 3. marketing.automation_run.completed — a execução concluída da automação de demonstração, pela rotina (sem usuário), ligada
 *    ao cadastro do contato gatilho pelo mesmo X-Correlation-Id e com a ação CREATE_TASK OK.
 * E a outra empresa não lê nenhuma dessas linhas.
 */
const { listar, linha } = require('../lib/auditoria');

const CENARIO = '(5) trilha de auditoria';

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  const nomes = { [ctx.admin.userId]: `${ctx.admin.email} (administrador)` };
  const dizer = (e) => linha(e, nomes);
  const ids = [];

  // 1) cadastro
  const pessoas = [...Object.values(ctx.p5.contatos).map((c) => [c.id, c.nome]), [ctx.ids.pessoaGatilho, 'contato gatilho da automação']];
  for (const [id, nome] of pessoas) {
    const e = (await listar(ctx.admin, { entityId: id, action: 'people.person.create' })).itens[0];
    ctx.rel.conferir(CENARIO, `people.person.create: cadastro de "${nome}" com autor e data`, Boolean(e) && e.userId === ctx.admin.userId && Boolean(e.occurredAt), e ? dizer(e) : 'NÃO ENCONTRADO');
    if (e) ids.push(e.id);
  }

  // 2) consentimento: opt-in e opt-out do contato que saiu
  const optOut = ctx.p5.contatos.optOut.id;
  const cons = (await listar(ctx.admin, { action: 'people.consent.record' })).itens.filter((e) => e.afterJson && e.afterJson.personId === optOut);
  for (const status of ['OPT_IN', 'OPT_OUT']) {
    const e = cons.find((x) => x.afterJson.status === status && x.afterJson.channel === 'EMAIL');
    const motivoOk = status === 'OPT_OUT' ? /opt-out/i.test(e ? e.reason : '') : /opt-in/i.test(e ? e.reason : '');
    ctx.rel.conferir(CENARIO, `people.consent.record: ${status} do contato com opt-out, com autor, data e motivo`, Boolean(e) && e.userId === ctx.admin.userId && motivoOk,
      e ? `${dizer(e)} | "${e.reason}"` : 'NÃO ENCONTRADO');
    if (e) ids.push(e.id);
  }

  // 3) execução concluída da automação, ligada ao gatilho pela correlação
  const correl = ctx.p5.correlacaoGatilho;
  const execs = (await listar(ctx.admin, { action: 'marketing.automation_run.completed' })).itens;
  const run = execs.find((e) => e.afterJson && correl && e.afterJson.correlationId === correl);
  const tarefaOk = run && Array.isArray(run.afterJson.actions) && run.afterJson.actions.some((a) => a.type === 'CREATE_TASK' && a.status === 'OK');
  ctx.rel.conferir(CENARIO, 'marketing.automation_run.completed: a execução da automação (contato gatilho) concluída, pela rotina, com CREATE_TASK OK',
    Boolean(run) && run.userId === null && run.afterJson.status === 'COMPLETED' && tarefaOk,
    run ? `${dizer(run)} | correlação ${correl} = a do cadastro do gatilho | ações ${JSON.stringify(run.afterJson.actions)}` : `NÃO ENCONTRADO (correlação do gatilho: ${correl || 'desconhecida'})`);
  if (run) { ids.push(run.id); ctx.ids.execucaoAutomacao = run.entityId; }

  // a outra empresa não lê nenhuma dessas linhas da trilha
  if (ctx.outra) {
    let vistas = 0;
    for (const id of ids) {
      const r = await ctx.outra.chamar('GET', `/audit-log/${id}`);
      if (r.status === 200) vistas += 1;
    }
    ctx.rel.conferir(CENARIO, 'a outra empresa não lê nenhuma dessas linhas da trilha (por id)', vistas === 0, `${ids.length} linhas pedidas por GET /audit-log/:id, ${vistas} devolvidas`);
  }
}

module.exports = { executar, CENARIO };
