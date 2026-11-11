'use strict';

const AppError = require('../../utils/AppError');
const { SandboxAntivirusAdapter } = require('./adapters/AntivirusAdapter');
const { SandboxOcrAdapter } = require('./adapters/OcrAdapter');
const { ClamAvAdapter } = require('./adapters/ClamAvAdapter');
const { LocalOcrAdapter } = require('./adapters/LocalOcrAdapter');

/**
 * Motores do cadastro por documento de PESSOA (CAD-05, DI-M3PE-6). O livro manda passar por antivírus e por leitura (§5); o motor de
 * laboratório não é antivírus (só reconhece o arquivo de teste EICAR) nem leitura de verdade (lê um JSON de simulação), então ele só vale:
 *   - no ambiente de teste (NODE_ENV=test), ou
 *   - quando o administrador liga `people.documentos.motores_laboratorio` (decisão consciente, que fica na auditoria do parâmetro).
 * Fora disso:
 *   - sem antivírus real (ANTIVIRUS_PROVIDER=clamav) o envio é RECUSADO (503 DOCUMENT_ANTIVIRUS_UNAVAILABLE): nenhum arquivo entra sem varredura;
 *   - sem leitura real (OCR_PROVIDER=local) o documento entra SEM dado lido e com pendência de revisão ("leitura automática indisponível").
 * A ativação dos motores reais no servidor está em docs/runbooks/ATIVACAO_OCR_ANTIVIRUS.md.
 */
const isTestEnv = () => process.env.NODE_ENV === 'test';
const realAntivirus = () => String(process.env.ANTIVIRUS_PROVIDER || '').toLowerCase() === 'clamav';
const realReader = () => String(process.env.OCR_PROVIDER || '').toLowerCase() === 'local';

/** { antivirus, leitor (ou null), motores: { antivirus: CLAMAV|LABORATORIO, leitura: LOCAL|LABORATORIO|INDISPONIVEL } } */
function resolvePersonDocumentEngines(params) {
  const lab = isTestEnv() || params.motoresLaboratorio === true;
  if (!realAntivirus() && !lab) {
    throw new AppError(
      'O antivírus não está ligado neste servidor, e nenhum documento entra sem passar por ele. Peça a ativação do antivírus a quem administra o sistema.',
      503, 'DOCUMENT_ANTIVIRUS_UNAVAILABLE'
    );
  }
  const antivirus = realAntivirus() ? new ClamAvAdapter() : new SandboxAntivirusAdapter();
  const leitor = realReader() ? new LocalOcrAdapter() : lab ? new SandboxOcrAdapter() : null;
  return {
    antivirus,
    leitor,
    motores: { antivirus: realAntivirus() ? 'CLAMAV' : 'LABORATORIO', leitura: realReader() ? 'LOCAL' : leitor ? 'LABORATORIO' : 'INDISPONIVEL' },
  };
}

/** Leitura que não aconteceu porque não há motor: sem campo nenhum, com o motivo para a pendência. */
const READING_UNAVAILABLE = Object.freeze({ fields: {}, confidence: 0, illegible: false, unavailable: true, raw: { unavailable: true, reason: 'LEITURA_INDISPONIVEL' } });

module.exports = { resolvePersonDocumentEngines, READING_UNAVAILABLE };
