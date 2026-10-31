'use strict';

const { RESOURCES } = require('../share/share.catalog');

/**
 * Recursos imprimíveis (M9-D920 §3.1): os mesmos do catálogo de recursos compartilháveis da M9-D823 (contrato e laudo de vistoria), que já sabem conferir que o registro existe
 * (`assertShareable`), ler o dado (`load`), qual permissão do módulo de origem exigem (`permission`) e a classe de cada campo (`fields`). Arquivo avulso não se "imprime": baixa-se
 * pelo DLP de anexos, que entrega o PDF com a marca d'água.
 */
const PRINTABLE = Object.freeze(RESOURCES.filter((resource) => resource.code !== 'files.file'));
const getPrintable = (code) => PRINTABLE.find((resource) => resource.code === code) || null;
const listPrintable = () => PRINTABLE.map(({ code, label, permission }) => ({ code, label, permission }));

module.exports = { PRINTABLE, getPrintable, listPrintable };
