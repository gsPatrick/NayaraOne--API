'use strict';
/**
 * Ponto 5, parte 1: os três contatos fictícios (opt-in, opt-out e sem consentimento) e a FICHA mostrando o opt-out.
 * A ficha (/painel/pessoas/:id) mostra, ao lado de cada contato, a etiqueta do canal calculada pelo Front a partir de
 * GET /people/:id/consents (lib/api/people.js, consentByChannel): o último registro de cada (canal, finalidade) vale e qualquer
 * finalidade em OPT_OUT vira "Optou por não receber". A conferência abaixo aplica a mesma regra sobre a resposta da API.
 * Preparação idempotente (nome exato), só pela API.
 */
const { garantirPessoa, garantirEmail, garantirConsentimento } = require('../lib/pessoas');

const CENARIO = '(1) opt-out na ficha';
const FINALIDADE = 'MARKETING';
const CONTATOS = Object.freeze({
  optIn: { nome: 'ACEITE-M9 P5 Contato Com Opt-in', email: 'aceite-m9-p5-optin@exemplo.invalid', consentimento: 'OPT_IN' },
  optOut: { nome: 'ACEITE-M9 P5 Contato Com Opt-out', email: 'aceite-m9-p5-optout@exemplo.invalid', consentimento: 'OPT_OUT' },
  semConsentimento: { nome: 'ACEITE-M9 P5 Contato Sem Consentimento', email: 'aceite-m9-p5-sem-consentimento@exemplo.invalid', consentimento: null },
});
const ROTULO = { OPT_OUT: 'Optou por não receber', OPT_IN: 'Consentido' };

/** Mesma regra da ficha (Front, consentByChannel): estado vigente do canal. */
function estadoDoCanal(consentimentos, canal) {
  const ultimo = new Map();
  for (const c of consentimentos) if (c.channel === canal && !ultimo.has(c.purpose)) ultimo.set(c.purpose, c);
  const vigentes = [...ultimo.values()];
  if (vigentes.some((c) => c.status === 'OPT_OUT')) return 'OPT_OUT';
  return vigentes.length ? 'OPT_IN' : null;
}

async function preparar(ctx) {
  console.log(`\n--- ${CENARIO}: preparação ---`);
  const out = {};
  for (const [chave, c] of Object.entries(CONTATOS)) {
    const p = await garantirPessoa(ctx.admin, c.nome);
    await garantirEmail(ctx.admin, p.pessoa.id, c.email);
    if (c.consentimento) await garantirConsentimento(ctx.admin, p.pessoa.id, { canal: 'EMAIL', finalidade: FINALIDADE, status: c.consentimento });
    out[chave] = { id: p.pessoa.id, criada: p.criada, ...c };
    ctx.rel.item('Pessoa fictícia', `${c.nome} (${c.email})`, `${p.criada ? 'criada agora' : 'já existia'}; e-mail/marketing: ${c.consentimento || 'sem registro de consentimento'}`, p.pessoa.id, `Contatos > ficha: /painel/pessoas/${p.pessoa.id}`);
  }
  ctx.p5 = { ...(ctx.p5 || {}), contatos: out };
  // nomes usados pelos cenários reaproveitados do roteiro geral (isolamento e trilha)
  Object.assign(ctx.ids, { pessoaOk: out.optIn.id, pessoaOptOut: out.optOut.id, pessoaSemConsentimento: out.semConsentimento.id });
}

async function conferir(ctx) {
  console.log(`\n--- ${CENARIO}: conferência ---`);
  for (const [chave, c] of Object.entries(ctx.p5.contatos)) {
    const ficha = await ctx.admin.chamar('GET', `/people/${c.id}`);
    const contatos = await ctx.admin.chamar('GET', `/people/${c.id}/contacts`);
    const cons = await ctx.admin.chamar('GET', `/people/${c.id}/consents`);
    const lista = Array.isArray(cons.dados) ? cons.dados : [];
    const temEmail = (Array.isArray(contatos.dados) ? contatos.dados : []).some((x) => x.contactType === 'EMAIL' && String(x.valueNormalized).toLowerCase() === c.email);
    const estado = estadoDoCanal(lista, 'EMAIL');
    const esperado = c.consentimento;
    const rotulo = estado ? ROTULO[estado] : 'Pendente';
    ctx.rel.conferir(CENARIO, `ficha de "${c.nome}": e-mail com a etiqueta "${esperado ? ROTULO[esperado] : 'Pendente'}"`,
      ficha.status === 200 && temEmail && cons.status === 200 && estado === esperado,
      `GET /people/:id ${ficha.status}; e-mail ${temEmail ? 'presente' : 'AUSENTE'}; GET /people/:id/consents ${cons.status}: ${lista.length} registro(s), vigente EMAIL = ${estado || 'nenhum'} -> a ficha mostra "${rotulo}"`);
    if (chave === 'optOut') {
      const historico = lista.filter((x) => x.channel === 'EMAIL' && x.purpose === FINALIDADE).map((x) => x.status);
      ctx.rel.conferir(CENARIO, 'o opt-out guarda o histórico: primeiro aceitou (OPT_IN), depois saiu (OPT_OUT), sem apagar nada',
        historico[0] === 'OPT_OUT' && historico.includes('OPT_IN'), `histórico EMAIL/MARKETING do mais novo para o mais antigo: ${historico.join(' <- ') || 'vazio'}`);
    }
  }
}

module.exports = { preparar, conferir, CONTATOS, CENARIO, FINALIDADE, estadoDoCanal };
