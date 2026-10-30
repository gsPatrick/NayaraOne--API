'use strict';

/** Constantes da quarentena de uploads externos (Marco 9, M9-D247). */
const STATUS = Object.freeze({
  QUARANTINED: 'QUARANTINED', CLEAN: 'CLEAN', INFECTED: 'INFECTED', REJECTED_TYPE: 'REJECTED_TYPE', REJECTED_SIZE: 'REJECTED_SIZE', REJECTED_BOMB: 'REJECTED_BOMB', EXPIRED: 'EXPIRED',
});
/** Sobrenome da chave de armazenamento: tudo sob company/<id>/quarantine/ é área de quarentena (sem leitura por usuário e sem URL assinada). */
const AREA = 'quarantine';
/** Classificação do arquivo promovido (livro: CONFIDENTIAL). */
const PROMOTED_CLASSIFICATION = 'CONFIDENTIAL';

module.exports = { STATUS, AREA, PROMOTED_CLASSIFICATION };
