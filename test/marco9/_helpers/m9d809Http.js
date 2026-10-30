'use strict';

// Apoio dos testes M9-D809 (não é teste): sobe a API real no banco descartável com os atores A (gestor) e B (gestor da outra empresa) e confere uma resposta real contra o
// contrato OpenAPI versionado (o mesmo verificador do contract test da M9-D842). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const path = require('node:path');
const { startHttp, stopHttp } = require('./m9d806Http');
const { loadContract, listOperations, checkResponse, catalogCodes } = require('../../../src/features/core-governance/api-governance/contract');

const CONTRATO = path.join(__dirname, '..', '..', '..', 'openapi', 'openapi.v1.yaml');

/** { http, skip } — A (gestor) e B (gestor da outra empresa) logados. */
async function iniciar(port) {
  const http = await startHttp({ port, grants: {}, logins: { gestor: ['A', 'gestor'], gestorB: ['B', 'gestor'] } });
  return { http, skip: http.skip };
}

const encerrar = () => stopHttp({});

/** Operação do contrato por "MÉTODO /caminho do contrato" (null se não documentada). */
function operacaoDoContrato(chave) {
  const doc = loadContract(CONTRATO);
  const op = listOperations(doc).find((item) => item.key === chave) || null;
  return { doc, op };
}

/** Achados da resposta real (resultado de http.call) contra a operação do contrato; lista vazia = a resposta obedece ao contrato. */
function conferirNoContrato(chave, res) {
  const { doc, op } = operacaoDoContrato(chave);
  if (!op) return [`${chave} não consta no contrato`];
  const headers = {};
  res.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  const findings = checkResponse({
    method: op.method, path: op.path, operation: op.operation, components: doc.components, codes: catalogCodes(),
    actual: { status: res.status, headers, contentType: headers['content-type'] || '', json: res.body, text: JSON.stringify(res.body) },
  });
  return findings.map((f) => `${f.code}: ${JSON.stringify(f.details || f.message)}`);
}

module.exports = { iniciar, encerrar, operacaoDoContrato, conferirNoContrato, CONTRATO };
