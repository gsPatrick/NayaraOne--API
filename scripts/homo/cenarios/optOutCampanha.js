'use strict';
/** Cenário (a): campanha que atinge um contato com consentimento e outro com opt-out; o opt-out é barrado. */
const { garantirPessoa, garantirEmail, garantirConsentimento } = require('../lib/pessoas');
const { listar } = require('../lib/auditoria');
const { dormir } = require('../lib/cliente');
const { exigirForaDoSilencio } = require('../ponto5/silencio');

const CENARIO = '(a) opt-out bloqueia campanha';
const NOME_OK = 'ACEITE-M9 Contato Com Consentimento';
const NOME_OUT = 'ACEITE-M9 Contato Com Opt-out';
const EMAIL_OK = 'aceite-m9-com-consentimento@exemplo.invalid';
const EMAIL_OUT = 'aceite-m9-com-optout@exemplo.invalid';
const COD_MODELO = 'aceite-m9-modelo-email';
// HOMO_SUFIXO_CAMPANHA (opcional) cria uma campanha nova para refazer a prova depois de ajustar configuração (cada campanha envia uma vez por contato).
const COD_CAMPANHA = `ACEITE-M9-CAMPANHA-OPTOUT${process.env.HOMO_SUFIXO_CAMPANHA ? `-${String(process.env.HOMO_SUFIXO_CAMPANHA).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}` : ''}`;
const URL_DESCADASTRO = 'https://exemplo.invalid/descadastro?t={token}';
const DOMINIO_FICTICIO = 'exemplo.invalid';
const FINALIDADE = 'MARKETING';

async function valorDe(ctx, chave, padrao) {
  const r = await ctx.admin.chamar('GET', `/settings/${chave}`);
  return r.status === 200 && r.dados && r.dados.value !== undefined ? String(r.dados.value) : padrao;
}

async function gravarParametro(ctx, chave, valor) {
  const p = await ctx.admin.chamar('PUT', `/settings/${chave}`, { value: valor });
  if (p.status >= 300) throw new Error(`Não consegui configurar "${chave}": HTTP ${p.status} ${p.erro ? p.erro.code : ''}`);
}

/**
 * O e-mail de marketing só sai com link de descadastro (regra do livro) e o domínio do link precisa ser aceito pela regra de URL.
 * Só ajusta o que estiver no padrão ("nenhum"/lista sem o domínio fictício) e avisa; nunca troca um link já configurado pela empresa.
 */
async function garantirDescadastro(ctx) {
  const partes = [];
  if ((await valorDe(ctx, 'marketing.email.url_descadastro', 'nenhum')) === 'nenhum') {
    await gravarParametro(ctx, 'marketing.email.url_descadastro', URL_DESCADASTRO);
    partes.push('link de descadastro fictício configurado agora');
  } else partes.push('link de descadastro já configurado');
  const dominios = await valorDe(ctx, 'marketing.url.dominios_permitidos', 'nenhum');
  const lista = dominios.split(',').map((d) => d.trim().toLowerCase()).filter((d) => d && d !== 'nenhum');
  if (!lista.includes(DOMINIO_FICTICIO)) {
    await gravarParametro(ctx, 'marketing.url.dominios_permitidos', [...lista, DOMINIO_FICTICIO].join(', '));
    partes.push(`domínio ${DOMINIO_FICTICIO} liberado agora`);
  } else partes.push('domínio fictício já liberado');
  if (partes.some((t) => /agora/.test(t))) ctx.rel.aviso('Ajustei parâmetros em Configurações > Marketing (link de descadastro e/ou domínio permitido, ambos fictícios .invalid) para o e-mail de teste poder sair pelo provedor de testes. Remova depois do aceite se quiser.');
  return partes.join('; ');
}

async function garantirModelo(ctx) {
  let r = await ctx.admin.chamar('GET', '/marketing/templates');
  let item = ((r.dados && r.dados.items) || []).find((i) => i.code === COD_MODELO);
  if (!item) {
    const c = await ctx.admin.chamar('POST', '/marketing/templates', { code: COD_MODELO, kind: 'MESSAGE', channel: 'EMAIL', body: 'ACEITE-M9 mensagem fictícia de teste.' });
    if (c.status !== 201) throw new Error(`Não consegui criar o modelo: HTTP ${c.status} ${c.erro ? c.erro.code : ''}`);
    r = await ctx.admin.chamar('GET', '/marketing/templates');
    item = ((r.dados && r.dados.items) || []).find((i) => i.code === COD_MODELO);
  }
  if (!item.currentPublished) {
    const rascunho = item.versions.find((v) => v.status === 'DRAFT') || item.versions[0];
    const p = await ctx.admin.chamar('POST', `/marketing/templates/${rascunho.id}/publish`, {});
    if (p.status !== 200) throw new Error(`Não consegui publicar o modelo: HTTP ${p.status} ${p.erro ? p.erro.code : ''}`);
    return { id: rascunho.id, situacao: 'criado e publicado agora' };
  }
  return { id: item.currentPublished.id, situacao: 'já existia, publicado' };
}

async function acharCampanha(ctx) {
  const { itens } = await listar(ctx.admin, { action: 'marketing.campaign.create' });
  const achada = itens.find((e) => e.afterJson && e.afterJson.code === COD_CAMPANHA);
  return achada ? achada.entityId : null;
}

async function garantirCampanha(ctx, modeloId, pessoaIds) {
  let id = await acharCampanha(ctx);
  if (id) return { id, situacao: 'já existia' };
  await exigirForaDoSilencio(ctx); // mesma trava do ponto 5 (DI-M9R-5): no horário de silêncio efetivo, para antes de criar a campanha
  const agora = Date.now();
  const corpo = {
    code: COD_CAMPANHA, name: 'ACEITE-M9 Campanha de teste de opt-out', objective: 'ACEITE-M9 provar que o contato com opt-out não recebe a campanha.',
    objectiveMetric: 'LEADS', targetValue: 10, budgetAmount: 0, budgetJustification: 'Campanha de teste sem custo (dados fictícios).', channels: ['EMAIL'],
    startsAt: new Date(agora + 20000).toISOString(), endsAt: new Date(agora + 86400000).toISOString(),
    audiences: [{ kind: 'PERSON_LIST', purpose: FINALIDADE, filter: { personIds: pessoaIds } }],
    steps: [{ channel: 'EMAIL', templateId: modeloId, offsetMinutes: 0 }], schedule: true,
  };
  const r = await ctx.admin.chamar('POST', '/marketing/campaigns', corpo);
  if (r.status === 409) { id = await acharCampanha(ctx); if (id) return { id, situacao: 'já existia' }; }
  if (r.status !== 201) throw new Error(`Não consegui criar/agendar a campanha: HTTP ${r.status} ${r.erro ? `${r.erro.code} ${r.erro.message}` : ''}`);
  return { id: r.dados.id, situacao: 'criada e agendada agora (começa em ~20 s)' };
}

/** Prepara pessoas, modelo e campanha. Devolve o que o restante precisa. */
async function preparar(ctx) {
  console.log(`\n--- ${CENARIO}: preparação ---`);
  const descadastro = await garantirDescadastro(ctx);
  const com = await garantirPessoa(ctx.admin, NOME_OK);
  const sem = await garantirPessoa(ctx.admin, NOME_OUT);
  await garantirEmail(ctx.admin, com.pessoa.id, EMAIL_OK);
  await garantirEmail(ctx.admin, sem.pessoa.id, EMAIL_OUT);
  await garantirConsentimento(ctx.admin, com.pessoa.id, { canal: 'EMAIL', finalidade: FINALIDADE, status: 'OPT_IN' });
  await garantirConsentimento(ctx.admin, sem.pessoa.id, { canal: 'EMAIL', finalidade: FINALIDADE, status: 'OPT_OUT' });
  const modelo = await garantirModelo(ctx);
  const campanha = await garantirCampanha(ctx, modelo.id, [com.pessoa.id, sem.pessoa.id].sort());
  Object.assign(ctx.ids, { pessoaOk: com.pessoa.id, pessoaOptOut: sem.pessoa.id, modeloId: modelo.id, campanhaId: campanha.id });
  ctx.rel.item('Pessoa fictícia', `${NOME_OK} (${EMAIL_OK})`, `${com.criada ? 'criada' : 'já existia'}; consentimento e-mail/marketing: OPT_IN`, com.pessoa.id, 'Contatos (/painel/pessoas) > abrir a pessoa');
  ctx.rel.item('Pessoa fictícia', `${NOME_OUT} (${EMAIL_OUT})`, `${sem.criada ? 'criada' : 'já existia'}; consentimento e-mail/marketing: OPT_OUT`, sem.pessoa.id, 'Contatos (/painel/pessoas) > abrir a pessoa');
  ctx.rel.item('Modelo de e-mail', COD_MODELO, modelo.situacao, modelo.id, 'sem tela própria; ver pela API (GET /marketing/templates)');
  ctx.rel.item('Campanha', COD_CAMPANHA, campanha.situacao, campanha.id, 'sem tela própria; GET /marketing/campaigns/:id e Marketing (BI) em /painel/analytics/marketing');
  ctx.rel.item('Parâmetro', 'marketing.email.url_descadastro + marketing.url.dominios_permitidos', descadastro, '-', 'Configurações (/painel/configuracoes) > aba Marketing');
}

async function esperarEtapa(ctx, maximoSeg) {
  const fim = Date.now() + maximoSeg * 1000;
  let c;
  do {
    c = await ctx.admin.chamar('GET', `/marketing/campaigns/${ctx.ids.campanhaId}`);
    const etapa = c.dados && c.dados.steps && c.dados.steps[0];
    if (etapa && !['PLANNED', 'SCHEDULED'].includes(etapa.status)) return c.dados;
    if (Date.now() < fim) await dormir(5000);
  } while (Date.now() < fim);
  return c.dados;
}

async function conferir(ctx) {
  console.log(`\n--- ${CENARIO}: conferência ---`);
  const camp = await esperarEtapa(ctx, 240);
  const etapa = camp && camp.steps && camp.steps[0];
  if (!etapa || ['PLANNED', 'SCHEDULED'].includes(etapa.status)) {
    ctx.rel.conferir(CENARIO, 'a etapa da campanha foi processada pela rotina automática', null, `etapa ainda "${etapa ? etapa.status : '?'}" após 4 minutos: a rotina de campanhas (roda a cada 1 minuto) pode estar desligada ou o horário de silêncio está ativo. Rode de novo mais tarde.`);
    return;
  }
  const reach = camp.reach || {};
  ctx.rel.conferir(CENARIO, 'a campanha atinge os dois contatos (público = 2)', camp.audienceSize === 2, `audienceSize=${camp.audienceSize}`);
  ctx.rel.conferir(CENARIO, 'o contato com opt-out é barrado: sai da lista de alcançáveis por SUPRESSÃO', reach.excludedSuppressed >= 1 && reach.reachable === 1, `reach: alcançáveis=${reach.reachable}, excluídos por supressão/opt-out=${reach.excludedSuppressed}`);
  ctx.rel.conferir(CENARIO, `a etapa da campanha foi concluída (status ${etapa.status})`, etapa.status === 'SENT', `step.status=${etapa.status}${etapa.statusReason ? ` (${etapa.statusReason})` : ''}`);
  const msgOk = await ctx.admin.chamar('GET', `/messages?personId=${ctx.ids.pessoaOk}`);
  const msgOut = await ctx.admin.chamar('GET', `/messages?personId=${ctx.ids.pessoaOptOut}`);
  const enviadas = (Array.isArray(msgOk.dados) ? msgOk.dados : []).filter((m) => m.channel === 'EMAIL' && m.direction === 'OUTBOUND');
  const enviadasOut = (Array.isArray(msgOut.dados) ? msgOut.dados : []).filter((m) => m.direction === 'OUTBOUND');
  ctx.rel.conferir(CENARIO, 'o contato COM consentimento recebeu o e-mail (provedor de testes do sistema)', enviadas.length >= 1, `mensagens de e-mail enviadas a ele: ${enviadas.length}${enviadas[0] ? ` (status ${enviadas[0].deliveryStatus})` : ''}; entregues na campanha: ${reach.delivered}`);
  ctx.rel.conferir(CENARIO, 'o contato COM opt-out NÃO recebeu nada', enviadasOut.length === 0, `mensagens enviadas a ele: ${enviadasOut.length}`);
  ctx.rel.aviso('Motivo por destinatário (BLOCKED / SUPPRESSED) fica só na tabela de entregas da campanha; nenhuma rota nem tela mostra esse detalhe hoje. A API mostra o motivo agregado em reach.excludedSuppressed.');
}

module.exports = { preparar, conferir, garantirDescadastro, garantirModelo, NOME_OK, NOME_OUT, CENARIO, FINALIDADE };
