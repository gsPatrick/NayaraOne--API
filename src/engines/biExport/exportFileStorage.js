'use strict';

/**
 * Marco 9, M9-D701 — porta do BI para o armazenamento de arquivos do projeto (antivírus, cifra em repouso, checksum, auditoria). O BI é somente leitura e não importa
 * serviço de outro módulo (lint BI-001): este adaptador, fora de src/features, é o único ponto por onde a exportação grava e lê o arquivo gerado.
 */
const { uploadFile, getFileContent } = require('../../features/files/files.service');

module.exports = { uploadFile, getFileContent };
