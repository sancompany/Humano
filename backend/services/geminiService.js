/**
 * SAN & CO. — backend/services/geminiService.js
 * Único arquivo do backend que fala com a API da Gemini. `GEMINI_API_KEY`
 * nunca sai daqui — nem para os outros arquivos do backend, nem (óbvio)
 * para o frontend.
 *
 * Usa `fetch` direto na API REST da Gemini, em vez do SDK oficial
 * (`@google/generative-ai`) — menos dependência instalada, e Node 18+ já
 * tem fetch nativo. Se preferir o SDK mais adiante, é trocar só este
 * arquivo; nada em panteao.js ou nas rotas precisa saber a diferença.
 *
 * MODELO CONFIGURÁVEL DE PROPÓSITO
 *   Meu conhecimento sobre qual é o nome exato do modelo Gemini "atual"
 *   pode estar desatualizado — a Google troca esses nomes com frequência,
 *   e não tenho como confirmar em tempo real daqui. Por isso o nome do
 *   modelo vem do .env (GEMINI_MODEL), não fixo no código: confira o nome
 *   certo em https://ai.google.dev/gemini-api/docs/models antes de rodar,
 *   e troque no .env se o que está aqui não existir mais.
 *
 * FUNCTION CALLING — AVISO DE INCERTEZA REAL (29/08/2026)
 *   O bloco de `ferramentas`/`executarFerramenta` abaixo é a PRIMEIRA vez
 *   que este projeto usa function calling da Gemini. Montei o formato do
 *   `tools`/`functionCall`/`functionResponse` com o que sei do protocolo,
 *   mas não tenho como testar isso ao vivo daqui (sem acesso à internet
 *   no ambiente onde escrevo). Se a primeira chamada com ferramentas
 *   falhar com um erro de formato inválido, o texto do erro da própria
 *   Gemini (capturado abaixo) deve dizer exatamente o que ela esperava —
 *   me manda esse texto que eu ajusto o formato certo.
 */

const MODELO_PADRAO = 'gemini-2.0-flash';

/** Trava de segurança: nº máximo de idas-e-voltas de ferramenta numa
 *  única pergunta, pra nunca entrar num loop (a Gemini pedindo função
 *  atrás de função sem nunca chegar numa resposta final). */
const MAX_RODADAS_FERRAMENTA = 5;

/**
 * @param {string} textoUsuario
 * @param {{
 *   instrucaoSistema?: string,
 *   historico?: Array<{autor: 'usuario'|'agente', texto: string}>,
 *   ferramentas?: Array<object>,
 *   executarFerramenta?: (nome: string, args: object) => Promise<object>
 * }} opcoes
 *   historico é opcional e vem em ordem cronológica (mais antiga
 *   primeiro) — sem ele, cada chamada continua sendo uma pergunta
 *   isolada, exatamente como já era.
 *   ferramentas/executarFerramenta são opcionais — sem eles, o
 *   comportamento é idêntico ao de sempre (nenhuma ferramenta oferecida
 *   à Gemini). Só quem passar os dois (Miriel, por enquanto) ganha a
 *   capacidade de chamar função de verdade.
 * @returns {Promise<{ texto: string, uso: { promptTokenCount: number, candidatesTokenCount: number, totalTokenCount: number }|null }>}
 */
export async function perguntarGemini(textoUsuario, {
  instrucaoSistema, historico = [], ferramentas = null, executarFerramenta = null
} = {}) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) {
    throw new Error('GEMINI_API_KEY não configurada no .env do backend.');
  }

  const modelo = process.env.GEMINI_MODEL || MODELO_PADRAO;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${chave}`;

  const contents = [
    ...historico.map((turno) => ({
      role: turno.autor === 'usuario' ? 'user' : 'model',
      parts: [{ text: turno.texto }]
    })),
    { role: 'user', parts: [{ text: textoUsuario }] }
  ];

  const corpoFixo = {
    ...(instrucaoSistema ? { systemInstruction: { parts: [{ text: instrucaoSistema }] } } : {}),
    ...(ferramentas?.length ? { tools: [{ functionDeclarations: ferramentas }] } : {})
  };

  const usoAcumulado = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, ...corpoFixo })
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(`Gemini respondeu ${resposta.status}: ${detalhe.slice(0, 500)}`);
    }

    const dados = await resposta.json();

    if (dados.usageMetadata) {
      usoAcumulado.promptTokenCount += dados.usageMetadata.promptTokenCount ?? 0;
      usoAcumulado.candidatesTokenCount += dados.usageMetadata.candidatesTokenCount ?? 0;
      usoAcumulado.totalTokenCount += dados.usageMetadata.totalTokenCount ?? 0;
    }

    const partes = dados.candidates?.[0]?.content?.parts ?? [];
    const chamada = partes.find((p) => p.functionCall)?.functionCall;

    if (!chamada) {
      const texto = partes.find((p) => p.text)?.text;
      if (!texto) {
        // a Gemini pode bloquear por segurança (finishReason: 'SAFETY') sem
        // devolver erro HTTP — isso chega aqui como resposta "ok" mas vazia
        const motivo = dados.candidates?.[0]?.finishReason;
        throw new Error(`Gemini não devolveu texto${motivo ? ` (finishReason: ${motivo})` : ''}.`);
      }
      return { texto, uso: usoAcumulado.totalTokenCount ? usoAcumulado : null };
    }

    // a Gemini pediu pra chamar uma função — sem executor, não tem como continuar
    if (!executarFerramenta) {
      throw new Error(
        `Gemini pediu a ferramenta "${chamada.name}" mas nenhum executor foi passado — `
        + 'quem chamou perguntarGemini() precisa fornecer executarFerramenta.'
      );
    }

    contents.push({ role: 'model', parts: [{ functionCall: chamada }] });

    let resultado;
    try {
      resultado = await executarFerramenta(chamada.name, chamada.args ?? {});
    } catch (erro) {
      // erro na ferramenta não derruba a conversa — a Gemini recebe o
      // erro como resultado e decide o que dizer (ex.: "não consegui
      // criar o evento porque X"), em vez do usuário ver um 502 seco
      resultado = { erro: erro.message };
    }

    contents.push({
      role: 'function',
      parts: [{ functionResponse: { name: chamada.name, response: resultado } }]
    });
  }

  throw new Error(
    `Miriel encadeou mais de ${MAX_RODADAS_FERRAMENTA} chamadas de ferramenta numa resposta só — `
    + 'travei por segurança (provável loop). Confira os logs pra ver o que ela estava tentando fazer.'
  );
}
