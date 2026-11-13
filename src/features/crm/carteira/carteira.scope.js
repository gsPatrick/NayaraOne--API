'use strict';

const { Op, literal } = require('sequelize');
const { sequelize, Visit, Message, Proposal, PropertyRadar, Cart, FeedbackCase, Task, Opportunity } = require('../../../models');
const { resolveOpportunityOwnerScope } = require('../opportunityScope.guard');
const { MODES, readSemOportunidadeMode } = require('./carteira.settings');

/**
 * Carteira do corretor em TODO registro do CRM (livro do Marco 3 §18 "Corretor visualizar carteira alheia — Escopo conforme política
 * de equipe"; CRM-TS-012 "Corretor A lê B — Bloqueado"). Quem tem `crm:opportunities:read:own` sem `:all` (escopo OWN) só alcança:
 *   1. registro ligado a oportunidade cujo responsável é ele;
 *   2. registro em que ele é o designado (visita: corretor da visita; ocorrência e tarefa: responsável);
 *   3. registro SEM oportunidade que ele mesmo criou (ou de que é o autor) e, no modo CLIENTE_DA_CARTEIRA (parâmetro
 *      `crm.carteira.registro_sem_oportunidade`), também o da pessoa que tem oportunidade na carteira dele.
 * Registro ligado a oportunidade de outro responsável nunca entra pelo item 3. Gestor (`:all`) e papel antigo (sem as duas) veem tudo.
 */
const KINDS = Object.freeze({
  visit: { model: Visit, opportunity: 'opportunityId', person: 'personId', designated: ['agentUserId'], authors: ['createdBy'], notFound: ['Visita não encontrada.', 'VISIT_NOT_FOUND'] },
  message: { model: Message, opportunity: 'opportunityId', person: 'personId', designated: [], authors: ['authorUserId', 'createdBy'], notFound: ['Mensagem não encontrada.', 'MESSAGE_NOT_FOUND'] },
  proposal: { model: Proposal, opportunity: 'opportunityId', person: null, designated: [], authors: [], notFound: ['Proposta não encontrada.', 'PROPOSAL_NOT_FOUND'] },
  radar: { model: PropertyRadar, opportunity: 'opportunityId', person: 'personId', designated: [], authors: ['createdBy'], notFound: ['Radar não encontrado.', 'RADAR_NOT_FOUND'] },
  cart: { model: Cart, opportunity: 'opportunityId', person: null, designated: [], authors: [], notFound: ['Carrinho não encontrado.', 'CART_NOT_FOUND'] },
  feedback: { model: FeedbackCase, opportunity: 'opportunityId', person: 'personId', designated: ['assignedToUserId'], authors: ['createdBy'], notFound: ['Caso de feedback não encontrado.', 'FEEDBACK_CASE_NOT_FOUND'] },
  task: {
    model: Task, opportunity: 'relatedEntityId', opportunityType: ['relatedEntityType', 'crm.opportunities'], person: null, designated: ['assignedToUserId'], authors: ['createdBy'],
    notFound: ['Tarefa não encontrada.', 'OPPORTUNITY_TASK_NOT_FOUND'],
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/** Escopo da requisição: null para gestor/papel antigo (sem filtro); { userId, mode } para o corretor de escopo próprio. */
async function carteiraOf(auth, transaction) {
  const scope = resolveOpportunityOwnerScope(auth);
  if (scope.mode !== 'OWN') return null;
  if (!isUuid(scope.userId)) return { userId: null, mode: MODES.PROPRIOS };
  return { userId: scope.userId, mode: await readSemOportunidadeMode({ groupId: auth.groupId, companyId: auth.companyId }, transaction) };
}

const ownedOpportunities = (userId) => literal(`(SELECT o.id FROM crm.opportunities o WHERE o.owner_user_id = ${sequelize.escape(userId)} AND o.deleted_at IS NULL)`);
const carteiraPersons = (userId) => literal(`(SELECT o.person_id FROM crm.opportunities o WHERE o.owner_user_id = ${sequelize.escape(userId)} AND o.deleted_at IS NULL AND o.person_id IS NOT NULL)`);

/** Condição Sequelize do que o corretor alcança neste tipo de registro (para somar ao `where` da listagem ou da busca por id). */
function scopeWhere(kind, carteira) {
  const spec = KINDS[kind];
  if (!carteira) return {};
  if (!carteira.userId) return { id: null }; // escopo próprio sem usuário identificado: nada
  const { userId, mode } = carteira;
  const [typeField, typeValue] = spec.opportunityType || [];
  const linkedToOwn = { ...(typeField ? { [typeField]: typeValue } : {}), [spec.opportunity]: { [Op.in]: ownedOpportunities(userId) } };
  const notLinked = typeField ? { [Op.or]: [{ [spec.opportunity]: null }, { [typeField]: { [Op.ne]: typeValue } }] } : { [spec.opportunity]: null };
  const withoutOpportunity = spec.authors.map((field) => ({ [field]: userId }));
  if (spec.person && mode === MODES.CLIENTE) withoutOpportunity.push({ [spec.person]: { [Op.in]: carteiraPersons(userId) } });
  const options = [linkedToOwn, ...spec.designated.map((field) => ({ [field]: userId }))];
  if (withoutOpportunity.length) options.push({ [Op.and]: [notLinked, { [Op.or]: withoutOpportunity }] });
  return { [Op.or]: options };
}

/** `where` de listagem com o escopo somado (sem escopo, o próprio `where`). */
function withScope(where, kind, carteira) {
  return carteira ? { [Op.and]: [where || {}, scopeWhere(kind, carteira)] } : where || {};
}

/**
 * O registro `id` está fora da carteira? true só quando ele existe nesta empresa e o corretor não o alcança (quem chama responde o
 * mesmo 404 do "não existe", sem revelar a existência). Id que não é UUID nem registro inexistente ficam com o handler.
 */
async function isOutOfScope(kind, id, carteira, transaction) {
  if (!carteira || !isUuid(id)) return false;
  const { model, opportunityType } = KINDS[kind];
  // Tarefa: só a da oportunidade do CRM entra na regra (tarefa de outro módulo segue a regra do módulo dela).
  const exists = await model.count({ where: { id, ...(opportunityType ? { [opportunityType[0]]: opportunityType[1] } : {}) }, transaction });
  if (!exists) return false;
  const reachable = await model.count({ where: { [Op.and]: [{ id }, scopeWhere(kind, carteira)] }, transaction });
  return reachable === 0;
}

/** A oportunidade `opportunityId` (do corpo de uma criação) está fora da carteira? */
async function isOpportunityOutOfScope(opportunityId, carteira, transaction) {
  if (!carteira || !isUuid(opportunityId)) return false;
  const opportunity = await Opportunity.findByPk(opportunityId, { attributes: ['id', 'ownerUserId'], transaction });
  return Boolean(opportunity) && opportunity.ownerUserId !== carteira.userId;
}

module.exports = { KINDS, carteiraOf, scopeWhere, withScope, isOutOfScope, isOpportunityOutOfScope, isUuid };
