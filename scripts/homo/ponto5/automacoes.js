'use strict';
/**
 * Ponto 5, parte 2: automações.
 * (a) Automação de demonstração ACEITE-M9-P5-AUTOMACAO (contato novo -> tarefa): criada, publicada, executada uma vez pelo
 *     contato gatilho (o POST /people leva um X-Correlation-Id conhecido, que a execução carrega até a linha de conclusão
 *     marketing.automation_run.completed) e PAUSADA logo depois, para não agir sobre contatos reais.
 * (b) Os cinco tipos de ação que exigem campo (definition.validation.js, ACTION_REQUIRED_FIELDS): cada um, sem o campo, é
 *     recusado com 422 MKT_AUTOMATION_INCOMPLETE (e o campo listado em details.items) ao CRIAR uma automação nova e ao criar a
 *     versão nova de uma automação existente para PUBLICAR; a versão recusada não existe, então publicar o número dela dá 404
 *     e nenhuma versão nova aparece na trilha. Nada é criado pelas tentativas.
 */
const crypto = require('crypto');
const { listar } = require('../lib/auditoria');
const { dormir } = require('../lib/cliente');

const CENARIO = '(3) automações';
const COD = 'ACEITE-M9-P5-AUTOMACAO';
const NOME_GATILHO = 'ACEITE-M9 P5 Contato Gatilho da Automacao';
const TITULO_TAREFA = 'ACEITE-M9 P5 Acompanhar contato novo';
const MOTIVO_PUBLICAR = `ACEITE-M9 publicação da automação ${COD}`;
const MOTIVO_PAUSAR = `ACEITE-M9 pausa da automação ${COD} após a demonstração (evita agir sobre contatos reais)`;
const INCOMPLETAS = Object.freeze([
  { tipo: 'NOTIFY_USER', campo: 'title', acao: { actionType: 'NOTIFY_USER' } },
  { tipo: 'CREATE_TASK', campo: 'title', acao: { actionType: 'CREATE_TASK', title: '   ' } },
  { tipo: 'CREATE_CONTENT_DRAFT', campo: 'type', acao: { actionType: 'CREATE_CONTENT_DRAFT' } },
  { tipo: 'OPEN_CASE', campo: 'description', acao: { actionType: 'OPEN_CASE' } },
  { tipo: 'UPDATE_CRM_STAGE_TAG', campo: 'stage', acao: { actionType: 'UPDATE_CRM_STAGE_TAG' } },
]);
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;

const definicao = (ownerUserId, acoes, extra = {}) => ({
  name: 'ACEITE-M9 P5 Automação: tarefa para contato novo', triggerType: 'EVENT', triggerConfig: { eventType: 'person.created' },
  conditions: [], conditionsEmptyReason: 'ACEITE-M9 vale para qualquer contato novo (apenas na demonstração)', actions: acoes,
  cooldown: { amount: 1, unit: 'DAYS' }, frequencyCap: { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' }, riskLevel: 'LOW', ownerUserId, ...extra,
});

async function acharFluxo(ctx) {
  const { itens } = await listar(ctx.admin, { action: 'marketing.automation.publish' });
  const e = itens.find((x) => x.reason === MOTIVO_PUBLICAR);
  return e ? e.entityId : null;
}

async function versoes(ctx, fluxoId) {
  const { itens } = await listar(ctx.admin, { entityId: fluxoId, action: 'marketing.automation.create_version' });
  return itens.map((e) => (e.afterJson ? e.afterJson.versionNo : null)).filter(Number.isInteger).sort((a, b) => a - b);
}

async function demonstracao(ctx) {
  let fluxoId = await acharFluxo(ctx);
  let situacao = 'já existia';
  if (!fluxoId) {
    const c = await ctx.admin.chamar('POST', '/marketing/automations', { code: COD, ...definicao(ctx.admin.userId, [{ actionType: 'CREATE_TASK', title: TITULO_TAREFA }]) });
    ctx.rel.conferir(CENARIO, 'automação completa é criada (201, fluxo PAUSADO, versão 1 em rascunho)', c.status === 201 && c.dados.flow.status === 'PAUSED', `POST /marketing/automations -> ${resumo(c)}`);
    if (c.status !== 201) return null;
    fluxoId = c.dados.flow.id;
    const p = await ctx.admin.chamar('POST', `/marketing/automations/${fluxoId}/publish`, { versionNo: 1, reason: MOTIVO_PUBLICAR });
    ctx.rel.conferir(CENARIO, 'a automação é publicada (fluxo ATIVO)', p.status === 200 && p.dados.flow.status === 'ACTIVE', `POST /marketing/automations/:id/publish -> ${resumo(p)}`);
    situacao = 'criada e publicada agora';
  }
  ctx.ids.fluxoId = fluxoId;

  const existente = (await ctx.admin.chamar('GET', '/people')).dados || [];
  let gatilho = existente.find((x) => x.legalName === NOME_GATILHO) || null;
  let correlacao = null;
  if (!gatilho) {
    correlacao = crypto.randomUUID();
    const g = await ctx.admin.chamar('POST', '/people', { personType: 'PF', legalName: NOME_GATILHO }, { correlacao });
    if (g.status !== 201) throw new Error(`Não consegui criar o contato gatilho: ${resumo(g)}`);
    gatilho = g.dados;
  } else {
    const cri = (await listar(ctx.admin, { entityId: gatilho.id, action: 'people.person.create' })).itens[0];
    correlacao = cri ? cri.correlationId : null;
  }
  ctx.ids.pessoaGatilho = gatilho.id;
  ctx.p5.correlacaoGatilho = correlacao;

  const acharTarefa = async () => (await listar(ctx.admin, { action: 'marketing.automation.task_create' })).itens
    .find((e) => e.afterJson && e.afterJson.relatedEntityId === gatilho.id && e.afterJson.title === TITULO_TAREFA) || null;
  let tarefa = await acharTarefa();
  for (let i = 0; i < 24 && !tarefa; i += 1) { await dormir(5000); tarefa = await acharTarefa(); }
  ctx.rel.conferir(CENARIO, 'a execução ocorreu: o contato gatilho gerou a tarefa da automação', Boolean(tarefa), tarefa ? `tarefa ${tarefa.entityId} "${tarefa.afterJson.title}" em ${tarefa.occurredAt}` : 'a tarefa não apareceu em 2 minutos');
  if (tarefa) ctx.ids.tarefaId = tarefa.entityId;

  const pausas = await listar(ctx.admin, { action: 'marketing.automation.pause', entityId: fluxoId });
  if (!pausas.itens.some((e) => e.reason === MOTIVO_PAUSAR)) {
    const z = await ctx.admin.chamar('POST', `/marketing/automations/${fluxoId}/pause`, { reason: MOTIVO_PAUSAR });
    ctx.rel.conferir(CENARIO, 'a automação é pausada ao fim da demonstração', z.status === 200 && z.dados.flow.status === 'PAUSED', `POST /marketing/automations/:id/pause -> ${resumo(z)}`);
    situacao += '; pausada agora';
  } else situacao += '; já pausada';
  ctx.rel.item('Automação', COD, `${situacao} (contato novo -> tarefa)`, fluxoId, 'Atividades (/painel/atividades), filtro "Automação"');
  ctx.rel.item('Pessoa fictícia', NOME_GATILHO, 'gatilho da automação', gatilho.id, `/painel/pessoas/${gatilho.id}`);
  if (tarefa) ctx.rel.item('Tarefa gerada pela automação', TITULO_TAREFA, 'criada pela execução', tarefa.entityId, 'Atividades (/painel/atividades)');
  return fluxoId;
}

function recusaCerta(r, campo) {
  const itens = r.erro && r.erro.details && Array.isArray(r.erro.details.items) ? r.erro.details.items : [];
  return r.status === 422 && r.erro.code === 'MKT_AUTOMATION_INCOMPLETE' && itens.some((i) => i.field === `actions[0].${campo}`);
}

async function incompletas(ctx, fluxoId) {
  const antes = fluxoId ? await versoes(ctx, fluxoId) : [];
  for (const { tipo, campo, acao } of INCOMPLETAS) {
    const codigo = `ACEITE-M9-P5-INCOMPLETA-${tipo}`;
    const c = await ctx.admin.chamar('POST', '/marketing/automations', { code: codigo, ...definicao(ctx.admin.userId, [acao], { name: `ACEITE-M9 P5 ${tipo} sem ${campo}` }) });
    ctx.rel.conferir(CENARIO, `${tipo} sem "${campo}": CRIAR é recusado com 422 MKT_AUTOMATION_INCOMPLETE`, recusaCerta(c, campo),
      `POST /marketing/automations (${codigo}) -> ${resumo(c)}${c.erro ? ` "${c.erro.message}"` : ''}`);
    if (!fluxoId) { ctx.rel.conferir(CENARIO, `${tipo} sem "${campo}": PUBLICAR é recusado`, false, 'sem a automação de demonstração para a versão nova'); continue; }
    const v = await ctx.admin.chamar('POST', '/marketing/automations', { flowId: fluxoId, actions: [acao] });
    const proxima = (antes[antes.length - 1] || 0) + 1;
    const p = await ctx.admin.chamar('POST', `/marketing/automations/${fluxoId}/publish`, { versionNo: proxima, reason: `ACEITE-M9 tentativa de publicar ${tipo} incompleta` });
    ctx.rel.conferir(CENARIO, `${tipo} sem "${campo}": PUBLICAR é recusado (a versão nova é recusada com 422 e a publicação não acha versão)`,
      recusaCerta(v, campo) && p.status === 404 && p.erro && p.erro.code === 'MKT_AUTOMATION_NOT_FOUND',
      `POST /marketing/automations {flowId} -> ${resumo(v)}${v.erro ? ` "${v.erro.message}"` : ''}; POST /marketing/automations/:id/publish {versionNo: ${proxima}} -> ${resumo(p)}`);
  }
  if (fluxoId) {
    const depois = await versoes(ctx, fluxoId);
    ctx.rel.conferir(CENARIO, 'nenhuma versão incompleta foi criada (trilha de versões da automação igual antes e depois)', JSON.stringify(antes) === JSON.stringify(depois), `versões antes [${antes.join(', ')}], depois [${depois.join(', ')}]`);
  }
}

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  const fluxoId = await demonstracao(ctx);
  await incompletas(ctx, fluxoId);
}

module.exports = { executar, CENARIO, COD, INCOMPLETAS, TITULO_TAREFA, NOME_GATILHO };
