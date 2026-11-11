'use strict';

// Livro do Marco 3 §16: "Classifica qualidade do cadastro e documentos faltantes". Capacidade `classificar_cadastro`, determinística (caminho
// RULE, sem modelo), com fonte: as checagens de completude do cadastro de Pessoas (scorePersonDataQuality, a mesma nota que a tela de
// Pessoas mostra) mais um item por grupo de documento exigido para o tipo de pessoa (parâmetro da empresa). Documento conta quando existe,
// não foi recusado e não venceu; o recusado, o vencido e o que aguarda verificação aparecem com a situação. Os documentos pendentes do
// financiamento da oportunidade entram na lista de faltantes. A classe sai das notas de corte (parâmetros): BOM, REGULAR ou RUIM.
// Nada é gravado: a classificação é calculada na leitura.
const personService = require('../../../people/person.service');
const { CHECKS } = require('../../../people/personDataQuality.service');
const { readQualityParams } = require('./comercial.capParams');
const { notFound } = require('./comercial.scope');

const CLASS_LABEL = Object.freeze({ BOM: 'bom', REGULAR: 'regular', RUIM: 'ruim' });

const today = (now) => now.toISOString().slice(0, 10);

/** Situação de cada grupo exigido: OK (documento válido), PENDENTE_VERIFICACAO, VENCIDO, RECUSADO ou FALTANTE. */
function documentStatus(group, documents, now) {
  const candidates = documents.filter((d) => group.includes(String(d.documentType || '').toUpperCase()));
  const valid = candidates.filter((d) => d.verificationStatus !== 'REJECTED' && (!d.expiresAt || String(d.expiresAt) >= today(now)));
  if (valid.some((d) => d.verificationStatus === 'VERIFIED')) return { group, status: 'OK' };
  if (valid.length) return { group, status: 'PENDENTE_VERIFICACAO' };
  if (candidates.some((d) => d.expiresAt && String(d.expiresAt) < today(now))) return { group, status: 'VENCIDO' };
  if (candidates.length) return { group, status: 'RECUSADO' };
  return { group, status: 'FALTANTE' };
}

const STATUS_TEXT = Object.freeze({ PENDENTE_VERIFICACAO: 'aguardando verificação', VENCIDO: 'vencido', RECUSADO: 'recusado', FALTANTE: 'faltante' });
const groupName = (group) => group.join(' ou ');

/** Classificação a partir do cadastro já lido (função pura). `pendingFinancing`: documentos pendentes do financiamento. */
function classifyRegistration(person, params, { now, pendingFinancing = [] }) {
  const base = person.dataQuality || { score: 0, missing: [] };
  const groups = String(person.personType || '').toUpperCase() === 'PJ' ? params.docsPj : params.docsPf;
  const docs = groups.map((g) => documentStatus(g, person.documents || [], now));
  const baseChecks = CHECKS.length; // as checagens de completude de Pessoas (personDataQuality.service.js), cada uma com o mesmo peso
  const earned = (baseChecks - base.missing.length) + docs.filter((d) => d.status === 'OK' || d.status === 'PENDENTE_VERIFICACAO').length;
  const score = Math.round((earned / (baseChecks + docs.length)) * 100);
  const classe = score >= params.good ? 'BOM' : (score >= params.fair ? 'REGULAR' : 'RUIM');
  return {
    tipo: 'QUALIDADE_CADASTRO', pessoa: person.id, tipoPessoa: person.personType, nota: score, classe,
    camposFaltantes: base.missing.map((m) => m.label),
    documentos: docs.map((d) => ({ exigido: groupName(d.group), situacao: d.status })),
    documentosFaltantes: docs.filter((d) => d.status !== 'OK' && d.status !== 'PENDENTE_VERIFICACAO').map((d) => `${groupName(d.group)} (${STATUS_TEXT[d.status]})`),
    documentosPendentesFinanciamento: pendingFinancing,
    notasDeCorte: { bom: params.good, regular: params.fair },
  };
}

function qualityAnswer(c, name) {
  const faltas = [...c.camposFaltantes, ...c.documentosFaltantes];
  const aguardando = c.documentos.filter((d) => d.situacao === 'PENDENTE_VERIFICACAO').map((d) => d.exigido);
  return [
    `Qualidade do cadastro de ${name || 'cliente sem nome'} [1]: ${CLASS_LABEL[c.classe]} (nota ${c.nota} de 100; bom a partir de ${c.notasDeCorte.bom}, regular a partir de ${c.notasDeCorte.regular}).`,
    faltas.length ? `Falta no cadastro [1]: ${faltas.join('; ')}.` : 'Nada falta no cadastro [1].',
    aguardando.length ? `Documento aguardando verificação [2]: ${aguardando.join('; ')}.` : null,
    c.documentosPendentesFinanciamento.length ? `Documentos pendentes do financiamento [2]: ${c.documentosPendentesFinanciamento.join(', ')}.` : null,
  ].filter(Boolean).join('\n');
}

/** Lê o cadastro (RLS da empresa) e classifica. Pessoa inexistente ou de outra empresa: 404 sem revelar existência. */
async function registrationQuality(personId, { tenant, transaction, now, pendingFinancing = [] }) {
  let person;
  try { person = await personService.getPerson(personId, transaction); } catch (err) {
    if (err && err.statusCode === 404) throw notFound();
    throw err;
  }
  const params = await readQualityParams(tenant, transaction);
  const c = classifyRegistration(person, params, { now, pendingFinancing });
  const asOf = now.toISOString();
  const name = person.preferredName || person.legalName;
  return {
    answer: qualityAnswer(c, name),
    snapshotAt: asOf,
    structured: c,
    sources: [
      { sourceType: 'READ_MODEL', sourceRef: `people:${person.id}`, title: 'people', retrievedAt: asOf, text: `Cadastro de ${name}. Nota de completude ${c.nota}. Campos faltantes: ${c.camposFaltantes.join('; ') || 'nenhum'}.` },
      { sourceType: 'READ_MODEL', sourceRef: `people.documents:${person.id}`, title: 'people.documents', retrievedAt: asOf, text: `Documentos exigidos: ${c.documentos.map((d) => `${d.exigido} ${STATUS_TEXT[d.situacao] || 'ok'}`).join('; ')}. Pendentes do financiamento: ${c.documentosPendentesFinanciamento.join(', ') || 'nenhum'}.` },
    ],
  };
}

module.exports = { registrationQuality, classifyRegistration, documentStatus };
