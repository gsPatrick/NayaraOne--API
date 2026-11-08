'use strict';
/** Cenário (d): para cada ação dos cenários anteriores, o registro correspondente na trilha de auditoria (quem, o quê, quando). */
const { listar, linha } = require('../lib/auditoria');
const A = require('./automacao');

const CENARIO = '(d) trilha de auditoria';

async function entradas(ctx, filtros) { return (await listar(ctx.admin, filtros)).itens; }

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  const { pessoaOptOut, modeloId, campanhaId, fluxoId, tarefaId } = ctx.ids;
  const nomes = { [ctx.admin.userId]: `${ctx.admin.email} (administrador do teste)` };
  const quemFez = (e) => (e.userId === ctx.admin.userId);
  const dizer = (e) => linha(e, nomes);

  // 1) Modelo
  const mod = await entradas(ctx, { entityId: modeloId });
  const pub = mod.find((e) => e.action === 'marketing.template.publish');
  const cri = mod.find((e) => e.action === 'marketing.template.create');
  ctx.rel.conferir(CENARIO, 'modelo de e-mail: criação e publicação registradas', Boolean(pub && cri), pub ? dizer(pub) : 'sem registro de publicação (o modelo pode ter sido criado em outra rodada com outra versão)');

  // 2) Opt-out: a supressão criada no mesmo instante do registro de consentimento
  const cons = await ctx.admin.chamar('GET', `/people/${pessoaOptOut}/consents`);
  const optOut = (Array.isArray(cons.dados) ? cons.dados : []).filter((c) => c.status === 'OPT_OUT' && c.channel === 'EMAIL').pop();
  const supr = (await entradas(ctx, { action: 'marketing.suppression.created' }));
  const alvoTempo = optOut ? new Date(optOut.recordedAt).getTime() : 0;
  const par = supr.find((e) => Math.abs(new Date(e.occurredAt).getTime() - alvoTempo) < 3000);
  ctx.rel.conferir(CENARIO, 'registro do opt-out: o consentimento fica no histórico do contato e a supressão fica na auditoria', Boolean(optOut && par && par.userId === optOut.createdBy),
    optOut ? `consentimento ${optOut.status} gravado em ${optOut.recordedAt} por ${nomes[optOut.createdBy] || optOut.createdBy}; auditoria: ${par ? dizer(par) : 'NÃO ENCONTRADA'}` : 'sem opt-out no histórico');

  // 3) Campanha
  const camp = await entradas(ctx, { entityId: campanhaId });
  for (const [acao, rotulo, humano] of [['marketing.campaign.create', 'criação da campanha', true], ['marketing.campaign.schedule', 'agendamento da campanha', true], ['marketing.campaign.start', 'início automático da campanha', false]]) {
    const e = camp.find((x) => x.action === acao);
    ctx.rel.conferir(CENARIO, `campanha: ${rotulo} registrada${humano ? ' com o autor' : ' pela rotina do sistema'}`, Boolean(e) && (humano ? quemFez(e) : e.userId === null), e ? dizer(e) : 'NÃO ENCONTRADO');
  }
  const camDto = await ctx.admin.chamar('GET', `/marketing/campaigns/${campanhaId}`);
  const etapaId = camDto.dados && camDto.dados.steps && camDto.dados.steps[0] && camDto.dados.steps[0].id;
  const et = etapaId ? (await entradas(ctx, { entityId: etapaId })).find((x) => x.action === 'marketing.campaign.step.sent') : null;
  ctx.rel.conferir(CENARIO, 'campanha: conclusão do envio da etapa registrada', Boolean(et), et ? dizer(et) : 'NÃO ENCONTRADO (etapa pode não ter sido processada ainda)');

  // 4) Automação
  if (fluxoId) {
    const fl = await entradas(ctx, { entityId: fluxoId });
    for (const [acao, rotulo] of [['marketing.automation.create_version', 'criação da automação'], ['marketing.automation.publish', 'publicação da automação'], ['marketing.automation.pause', 'pausa da automação']]) {
      const e = fl.find((x) => x.action === acao);
      ctx.rel.conferir(CENARIO, `automação: ${rotulo} registrada com o autor`, Boolean(e) && quemFez(e), e ? dizer(e) : 'NÃO ENCONTRADO');
    }
  }
  if (tarefaId) {
    const t = (await entradas(ctx, { entityId: tarefaId }))[0];
    ctx.rel.conferir(CENARIO, 'automação: a execução (tarefa criada) registrada', Boolean(t), t ? dizer(t) : 'NÃO ENCONTRADO');
  }

  // 5) Parâmetro de marketing, se o script o configurou
  const par2 = (await entradas(ctx, { entityType: 'TenantSetting' })).find((e) => e.afterJson && e.afterJson.key === 'marketing.email.url_descadastro');
  ctx.rel.conferir(CENARIO, 'parâmetro do link de descadastro: alteração registrada', par2 ? true : null, par2 ? dizer(par2) : 'não localizado (o parâmetro pode já ter sido configurado por outra pessoa antes)');

  // 6) Perfil de leitura/outra empresa: tentativas recusadas não podem deixar rastro de alteração
  if (ctx.leitura) {
    const rec = (await entradas(ctx, { userId: ctx.leitura.userId })).filter((e) => /\.(create|update|publish|pause|schedule)$|consent/.test(e.action));
    ctx.rel.conferir(CENARIO, 'o perfil somente leitura não aparece na auditoria como autor de nenhuma alteração', rec.length === 0, `alterações atribuídas a ele: ${rec.length}`);
  }
  if (!ctx.rel.conferencias.some((c) => c.cenario === CENARIO)) ctx.rel.conferir(CENARIO, 'trilha', null, 'nada a conferir');
  void A;
}

module.exports = { executar, CENARIO };
