'use strict';

const { User } = require('../../models');
const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /auth/login` (rota pública), conferidos na porta (verificação independente do Marco 9, rodada 7, 12/11/2026;
 * DI-M9R-21). Antes, `email` com um objeto, uma lista ou um número dava 500 (`email.toLowerCase is not a function`). O e-mail segue o tamanho da
 * coluna; a senha, até 4.096 caracteres (o cadastro só exige o mínimo de 8; o bcrypt usa os primeiros 72 bytes). Esquema ABERTO. Campo ausente
 * continua com a mensagem de sempre do serviço ("E-mail e senha são obrigatórios.").
 */
const LOGIN = V.objetoAberto({
  email: V.textoDoModelo(User, 'email'),
  password: V.texto(4096),
  companyId: V.identificador(),
});

module.exports = { validarLogin: V.validarEntrada({ body: LOGIN }, 'AUTH_VALIDATION'), ESQUEMAS: { LOGIN } };
