'use strict';

const { Person, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { assertUuid } = require('../../utils/inputGuards');

// Fechamento M5 (pentest): pessoa, arquivo e textos conferidos na empresa e no tamanho da coluna antes de gravar.
async function assertCompanyPerson(personId, field, code, transaction) {
  if (!assertUuid(personId, field, code, { optional: true })) return;
  if (!(await Person.findByPk(personId, { attributes: ['id'], transaction }))) throw AppError.badRequest(`A pessoa informada em "${field}" não existe nesta empresa.`, code);
}
async function assertCompanyFile(fileId, companyId, field, code, transaction) {
  if (!assertUuid(fileId, field, code, { optional: true })) return;
  if (!(await File.findOne({ where: { id: fileId, companyId }, attributes: ['id'], transaction }))) throw AppError.badRequest(`O arquivo informado em "${field}" não existe nesta empresa.`, code);
}

module.exports = { assertCompanyPerson, assertCompanyFile };
