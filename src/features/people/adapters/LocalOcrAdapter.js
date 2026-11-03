'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const AppError = require('../../../utils/AppError');

// LocalOcrAdapter — extração real, sem serviço externo pago: PDF com texto via pdftotext (poppler),
// imagem e PDF escaneado via Tesseract. Mesma interface do SandboxOcrAdapter:
//   extract(buffer, documentType) -> { fields, confidence (0..1), illegible, raw }
//
// Regras do caderno: só devolve campo que está no texto (nunca inventa), documento sem texto
// legível vira `illegible: true`, e a origem da extração fica em `raw` (motor, tipo de fonte,
// confiança média, tamanho do texto, campos encontrados).

const MIN_TEXT_LENGTH = 15;
const MIN_OCR_CONFIDENCE = 40;
const PDF_TEXT_CONFIDENCE = 0.95;
const COMMAND_TIMEOUT_MS = 60000;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = new Error(err.code === 'ENOENT' ? `${bin} não encontrado` : String(stderr || err.message));
        wrapped.code = err.code;
        reject(wrapped);
        return;
      }
      resolve(stdout);
    });
  });
}

function detectKind(buffer) {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image';
  if (buffer.length >= 4 && (buffer.subarray(0, 4).toString('latin1') === 'II*\0' || buffer.subarray(0, 4).toString('latin1') === 'MM\0*')) return 'image';
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('latin1') === 'BM') return 'image';
  return 'unknown';
}

function parseTesseractTsv(tsv) {
  const lines = String(tsv || '').split('\n').slice(1);
  const words = [];
  const confidences = [];
  let currentLine = null;
  const rows = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols.slice(11).join('\t').trim();
    if (!text || !Number.isFinite(conf) || conf < 0) continue;
    const lineKey = `${cols[2]}-${cols[3]}-${cols[4]}`;
    if (lineKey !== currentLine) {
      if (rows.length) words.push(rows.join(' '));
      rows.length = 0;
      currentLine = lineKey;
    }
    rows.push(text);
    confidences.push(conf);
  }
  if (rows.length) words.push(rows.join(' '));
  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { text: words.join('\n'), meanConfidence: mean, wordCount: confidences.length };
}

function toIsoDate(value) {
  const match = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return undefined;
  const [, dd, mm, yyyy] = match;
  const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(dd)) return undefined;
  return `${yyyy}-${mm}-${dd}`;
}

function parseMoney(value) {
  const normalized = String(value).replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

// Heurísticas determinísticas: só preenchem o que aparece no texto, com rótulo.
function extractFields(text) {
  const fields = {};
  const sources = {};
  const lines = text.split('\n');

  function set(field, value, evidence) {
    if (value === undefined || value === null || value === '' || fields[field] !== undefined) return;
    fields[field] = value;
    sources[field] = evidence;
  }

  for (const line of lines) {
    const cnpj = line.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/);
    const cpf = line.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
    if (cnpj) set('taxId', cnpj[0].replace(/\D/g, ''), line.trim());
    else if (cpf) set('taxId', cpf[0].replace(/\D/g, ''), line.trim());

    const name = line.match(/^\s*nome(?:\s+completo)?\s*[:-]\s*(\S.{2,80}?)\s*$/i);
    if (name) set('name', name[1], line.trim());

    const income = line.match(/(?:renda|rendimentos?|sal[aá]rio|l[ií]quido)[^\d\n]{0,40}R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i);
    if (income) set('income', parseMoney(income[1]), line.trim());

    const account = line.match(/(?:conta(?:\s+corrente)?|c\/c)[^\d\n]{0,15}(\d[\d.-]{3,14}\d)/i);
    if (account) set('accountNumber', account[1], line.trim());

    const issued = line.match(/emiss[aã]o[^\d\n]{0,15}(\d{2}\/\d{2}\/\d{4})/i);
    if (issued) set('issuedAt', toIsoDate(issued[1]), line.trim());

    const expires = line.match(/validade[^\d\n]{0,15}(\d{2}\/\d{2}\/\d{4})/i);
    if (expires) set('expiresAt', toIsoDate(expires[1]), line.trim());
  }
  return { fields, sources };
}

class LocalOcrAdapter {
  constructor(options = {}) {
    this.languages = options.languages || process.env.OCR_LANG || 'por';
    this.pdftotextBin = options.pdftotextBin || process.env.PDFTOTEXT_BIN || 'pdftotext';
    this.pdftoppmBin = options.pdftoppmBin || process.env.PDFTOPPM_BIN || 'pdftoppm';
    this.tesseractBin = options.tesseractBin || process.env.TESSERACT_BIN || 'tesseract';
  }

  async ocrImage(imagePath) {
    const tsv = await run(this.tesseractBin, [imagePath, 'stdout', '-l', this.languages, '--psm', '6', 'tsv']);
    return parseTesseractTsv(tsv);
  }

  async extractText(buffer, kind, dir) {
    if (kind === 'pdf') {
      const pdfPath = path.join(dir, 'doc.pdf');
      fs.writeFileSync(pdfPath, buffer);
      const direct = (await run(this.pdftotextBin, ['-layout', '-enc', 'UTF-8', pdfPath, '-'])).trim();
      if (direct.length >= MIN_TEXT_LENGTH) {
        return { text: direct, engine: 'pdftotext', source: 'pdf-text', meanConfidence: PDF_TEXT_CONFIDENCE * 100, wordCount: direct.split(/\s+/).length };
      }
      // PDF escaneado: rasteriza as primeiras páginas e passa pelo OCR.
      await run(this.pdftoppmBin, ['-r', '200', '-png', '-f', '1', '-l', '3', pdfPath, path.join(dir, 'page')]);
      const pages = fs.readdirSync(dir).filter((f) => /^page.*\.png$/.test(f)).sort();
      const parts = [];
      let confSum = 0;
      let wordTotal = 0;
      for (const page of pages) {
        const ocr = await this.ocrImage(path.join(dir, page));
        if (ocr.text) parts.push(ocr.text);
        confSum += ocr.meanConfidence * ocr.wordCount;
        wordTotal += ocr.wordCount;
      }
      return { text: parts.join('\n'), engine: 'tesseract', source: 'pdf-scan', meanConfidence: wordTotal ? confSum / wordTotal : 0, wordCount: wordTotal };
    }
    const imagePath = path.join(dir, 'image.bin');
    fs.writeFileSync(imagePath, buffer);
    const ocr = await this.ocrImage(imagePath);
    return { ...ocr, engine: 'tesseract', source: 'image' };
  }

  // eslint-disable-next-line no-unused-vars
  async extract(buffer, documentType) {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const kind = detectKind(input);
    if (kind === 'unknown') {
      return { fields: {}, confidence: 0, illegible: true, raw: { engine: 'local', reason: 'FORMATO_NAO_SUPORTADO', documentType } };
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-ocr-'));
    try {
      let result;
      try {
        result = await this.extractText(input, kind, dir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw AppError.internal('O motor de leitura de documentos não está instalado neste ambiente.', 'OCR_ENGINE_UNAVAILABLE');
        }
        // PDF corrompido ou imagem que o motor não consegue abrir: documento ilegível, não erro.
        return { fields: {}, confidence: 0, illegible: true, raw: { engine: 'local', reason: 'ARQUIVO_NAO_LEGIVEL', documentType } };
      }

      const text = String(result.text || '').trim();
      const confidence = Math.max(0, Math.min(1, result.meanConfidence / 100));
      const raw = {
        engine: result.engine,
        source: result.source,
        languages: this.languages,
        textLength: text.length,
        wordCount: result.wordCount,
        meanConfidence: Number(confidence.toFixed(3)),
        documentType,
      };

      if (text.length < MIN_TEXT_LENGTH || result.meanConfidence < MIN_OCR_CONFIDENCE) {
        return { fields: {}, confidence: Number(confidence.toFixed(3)), illegible: true, raw: { ...raw, reason: 'TEXTO_INSUFICIENTE' } };
      }

      const { fields, sources } = extractFields(text);
      return { fields, confidence: Number(confidence.toFixed(3)), illegible: false, raw: { ...raw, fieldSources: sources } };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { LocalOcrAdapter, detectKind, extractFields, parseTesseractTsv };
