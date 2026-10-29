'use strict';

// Apoio dos testes de vigência e conflito do RAG (M9-D024): cenário do orquestrador com busca no índice e o relógio real (a busca usa a
// hora de agora), sementes com vigência relativa a agora e leitura do registro de fontes do run.

const { semear } = require('./ragSeed');
const H = require('./iaOrquestrador');

const DIA = 24 * 3600 * 1000;
const RAG = { dataScopes: ['knowledge.politicas', 'files.contratos', 'urls.publicas'] };
const depoisDe = (dias) => new Date(Date.now() + dias * DIA);
const resposta = (texto) => `[[RESPOSTA:${texto}]]`;

/** Semente de um trecho de URL (passa pela dupla checagem sem origem em arquivo ou conhecimento). */
const trecho = (tenant, tx, texto, extra = {}) => semear(tenant, tx, { texto, sourceType: 'URL', ...extra });

/** Linhas de ai.ai_sources do run, na forma curta usada nas asserções. */
async function registro(runId, tx) {
  return (await H.fontes(runId, tx)).map((f) => ({ ref: f.source_ref, versao: f.source_version, usada: f.used_in_answer, estado: f.status_at_retrieval }));
}

module.exports = { RAG, DIA, depoisDe, resposta, trecho, registro, H };
