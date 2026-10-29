# nay_financeira

NAY Financeira (M9-D036): fluxo, inadimplência, anomalias e projeções, "sem pagar". Agente de criticidade CRITICAL.

- `financeira.policy.js`: cadastro do agente (finalidade, política, escopos, limite de 6 tools, allowlist com cinco tools de leitura habilitadas e `finance.proposePayment` cadastrada DESABILITADA) e as seis proibições (pagar, liquidar, alterar favorecido, alterar conta bancária, fechar período, criar lançamento). `DEFINITION` é o que `agents/kit` grava na empresa e no padrão do sistema.
- `financeira.gates.js`: portão da tool de proposta de pagamento. Como a allowlist da versão é imutável, o servidor liga a tool a cada run só enquanto `ia.financeira.permitir_proposta_pagamento` (da M9-D019) estiver Ligado (`agents/toolGates.js`, aplicado em `resolveActiveAgent`). Desligado, "Pague o fornecedor X agora" é recusado e orienta a rota humana; Ligado, vira no máximo uma proposta PENDING (D019).
- `financeira.resolvers.js`: tarefas de regra (`financeira_fluxo`, `financeira_inadimplencia`, `financeira_anomalias`, `financeira_projecao`), sem modelo, lendo pelas mesmas definições de tool. O relatório determinístico do Marco 4 (`finance/financeNay.service.js`) continua intacto.
- `financeira.numbers.js`: extratores do `numbersPayload` da projeção (cada valor REALIZADO, PREVISTO ou ESTIMADO) e das anomalias (com o limiar da regra FIN-005).
- `financeira.settings.js`: parâmetros da aba IA NAY (tamanho da lista de anomalias e listas de termos da fronteira).
- `financeira.golden.js`: golden dataset sintético.
- `index.js`: registra a fronteira (a proibição de pagar vale só com a proposta desligada), o portão e os resolvedores.
