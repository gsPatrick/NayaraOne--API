'use strict';
/**
 * Ponto 5, parte 3: bloqueio EFETIVO do envio. Uma campanha de e-mail com os três contatos do ponto 5 (opt-in, opt-out, sem
 * consentimento). A rotina de campanhas avalia o canSend de cada um na hora do envio. Conferência por destinatário:
 * - opt-out e sem consentimento: a mensagem gerada pela campanha fica BLOCKED na trilha (`marketing.message.blocked` sobre a
 *   pessoa, com a campanha, o motivo SUPPRESSED/OPT_OUT ou NO_CONSENT e "não enviada") e NENHUMA mensagem sai para eles
 *   (GET /messages?personId= sem mensagem de saída);
 * - opt-in (controle positivo): recebe o e-mail (mensagem de saída SENT), o que prova que a campanha rodou de verdade.
 * O motivo do bloqueio é decidido ANTES de chamar o provedor: o bloqueio não depende do e-mail da homologação funcionar.
 * Reaproveita do roteiro geral a configuração do descadastro e o modelo de e-mail. Campanha idempotente pelo código.
 */
const { listar } = require('../lib/auditoria');
const { dormir, PararScript } = require('../lib/cliente');
const optOutGeral = require('../cenarios/optOutCampanha');

const CENARIO = '(2) bloqueio do envio';
const COD_CAMPANHA = `ACEITE-M9-P5-CAMPANHA${process.env.HOMO_SUFIXO_CAMPANHA ? `-${String(process.env.HOMO_SUFIXO_CAMPANHA).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}` : ''}`;
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : []);

/** "21:00 a 08:00 America/Sao_Paulo" -> está no silêncio agora (ou começa nos próximos `folgaMin` minutos)? */
function noSilencio(valor, agora = new Date(), folgaMin = 6) {
  const m = String(valor || '').match(/(\d{1,2}):(\d{2})\s*a\s*(\d{1,2}):(\d{2})\s*(\S+)?/);
  if (!m) return { silencio: false, texto: valor };
  const fuso = m[5] || 'America/Sao_Paulo';
  const ini = Number(m[1]) * 60 + Number(m[2]); const fim = Number(m[3]) * 60 + Number(m[4]);
  const minuto = (d) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value); };
  const dentro = (x) => (ini < fim ? x >= ini && x < fim : x >= ini || x < fim);
  const agoraMin = minuto(agora); const depois = minuto(new Date(agora.getTime() + folgaMin * 60000));
  return { silencio: dentro(agoraMin) || dentro(depois), texto: `${m[1]}:${m[2]} a ${m[3]}:${m[4]} ${fuso}` };
}

async function acharCampanha(ctx) {
  const { itens } = await listar(ctx.admin, { action: 'marketing.campaign.create' });
  const e = itens.find((x) => x.afterJson && x.afterJson.code === COD_CAMPANHA);
  return e ? e.entityId : null;
}

async function garantirCampanha(ctx, modeloId, pessoaIds) {
  const existente = await acharCampanha(ctx);
  if (existente) return { id: existente, situacao: 'já existia (só conferida de novo)' };
  const silencio = (await ctx.admin.chamar('GET', '/settings/marketing.quiet_hours')).dados;
  const s = noSilencio(silencio && silencio.value);
  if (s.silencio) throw new PararScript(`Agora é horário de silêncio do Marketing (${s.texto}): o e-mail seria adiado, não enviado. Rode o roteiro fora desse horário.`);
  const agora = Date.now();
  const r = await ctx.admin.chamar('POST', '/marketing/campaigns', {
    code: COD_CAMPANHA, name: 'ACEITE-M9 P5 Campanha do bloqueio por opt-out', objective: 'ACEITE-M9 provar que só o contato com consentimento recebe.',
    objectiveMetric: 'LEADS', targetValue: 10, budgetAmount: 0, budgetJustification: 'Campanha de teste sem custo (dados fictícios).', channels: ['EMAIL'],
    startsAt: new Date(agora + 20000).toISOString(), endsAt: new Date(agora + 86400000).toISOString(),
    audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds: pessoaIds } }],
    steps: [{ channel: 'EMAIL', templateId: modeloId, offsetMinutes: 0 }], schedule: true,
  });
  if (r.status !== 201) throw new Error(`Não consegui criar e agendar a campanha: ${resumo(r)} ${r.erro ? r.erro.message : ''}`);
  return { id: r.dados.id, situacao: 'criada e agendada agora (começa em cerca de 20 s)' };
}

async function esperarEtapa(ctx, campanhaId, maximoSeg = 300) {
  const fim = Date.now() + maximoSeg * 1000;
  for (;;) {
    const c = await ctx.admin.chamar('GET', `/marketing/campaigns/${campanhaId}`);
    const etapa = c.dados && c.dados.steps && c.dados.steps[0];
    if (etapa && !['PLANNED', 'SCHEDULED'].includes(etapa.status)) return c.dados;
    if (Date.now() >= fim) return c.dados;
    await dormir(5000);
  }
}

async function bloqueiosDaCampanha(ctx, pessoaId, campanhaId) {
  const { itens } = await listar(ctx.admin, { entityId: pessoaId, action: 'marketing.message.blocked' });
  return itens.filter((e) => e.afterJson && e.afterJson.campaignId === campanhaId);
}

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  const { optIn, optOut, semConsentimento } = ctx.p5.contatos;
  await optOutGeral.garantirDescadastro(ctx);
  const modelo = await optOutGeral.garantirModelo(ctx);
  const campanha = await garantirCampanha(ctx, modelo.id, [optIn.id, optOut.id, semConsentimento.id].sort());
  Object.assign(ctx.ids, { modeloId: modelo.id, campanhaId: campanha.id });
  ctx.rel.item('Modelo de e-mail', 'aceite-m9-modelo-email', modelo.situacao, modelo.id, 'pela API: GET /marketing/templates');
  ctx.rel.item('Campanha', COD_CAMPANHA, campanha.situacao, campanha.id, 'pela API: GET /marketing/campaigns/:id; Atividades (/painel/atividades)');

  const camp = await esperarEtapa(ctx, campanha.id);
  const etapa = camp && camp.steps && camp.steps[0];
  ctx.rel.conferir(CENARIO, 'a rotina de campanhas processou a etapa (SENT)', Boolean(etapa) && etapa.status === 'SENT', `etapa ${etapa ? etapa.status : '?'}${etapa && etapa.statusReason ? ` (${etapa.statusReason})` : ''}; público ${camp ? camp.audienceSize : '?'}`);
  const reach = (camp && camp.reach) || {};
  // reach (M9-D419, só contagens): o opt-out sai do alcance por supressão; o "sem consentimento" ainda conta como alcançável
  // (tem endereço e não pediu para sair) e é barrado no canSend da hora do envio, por isso só 1 entregue.
  const fora = (reach.excludedSuppressed || 0) + (reach.excludedOptOut || 0);
  ctx.rel.conferir(CENARIO, 'alcance: 3 no público, o opt-out fora do alcance e só 1 entregue', camp && camp.audienceSize === 3 && fora === 1 && reach.reachable === 2 && reach.delivered === 1,
    `audienceSize=${camp && camp.audienceSize}; reach=${JSON.stringify({ reachable: reach.reachable, excludedSuppressed: reach.excludedSuppressed, excludedOptOut: reach.excludedOptOut, excludedNoAddress: reach.excludedNoAddress, delivered: reach.delivered })}`);

  for (const [pessoa, motivos, rotulo] of [[optOut, ['SUPPRESSED', 'OPT_OUT'], 'opt-out'], [semConsentimento, ['NO_CONSENT'], 'sem consentimento']]) {
    const bloq = await bloqueiosDaCampanha(ctx, pessoa.id, campanha.id);
    const b = bloq[0];
    ctx.rel.conferir(CENARIO, `contato ${rotulo}: a mensagem gerada pela campanha ficou BLOCKED (${motivos.join(' ou ')}), não enviada`,
      bloq.length === 1 && motivos.includes(b.afterJson.reason) && b.afterJson.deliveryStatus === 'BLOCKED' && b.afterJson.sent === false,
      b ? `GET /audit-log?entityId=:pessoa&action=marketing.message.blocked -> ${bloq.length} linha(s) desta campanha: status ${b.afterJson.deliveryStatus}, motivo ${b.afterJson.reason} (${b.afterJson.code}), enviada=${b.afterJson.sent}, em ${b.occurredAt}; "${b.reason}"` : 'nenhuma linha de bloqueio desta campanha na trilha');
    const msgs = lista(await ctx.admin.chamar('GET', `/messages?personId=${pessoa.id}`)).filter((m) => m.direction === 'OUTBOUND');
    ctx.rel.conferir(CENARIO, `contato ${rotulo}: nenhuma mensagem saiu para ele`, msgs.length === 0, `GET /messages?personId=:pessoa -> ${msgs.length} mensagem(ns) de saída`);
    ctx.p5[`bloqueio_${rotulo.replace(/\W+/g, '_')}`] = b ? b.id : null;
  }
  const recebidas = lista(await ctx.admin.chamar('GET', `/messages?personId=${optIn.id}`)).filter((m) => m.channel === 'EMAIL' && m.direction === 'OUTBOUND');
  const bloqOk = await bloqueiosDaCampanha(ctx, optIn.id, campanha.id);
  ctx.rel.conferir(CENARIO, 'controle: o contato com opt-in recebeu o e-mail da campanha e não tem linha de bloqueio',
    recebidas.some((m) => ['SENT', 'DELIVERED', 'READ'].includes(m.deliveryStatus)) && bloqOk.length === 0,
    `mensagens de e-mail de saída: ${recebidas.map((m) => m.deliveryStatus).join(', ') || 'nenhuma'}; linhas de bloqueio desta campanha: ${bloqOk.length}`);
}

module.exports = { executar, CENARIO, COD_CAMPANHA, noSilencio };
