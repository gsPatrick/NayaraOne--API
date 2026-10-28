'use strict';

/** Objeto simples e serializável (datas em ISO, sem instância de modelo) a partir do que o serviço de aplicação devolveu. */
const toPlain = (valor) => (valor === undefined || valor === null ? valor : JSON.parse(JSON.stringify(valor)));

module.exports = { toPlain };
