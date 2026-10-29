# regression

Regressão obrigatória ao trocar prompt, modelo ou provider da NAY (M9-D033).

- `globalHash.js`: `global_hash` calculado na hora (provedor e modelo padrão da empresa, versão do roteador, versão dos padrões de injeção). Nunca gravado na linha do agente; só as avaliações o guardam em `metrics`, junto do `config_hash` da versão.
- `regression.gate.js`: homologar e ativar exigem avaliação GOLDEN + ADVERSARIAL (ou ALL) PASSED para os dois hashes; trocar provider ou modelo do agente exige avaliação aprovada do novo par. Falha: 409 `AI_REGRESSION_REQUIRED`.
- `settingsGuard.js`: a troca do provedor ou do modelo padrão da empresa é recusada na gravação sem avaliação aprovada do novo par.
- Mudança do `global_hash` não altera o estado de nenhuma versão: versão ACTIVE continua ACTIVE (D004).
- O golden dataset (`ai.golden_cases`) vive em `../evaluations/golden`.
