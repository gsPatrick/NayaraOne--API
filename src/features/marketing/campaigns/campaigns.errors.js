'use strict';

const { mktError } = require('../marketing.errors');
const { ITEM_LABELS } = require('./campaigns.constants');

/** Erros da campanha (M9-D412). Mensagens em português; o detalhe técnico fica em details. */
const campaignNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Campanha não encontrada.');
const invalidTransition = (from, to) => mktError(409, 'MKT_CAMPAIGN_INVALID_TRANSITION', `Transição de campanha inválida: ${from} -> ${to}.`, { from, to });
const campaignFinal = () => mktError(409, 'MKT_CAMPAIGN_FINAL', 'Campanha encerrada não pode ser alterada.');
const campaignNotEditable = (status) => mktError(409, 'MKT_CAMPAIGN_NOT_EDITABLE',
  'Só campanha em rascunho pode ser alterada; para parar use o kill switch por campanha.', { status });
const campaignIncomplete = (items) => mktError(422, 'MKT_CAMPAIGN_INCOMPLETE',
  `Faltam itens obrigatórios: ${items.map((i) => ITEM_LABELS[i] || i).join(', ')}.`, { items });
const crossCompany = (details) => mktError(422, 'MKT_AUDIENCE_CROSS_COMPANY', 'A audiência contém pessoas de outra empresa.', details);
const validation = (message, details) => mktError(400, 'MKT_CAMPAIGN_VALIDATION', message, details);
const codeDuplicate = (code) => mktError(409, 'MKT_CAMPAIGN_CODE_DUPLICATE', 'Já existe uma campanha com este código.', { code });
const stepInvalid = (message, details) => mktError(422, 'MKT_CAMPAIGN_STEP_INVALID', message, details);
const ownerInvalid = () => mktError(422, 'MKT_CAMPAIGN_OWNER_INVALID', 'O responsável precisa ser um usuário ativo desta empresa.');
const notRunning = (status) => mktError(409, 'MKT_CAMPAIGN_NOT_RUNNING', 'Só campanha em andamento pode ter entregas reprocessadas.', { status });
const sendUnavailable = () => mktError(503, 'MKT_CAMPAIGN_SEND_UNAVAILABLE', 'O envio das campanhas não está ligado neste servidor; nada foi reprocessado.');

module.exports = {
  campaignNotFound, invalidTransition, campaignFinal, campaignNotEditable, campaignIncomplete, crossCompany, validation, codeDuplicate, stepInvalid, ownerInvalid, notRunning, sendUnavailable,
};
