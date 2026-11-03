'use strict';

// AntivirusAdapter — item 2 do ciclo de auditoria externa Marco 3. Contrato bruto:
//   "5. Cadastro por documento e IA — Upload -> antivírus -> hash -> classificação -> OCR/IA
//    -> dados sugeridos." (Guia do Marcelo §5)
//   "Documentos/OCR — Upload → malware scan → hash → OCR/IA → sugestão → validação."
//     (caderno físico, linha ~9562)
//
// Mesmo padrão duck-typed de BankAdapter.js/InsuranceAdapter.js/SignatureAdapter.js: interface
// comum, resolvida por resolveAntivirusAdapter.js com fallback seguro para o Sandbox quando não
// há provedor real configurado (ausência de configuração NUNCA quebra o fluxo nem,
// pior, finge "limpo" por omissão — ver SandboxAntivirusAdapter.scan abaixo, que detecta pelo
// padrão público EICAR em vez de aprovar tudo sem checagem nenhuma).
//
//   async scan(buffer) -> { clean: boolean, signature: string|null, raw: object }

// Assinatura de teste padrão da indústria antivírus (EICAR, domínio público) — usada aqui como
// o único "malware" que o Sandbox de fato detecta, para que testes automatizados consigam
// exercitar o caminho de quarentena sem depender de um provedor real nem de um binário malicioso
// de verdade.
const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

class SandboxAntivirusAdapter {
  // eslint-disable-next-line class-methods-use-this
  async scan(buffer) {
    const asText = Buffer.isBuffer(buffer) ? buffer.toString('utf8', 0, Math.min(buffer.length, 4096)) : '';
    const infected = asText.includes(EICAR_SIGNATURE);
    return {
      clean: !infected,
      signature: infected ? 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE' : null,
      raw: { sandbox: true },
    };
  }
}

module.exports = { SandboxAntivirusAdapter, EICAR_SIGNATURE };
