'use strict';

// M9-D038 — a pergunta "o contrato já está válido?" não é recusada em seco: a NAY lista os requisitos satisfeitos e pendentes do contrato
// (a parte factual) e devolve a decisão ao responsável jurídico. Sem o contrato no pedido (`subject`), só a orientação.
const AppError = require('../../../../utils/AppError');
const { requirementsChecklist } = require('./juridica.data');
const { extractEntities } = require('../../orchestrator/numbers/textEntities');
const { FINAL_DECISION } = require('./juridica.policy');

const tag = (id) => String(id).replace(/-/g, '').slice(0, 8);

const PERMISSION = 'legal:read';
const DENIED = 'Você não tem permissão para consultar estes dados.';

/** Números do nome/código do contrato no texto livre viram itens do payload (a origem é o próprio contrato). */
const numbersOf = (text, prefix, asOf) => extractEntities(text).filter((e) => e.kind === 'n')
  .map((e, i) => ({ ref: `${prefix}_txt${i}`, label: 'Número citado no registro', value: String(e.key), unit: ['BRL', '%'].includes(e.unit) ? e.unit : 'un', source: 'legal.contracts', asOf }));

async function validityAnswer(ruleInput, { transaction }) {
  const subject = ruleInput.subject;
  if (!subject || subject.type !== 'legalContract' || !subject.id) return `${FINAL_DECISION} Informe o contrato para eu listar os requisitos satisfeitos e pendentes.`;
  if (!Array.isArray(ruleInput.permissions) || !ruleInput.permissions.includes(PERMISSION)) throw new AppError(DENIED, 403, 'AI_PERMISSION_DENIED', { permission: PERMISSION });
  const c = await requirementsChecklist(subject.id, transaction);
  const t = tag(subject.id);
  const item = (name, label, value) => ({ ref: `contrato_${t}_${name}`, label, value: String(value), unit: 'un', source: 'legal.contract_requirements', asOf: c.asOf });
  const label = c.contractNumber || subject.id;
  const requirementLine = (r) => `- ${r.code}: ${r.description || 'requisito do contrato'}`;
  const pend = c.items.filter((r) => r.status === 'PENDING');
  const sat = c.items.filter((r) => r.status === 'SATISFIED');
  const texts = [label, ...c.items.map((r) => `${r.code} ${r.description || ''}`)];
  return {
    answer: [
      `Não decido a validade do contrato ${label}, mas o checklist mostra {{num:contrato_${t}_req_satisfeitos}} requisito(s) satisfeito(s) e {{num:contrato_${t}_req_pendentes}} pendente(s).`,
      ...(sat.length ? ['Satisfeitos:', ...sat.map(requirementLine)] : []),
      ...(pend.length ? ['Pendentes:', ...pend.map(requirementLine)] : []),
      FINAL_DECISION,
    ].join('\n'),
    numbersPayload: [item('req_satisfeitos', 'Requisitos satisfeitos', c.satisfied), item('req_pendentes', 'Requisitos pendentes', c.pending), ...numbersOf(texts.join(' '), `contrato_${t}_nome`, c.asOf)],
    sources: [{ sourceType: 'READ_MODEL', sourceRef: `legal.contracts:${subject.id}`, title: `Requisitos do contrato ${label}`, retrievedAt: c.asOf, text: `${texts.join(' ')} satisfeitos ${c.satisfied} pendentes ${c.pending}` }],
    snapshotAt: c.asOf,
  };
}

module.exports = { validityAnswer };
