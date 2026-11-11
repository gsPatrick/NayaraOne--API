'use strict';

// M9-D034 — "descrições" e "recuperação" do livro: só RASCUNHO de texto, com fonte, sem publicar nem enviar. A descrição de imóvel
// (livro do Marco 3 §16 e Guia §12) é feita SÓ com os fatos públicos aprovados (comercial.publicFacts.js): o caminho de regra monta o
// texto com eles e o caminho de modelo os recebe como única fonte; nos dois, a saída passa por validateGeneratedDescription
// (comercial.review.js). Campo vazio simplesmente não aparece.
const { dateBR, plural } = require('./comercial.format');
const { loadApprovedFacts, factsText } = require('./comercial.publicFacts');

const BANNER = 'RASCUNHO — não foi publicado nem enviado; revise antes de usar.';

/** Fonte da descrição: os fatos aprovados, com a origem `properties` (a visão pública do imóvel). */
const propertySource = (approved, asOf) => ({ sourceType: 'READ_MODEL', sourceRef: `properties.public:${approved.propertyId}`, title: 'properties', retrievedAt: asOf, text: factsText(approved) });

/** Texto montado pelo código, só com os fatos aprovados (também é a correção quando a guarda tira tudo o que o modelo escreveu). */
function propertyDraftText(approved) {
  const lista = approved.facts.map((f) => `${f.label}: ${f.value}`);
  return [BANNER, `Descrição do imóvel ${approved.publicCode} [1]: ${lista.length ? lista.join('; ') : 'o cadastro ainda não tem atributos públicos preenchidos'}.`, 'Só constam fatos públicos aprovados do cadastro; o que não está preenchido não foi incluído.'].join('\n');
}

async function propertyDraft(propertyId, now, transaction) {
  const approved = await loadApprovedFacts(propertyId, transaction);
  const asOf = now.toISOString();
  return {
    answer: propertyDraftText(approved),
    snapshotAt: asOf,
    structured: { rascunho: true, tipo: 'DESCRICAO_IMOVEL', imovel: approved.propertyId, codigoPublico: approved.publicCode, atributos: approved.facts.map((f) => f.label), fonte: 'FATOS_PUBLICOS_APROVADOS' },
    meta: { approvedFacts: approved.facts, publicCode: approved.publicCode, propertyId: approved.propertyId },
    sources: [propertySource(approved, asOf)],
  };
}

function recoveryDraft(facts) {
  const nome = facts.customerName || 'tudo bem';
  const ultima = facts.lastInteractionAt ? `nossa última conversa foi em ${dateBR(facts.lastInteractionAt)}` : 'ainda não conversamos sobre o seu interesse';
  const dias = facts.daysWithoutContact;
  const corpo = `Olá, ${nome}! Passando para saber se ainda posso ajudar com a sua busca${dias ? ` (${ultima}, há ${dias} ${plural(dias, 'dia', 'dias')})` : ` (${ultima})`}. Se quiser, envio novas opções.`;
  return {
    answer: [BANNER, `Mensagem de recuperação para ${facts.customerName || 'o cliente'} [1]:`, corpo].join('\n'),
    snapshotAt: facts.asOf,
    structured: { rascunho: true, tipo: 'RECUPERACAO_CLIENTE', oportunidade: facts.opportunityId, enviada: false },
    sources: [{
      sourceType: 'READ_MODEL', sourceRef: `crm.opportunities:${facts.opportunityId}`, title: 'crm.opportunities', retrievedAt: facts.asOf,
      text: `Oportunidade ${facts.opportunityId}. Cliente ${facts.customerName || '—'}. Etapa ${facts.stage}. Última interação: ${facts.lastInteractionAt ? dateBR(facts.lastInteractionAt) : 'nenhuma'}. Dias sem contato: ${dias}.`,
    }],
  };
}

module.exports = { propertyDraft, propertyDraftText, propertySource, recoveryDraft, BANNER };
