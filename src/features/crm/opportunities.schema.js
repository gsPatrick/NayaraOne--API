'use strict';

const { Opportunity } = require('../../models');
const V = require('../../shared/validation/requestSchema');

/**
 * Tipo e tamanho dos campos de texto e de identificador de `POST /opportunities`, conferidos na porta (verificação independente do Marco 9,
 * rodada 7, 12/11/2026; DI-M9R-21). Antes, `personId` com um objeto, uma lista ou um número dava 500 (`Argument passed to findByPk is invalid`,
 * `operator does not exist: uuid = integer`) e `nextActionDueAt` inválido dava 500 (`Invalid date`). Esquema ABERTO; limites de texto do modelo.
 * As regras de negócio (pessoa obrigatória, próxima ação em estágio ativo, motivo do desfecho) continuam no serviço, com as mesmas mensagens.
 */
const CRIAR = V.objetoAberto({
  personId: V.identificador(),
  propertyId: V.identificador(),
  ownerUserId: V.identificador(),
  stage: V.textoDoModelo(Opportunity, 'stage'),
  temperature: V.textoDoModelo(Opportunity, 'temperature'),
  expectedValue: V.numeroOuTexto(),
  nextAction: V.textoDoModelo(Opportunity, 'nextAction'),
  nextActionDueAt: V.dataEmTexto(),
  wonReason: V.textoDoModelo(Opportunity, 'wonReason'),
  lostReason: V.textoDoModelo(Opportunity, 'lostReason'),
  withdrawnReason: V.textoDoModelo(Opportunity, 'withdrawnReason'),
  leadSource: V.texto(40),
  campaignId: V.identificador(),
  trackingLinkId: V.identificador(),
  clickAt: V.dataEmTexto(),
});

module.exports = { validarCriacaoDeOportunidade: V.validarEntrada({ body: CRIAR }, 'OPPORTUNITY_VALIDATION'), ESQUEMAS: { CRIAR } };
