'use strict';
/** Cenário (b): automação criada, publicada, executada de ponta a ponta e pausada. */
const { garantirPessoa } = require('../lib/pessoas');
const { listar } = require('../lib/auditoria');
const { dormir } = require('../lib/cliente');

const CENARIO = '(b) automação';
const COD_AUTOMACAO = 'ACEITE-M9-AUTOMACAO-NOVO-CONTATO';
const NOME_GATILHO = 'ACEITE-M9 Contato Gatilho da Automacao';
const TITULO_TAREFA = 'ACEITE-M9 Acompanhar contato novo';
const MOTIVO_PUBLICAR = `ACEITE-M9 publicação da automação ${COD_AUTOMACAO}`;
const MOTIVO_PAUSAR = `ACEITE-M9 pausa da automação ${COD_AUTOMACAO} após a demonstração (evita agir sobre contatos reais)`;

const definicao = (ownerUserId) => ({
  code: COD_AUTOMACAO, name: 'ACEITE-M9 Automação: tarefa para contato novo', triggerType: 'EVENT', triggerConfig: { eventType: 'person.created' },
  conditions: [], conditionsEmptyReason: 'ACEITE-M9 vale para qualquer contato novo (apenas na demonstração)',
  actions: [{ actionType: 'CREATE_TASK', title: TITULO_TAREFA }], cooldown: { amount: 1, unit: 'DAYS' },
  frequencyCap: { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' }, riskLevel: 'LOW', ownerUserId,
});

/** O id do fluxo é achado pela auditoria da publicação, cujo motivo leva o código da automação. */
async function acharFluxoPublicado(ctx) {
  const { itens } = await listar(ctx.admin, { action: 'marketing.automation.publish' });
  const e = itens.find((x) => x.reason === MOTIVO_PUBLICAR);
  return e ? e.entityId : null;
}

async function acharTarefa(ctx, pessoaId) {
  const { itens } = await listar(ctx.admin, { action: 'marketing.automation.task_create' });
  return itens.find((e) => e.afterJson && e.afterJson.relatedEntityId === pessoaId && e.afterJson.title === TITULO_TAREFA) || null;
}

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  let fluxoId = await acharFluxoPublicado(ctx);
  let situacao = 'já existia';
  if (!fluxoId) {
    const c = await ctx.admin.chamar('POST', '/marketing/automations', definicao(ctx.admin.userId));
    if (c.status === 409) {
      ctx.rel.conferir(CENARIO, 'a automação existe mas não consegui localizar o id pela auditoria', null, 'o código já existe sem registro de publicação com o motivo esperado (talvez criada e não publicada numa rodada interrompida)');
      return;
    }
    if (c.status !== 201) { ctx.rel.conferir(CENARIO, 'criar a automação', false, `HTTP ${c.status} ${c.erro ? `${c.erro.code} ${c.erro.message}` : ''}`); return; }
    fluxoId = c.dados.flow.id;
    const p = await ctx.admin.chamar('POST', `/marketing/automations/${fluxoId}/publish`, { versionNo: 1, reason: MOTIVO_PUBLICAR });
    ctx.rel.conferir(CENARIO, 'a automação foi criada e publicada (fluxo ATIVO)', p.status === 200 && p.dados.flow.status === 'ACTIVE', `criar: HTTP ${c.status}; publicar: HTTP ${p.status}, fluxo ${p.dados && p.dados.flow ? p.dados.flow.status : '?'}`);
    situacao = 'criada e publicada agora';
  }
  ctx.ids.fluxoId = fluxoId;

  // Gatilho: um contato novo. Se já existe, a automação já foi demonstrada antes.
  const gatilho = await garantirPessoa(ctx.admin, NOME_GATILHO);
  ctx.ids.pessoaGatilho = gatilho.pessoa.id;
  let tarefa = await acharTarefa(ctx, gatilho.pessoa.id);
  if (!tarefa && gatilho.criada) {
    for (let i = 0; i < 24 && !tarefa; i += 1) { await dormir(5000); tarefa = await acharTarefa(ctx, gatilho.pessoa.id); }
  }
  if (tarefa) {
    ctx.ids.tarefaId = tarefa.entityId;
    ctx.rel.conferir(CENARIO, 'a execução ocorreu de ponta a ponta: o contato novo gerou uma tarefa', true, `tarefa ${tarefa.entityId}: "${tarefa.afterJson.title}" (prazo/estado ${tarefa.afterJson.status}), criada em ${tarefa.occurredAt}`);
  } else {
    ctx.rel.conferir(CENARIO, 'a execução gerou a tarefa esperada', gatilho.criada ? false : null, gatilho.criada ? 'o contato gatilho foi criado mas a tarefa não apareceu em 2 minutos' : 'o contato gatilho já existia de rodada anterior e não há registro da tarefa (a automação pode ter sido publicada depois dele)');
  }

  // Encerra a demonstração: pausa o fluxo para que contatos reais não disparem a tarefa.
  const lista = await listar(ctx.admin, { action: 'marketing.automation.pause', entityId: fluxoId });
  const jaPausada = lista.itens.some((e) => e.reason === MOTIVO_PAUSAR);
  if (!jaPausada) {
    const z = await ctx.admin.chamar('POST', `/marketing/automations/${fluxoId}/pause`, { reason: MOTIVO_PAUSAR });
    ctx.rel.conferir(CENARIO, 'a automação foi pausada ao fim da demonstração (não age sobre contatos reais)', z.status === 200 && z.dados.flow.status === 'PAUSED', `HTTP ${z.status}, fluxo ${z.dados && z.dados.flow ? z.dados.flow.status : '?'}`);
    situacao += '; pausada agora';
  } else situacao += '; já pausada';
  ctx.rel.item('Automação', COD_AUTOMACAO, `${situacao} (evento person.created -> criar tarefa)`, fluxoId, 'sem tela própria; ver em Atividades (/painel/atividades) e pela API (POST /marketing/automations)');
  ctx.rel.item('Pessoa fictícia', `${NOME_GATILHO}`, `${gatilho.criada ? 'criada' : 'já existia'} (gatilho da automação)`, gatilho.pessoa.id, 'Contatos (/painel/pessoas)');
  if (tarefa) ctx.rel.item('Tarefa gerada pela automação', TITULO_TAREFA, 'criada pela execução', tarefa.entityId, 'Atividades (/painel/atividades): "Tarefa criada pela automação"');
}

module.exports = { executar, CENARIO, COD_AUTOMACAO, MOTIVO_PUBLICAR, MOTIVO_PAUSAR, TITULO_TAREFA };
