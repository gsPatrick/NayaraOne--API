'use strict';

/**
 * M9-D409 — rascunho determinístico dos tipos que nascem de gatilho. O texto usa SÓ os fatos do tipo (nunca inventa atributo) e
 * nunca cita valor onde o livro proíbe (SOLD_RENTED e POST_SALE). Valores em reais saem exatamente como estão nos fatos.
 */
const brl = (value) => `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TIPO = Object.freeze({ RESIDENTIAL: 'imóvel residencial', COMMERCIAL: 'imóvel comercial', LAND: 'terreno', RURAL: 'imóvel rural' });
const FINALIDADE = Object.freeze({ VENDA: 'à venda', LOCACAO: 'para locação', VENDA_E_LOCACAO: 'para venda e locação' });
const tipoLabel = (facts) => TIPO[facts.tipo] || 'imóvel';
const quartosLabel = (n) => `${n} ${Number(n) === 1 ? 'quarto' : 'quartos'}`;

function priceSentence(facts) {
  const parts = [];
  if (facts.precoVenda !== null && facts.precoVenda !== undefined) parts.push(`venda por ${brl(facts.precoVenda)}`);
  if (facts.precoLocacao !== null && facts.precoLocacao !== undefined) parts.push(`locação por ${brl(facts.precoLocacao)}`);
  return parts.join(' e ');
}

const BUILDERS = {
  NEW_PROPERTY: (facts) => ({
    title: `Novo imóvel em ${facts.bairro}`,
    texto: `Novo na Nayara: ${tipoLabel(facts)} ${FINALIDADE[facts.finalidade] || ''} no bairro ${facts.bairro}, com ${quartosLabel(facts.quartos)}, ${priceSentence(facts)}.`.replace(/\s+/g, ' '),
  }),
  PRICE_REDUCTION: (facts, ctx) => ({
    title: `Preço reduzido em ${facts.bairro}`,
    texto: `Preço reduzido: ${tipoLabel(facts)} no bairro ${facts.bairro}, de ${brl(facts.precoAnterior)} por ${brl(ctx.currentPrice)}, uma redução de ${ctx.percent}%.`,
  }),
  SOLD_RENTED: (facts) => ({
    title: `${facts.status === 'VENDIDO' ? 'Vendido' : 'Alugado'} em ${facts.bairro}`,
    texto: `${tipoLabel(facts)} no bairro ${facts.bairro} foi ${facts.status === 'VENDIDO' ? 'vendido' : 'alugado'} com a Nayara.`.replace(/^./, (c) => c.toUpperCase()),
  }),
  NAYARA_CONSTRUCTION: (facts) => ({
    title: `Obra ${facts.nomeEmpreendimento}`,
    texto: `Atualização da obra ${facts.nomeEmpreendimento}: etapa ${facts.etapaPublica}.`,
  }),
  POST_SALE: (facts) => ({
    title: `Entrega das chaves: ${facts.primeiroNome}`,
    texto: `Parabéns pela conquista, ${facts.primeiroNome}! A entrega das suas chaves foi registrada. A Nayara segue com você.`,
  }),
  BIRTHDAY_RELATIONSHIP: (facts) => ({
    title: `Aniversário: ${facts.primeiroNome}`,
    texto: `Feliz aniversário, ${facts.primeiroNome}! A equipe da Nayara deseja um dia especial.`,
  }),
};

/** { title, texto } do tipo a partir dos fatos; tipo sem gatilho de rascunho devolve null. */
function buildTriggeredText(type, facts, ctx = {}) {
  const builder = BUILDERS[type];
  return builder ? builder(facts, ctx) : null;
}

/**
 * Fatos que seguem para a NAY escrever o rascunho (só em memória; o snapshot guardado é o da fonte): o blog leva tema e fontes, e
 * a redução leva o percentual já calculado, para a NAY nunca fazer conta.
 */
function draftFactsFor(type, input, facts, decimals) {
  if (type === 'EDUCATIONAL_BLOG') return { tema: input.tema, fontes: input.fontes };
  if (type === 'PRICE_REDUCTION') {
    const { reductionPercent, currentPriceOf } = require('./priceReduction');
    const result = reductionPercent(facts.precoAnterior, currentPriceOf(facts), decimals);
    return result.isReduction ? { ...facts, reducaoPercentual: result.percent } : facts;
  }
  return facts;
}

module.exports = { buildTriggeredText, draftFactsFor, brl };
