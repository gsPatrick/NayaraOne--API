'use strict';
/** Pessoas fictícias do roteiro de aceite: criação idempotente pelo nome exato (a API de pessoas não tem busca por texto). */
const trocarMinusculas = (s) => String(s || '').trim().toLowerCase();

async function acharPessoa(sessao, nome) {
  const r = await sessao.chamar('GET', '/people');
  const lista = Array.isArray(r.dados) ? r.dados : [];
  return lista.find((p) => trocarMinusculas(p.legalName) === trocarMinusculas(nome) && !p.deleted_at) || null;
}

async function garantirPessoa(sessao, nome) {
  const existente = await acharPessoa(sessao, nome);
  if (existente) return { pessoa: existente, criada: false };
  const r = await sessao.chamar('POST', '/people', { personType: 'PF', legalName: nome });
  if (r.status !== 201) throw new Error(`Não consegui criar a pessoa "${nome}": HTTP ${r.status} ${r.erro ? r.erro.code : ''}`);
  return { pessoa: r.dados, criada: true };
}

async function garantirEmail(sessao, pessoaId, email) {
  const r = await sessao.chamar('GET', `/people/${pessoaId}/contacts`);
  const lista = Array.isArray(r.dados) ? r.dados : [];
  if (lista.some((c) => c.contactType === 'EMAIL' && trocarMinusculas(c.valueNormalized) === trocarMinusculas(email))) return false;
  const c = await sessao.chamar('POST', `/people/${pessoaId}/contacts`, { contactType: 'EMAIL', valueNormalized: email, isPrimary: true });
  if (c.status !== 201) throw new Error(`Não consegui gravar o e-mail fictício: HTTP ${c.status}`);
  return true;
}

/** Garante que o consentimento VIGENTE de (canal, finalidade) seja o desejado; devolve quantos registros novos foram gravados. */
async function garantirConsentimento(sessao, pessoaId, { canal, finalidade, status }) {
  const r = await sessao.chamar('GET', `/people/${pessoaId}/consents`);
  const lista = (Array.isArray(r.dados) ? r.dados : []).filter((c) => c.channel === canal && c.purpose === finalidade);
  const vigente = lista[0] || null; // a API devolve do mais novo para o mais antigo
  const gravar = async (st) => {
    const g = await sessao.chamar('POST', `/people/${pessoaId}/consents`, { channel: canal, purpose: finalidade, status: st });
    if (g.status !== 201) throw new Error(`Não consegui registrar ${st}: HTTP ${g.status} ${g.erro ? g.erro.code : ''}`);
    return 1;
  };
  let novos = 0;
  if (status === 'OPT_OUT' && lista.length === 0) novos += await gravar('OPT_IN'); // histórico completo: primeiro aceitou, depois saiu
  if (!vigente || vigente.status !== status || (status === 'OPT_OUT' && novos > 0)) novos += await gravar(status);
  return novos;
}

module.exports = { acharPessoa, garantirPessoa, garantirEmail, garantirConsentimento };
