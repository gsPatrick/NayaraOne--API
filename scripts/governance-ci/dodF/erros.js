'use strict';

/** Erros do fechamento do bloco F (M9-D940). LeituraError = não foi possível verificar o item (exit 2, GOV_DOD_F_INVALID); nunca vira "ok". */
class LeituraError extends Error {}

const CODIGO_ITEM = 'GOV_DOD_F_ITEM_FAILED';
const CODIGO_INVALIDO = 'GOV_DOD_F_INVALID';
const mensagemItem = (nome) => `O item ${nome} do fechamento do bloco F não está verde.`;
const MENSAGEM_INVALIDO = 'Não foi possível verificar o fechamento do bloco F.';

module.exports = { LeituraError, CODIGO_ITEM, CODIGO_INVALIDO, mensagemItem, MENSAGEM_INVALIDO };
