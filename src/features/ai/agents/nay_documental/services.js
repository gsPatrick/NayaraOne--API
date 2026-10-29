'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { DOCUMENTAL_KEYS: K, DOCUMENTAL_SETTING_DEFAULTS: D } = require('./documental.settings');
const { openVerifiedFile } = require('./files');
const { readText, sha256 } = require('./transcribe');
const { classifyText } = require('./classify');
const { extractFields } = require('./extract');
const { checkConsistency } = require('./check');
const { recordSuggestion, TYPES } = require('./suggestion');

const iso = () => new Date().toISOString();
const SOURCE = 'people.files';

async function paramsOf(scope, transaction) {
  const tenant = { groupId: scope.groupId, companyId: scope.companyId };
  const read = (key) => getSetting(key, tenant, transaction, D[key]);
  const [minRaw, maxRaw, documentTypes, requiredFields] = await Promise.all([read(K.minConfidence), read(K.maxTranscriptChars), read(K.documentTypes), read(K.requiredFields)]);
  const min = Number(minRaw);
  const max = Number(maxRaw);
  return {
    minConfidence: Number.isFinite(min) && min >= 0 && min <= 1 ? min : D[K.minConfidence],
    maxChars: Number.isInteger(max) && max >= 200 ? max : D[K.maxTranscriptChars],
    documentTypes: String(documentTypes), requiredFields: String(requiredFields),
  };
}

/** Tipo do documento: o informado; senão o sugerido pelo texto quando o arquivo tem camada de texto; senão OTHER. */
async function resolveType(declared, opened, scope, params, transaction) {
  if (declared) return { documentType: String(declared).toUpperCase(), typeSource: 'DECLARED' };
  if (/^(image|audio)\//i.test(opened.file.mimeType || '')) return { documentType: 'OTHER', typeSource: 'UNKNOWN' };
  try {
    const { text } = await readText(opened, scope, transaction);
    const guess = classifyText(text, params.documentTypes, params.minConfidence);
    return guess.suggestedType === 'OTHER' ? { documentType: 'OTHER', typeSource: 'UNKNOWN' } : { documentType: guess.suggestedType, typeSource: 'SUGGESTED' };
  } catch (err) {
    return { documentType: 'OTHER', typeSource: 'UNKNOWN' };
  }
}

/** Serviço das ferramentas `documents.*` da NAY Documental. Só leitura e sugestão: a única linha criada é a recomendação PENDING. */
function documents(transaction, scope) {
  const proposed = async (fileId, declaredType, params) => {
    const opened = await openVerifiedFile(fileId, scope, transaction);
    const { documentType, typeSource } = await resolveType(declaredType, opened, scope, params, transaction);
    const extraction = await extractFields({ file: opened.file, buffer: opened.buffer, documentType, typeSource, minConfidence: params.minConfidence }, scope, transaction);
    return { opened, extraction };
  };

  return {
    /** Texto do arquivo verificado, cortado em `ia.documental.max_caracteres_transcricao`; o texto completo nunca sai daqui nem é gravado. */
    async transcribe(fileId) {
      const params = await paramsOf(scope, transaction);
      const opened = await openVerifiedFile(fileId, scope, transaction);
      const read = await readText(opened, scope, transaction);
      const text = read.text.slice(0, params.maxChars);
      return {
        fileId, fileName: opened.file.fileName, mimeType: opened.file.mimeType || '', source: SOURCE, scanStatus: 'CLEAN', method: read.method, provider: read.provider,
        totalChars: read.text.length, returnedChars: text.length, truncated: read.text.length > text.length, text, textSha256: sha256(read.text), persisted: false, asOf: iso(),
      };
    },

    async classifySuggest(fileId) {
      const params = await paramsOf(scope, transaction);
      const opened = await openVerifiedFile(fileId, scope, transaction);
      const { text } = await readText(opened, scope, transaction);
      const guess = classifyText(text, params.documentTypes, params.minConfidence);
      const recommendationId = guess.suggestedType === 'OTHER' ? null : await recordSuggestion(scope, {
        type: TYPES.classification, fileId, title: `Classificação sugerida: ${guess.suggestedType}`, confidence: guess.confidence,
        rationale: 'Sugestão da NAY Documental. Confira o documento e classifique pela tela do módulo; a NAY não grava a classificação.',
        payload: { fileId, suggestedType: guess.suggestedType, confidence: guess.confidence, evidence: guess.evidence },
      }, transaction);
      return { fileId, fileName: opened.file.fileName, ...guess, minConfidence: params.minConfidence, requiresHumanConfirmation: true, persisted: false, source: SOURCE, recommendationId, asOf: iso() };
    },

    async extractFields(fileId, documentType) {
      const params = await paramsOf(scope, transaction);
      const { extraction } = await proposed(fileId, documentType, params);
      const recommendationId = extraction.status === 'ILLEGIBLE' ? null : await recordSuggestion(scope, {
        type: TYPES.extraction, fileId, title: `Campos sugeridos para ${extraction.documentType}`, confidence: extraction.overallConfidence,
        rationale: 'Sugestão da NAY Documental. Os campos só valem depois que uma pessoa os confirmar; a NAY não grava no cadastro.',
        payload: { fileId, documentType: extraction.documentType, status: extraction.status, fields: extraction.fields },
      }, transaction);
      return { ...extraction, source: SOURCE, recommendationId, asOf: iso() };
    },

    async checkConsistency(fileId, documentType, expected) {
      const params = await paramsOf(scope, transaction);
      const { extraction } = await proposed(fileId, documentType, params);
      // O argumento da ferramenta chama o CPF/CNPJ esperado de `taxNumber` (nome com "Id" é reservado a identificador); o campo lido é `taxId`.
      const { taxNumber, ...rest } = expected || {};
      const result = checkConsistency(extraction, { requiredFieldsRaw: params.requiredFields, expected: { ...rest, ...(taxNumber !== undefined ? { taxId: taxNumber } : {}) } });
      return {
        fileId, documentType: extraction.documentType, typeSource: extraction.typeSource, status: extraction.status, overallConfidence: extraction.overallConfidence,
        ...result, checked: extraction.fields.map((f) => f.name), requiresHumanConfirmation: true, persisted: false, source: SOURCE, asOf: iso(),
      };
    },
  };
}

module.exports = { documents };
