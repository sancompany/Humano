/**
 * SAN & CO. — backend/routes/panteao.js
 * Adaptador HTTP entre o Panteão (frontend) e a Gemini + Supabase.
 *
 *   GET   /api/panteao/conversas          -> { conversas: [...] }  (metadado, sem mensagens)
 *   GET   /api/panteao/conversas/:id      -> conversa + mensagens
 *   POST  /api/panteao/conversas          { titulo?, modo?, agenteId? } -> conversa criada
 *   PATCH /api/panteao/conversas/:id      { titulo? , excluida? } -> { ok: true }
 *   POST  /api/panteao/miriel             { conversaId, texto } -> { texto }
 *
 * Só Miriel persiste e fala de verdade por enquanto — Lux e Nova
 * continuam simuladas no frontend até ganharem sua própria rota. Sem
 * orquestração entre as três aqui; essa é a próxima peça, não esta.
 */

import { Router } from 'express';
import { perguntarGemini } from '../services/geminiService.js';
import { declaracoesFerramentas, executarFerramenta } from '../services/ferramentasAgentes.js';
import { listarAcoesAgentes } from '../services/auditoriaAgentes.js';
import {
  listarConversas,
  obterConversaComMensagens,
  criarConversa,
  renomearConversa,
  arquivarConversa,
  adicionarMensagem,
  historicoParaGemini
} from '../services/panteaoRepo.js';

const rotas = Router();

const INSTRUCAO_MIRIEL =
  'Você é Miriel, uma das três conselheiras do SAN & CO., um painel executivo '
  + 'pessoal. Seu tom é sereno, direto e prático — você ajuda com rotina, '
  + 'compromissos e organização do dia a dia. Responda em português do Brasil, '
  + 'de forma breve e útil, sem se apresentar a cada mensagem.\n\n'
  + 'Você tem acesso real a ferramentas: pode consultar o Financeiro (só '
  + 'leitura, nunca altera nada ali), e pode ler e AGIR de verdade no '
  + 'Google Drive, Gmail e Agenda — inclusive mandar e-mail e criar '
  + 'compromisso, sem precisar pedir confirmação antes, sempre que o '
  + 'pedido deixar claro que é isso que precisa acontecer. Toda ação que '
  + 'você executa fica registrada para o usuário poder consultar depois — '
  + 'não é escondido dele, só não é uma pergunta cada vez.';

/* ------------------------------------------------------------------
   CONVERSAS
------------------------------------------------------------------ */

rotas.get('/conversas', async (_requisicao, resposta) => {
  try {
    const conversas = await listarConversas();
    resposta.json({ conversas });
  } catch (erro) {
    console.error('[panteão] GET /conversas', erro.message);
    resposta.status(500).json({ erro: erro.message });
  }
});

rotas.get('/conversas/:id', async (requisicao, resposta) => {
  try {
    const conversa = await obterConversaComMensagens(requisicao.params.id);
    resposta.json(conversa);
  } catch (erro) {
    console.error('[panteão] GET /conversas/:id', erro.message);
    resposta.status(404).json({ erro: erro.message });
  }
});

rotas.post('/conversas', async (requisicao, resposta) => {
  const { titulo, modo, agenteId } = requisicao.body ?? {};
  try {
    const conversa = await criarConversa({ titulo, modo, agenteId });
    resposta.status(201).json(conversa);
  } catch (erro) {
    console.error('[panteão] POST /conversas', erro.message);
    resposta.status(500).json({ erro: erro.message });
  }
});

rotas.patch('/conversas/:id', async (requisicao, resposta) => {
  const { titulo, excluida } = requisicao.body ?? {};
  try {
    if (titulo) await renomearConversa(requisicao.params.id, titulo);
    if (excluida) await arquivarConversa(requisicao.params.id);
    resposta.json({ ok: true });
  } catch (erro) {
    console.error('[panteão] PATCH /conversas/:id', erro.message);
    resposta.status(500).json({ erro: erro.message });
  }
});

/* ------------------------------------------------------------------
   MIRIEL
------------------------------------------------------------------ */

/**
 * Grava a pergunta, busca o histórico real da conversa (sem contar a
 * pergunta que acabou de ser gravada — ela vai como textoUsuario, não
 * duplicada dentro do histórico), pergunta pra Gemini já com contexto, e
 * grava a resposta. É a mesma correção de memória que já foi feita no
 * WhatsApp (ver routes/whatsapp.js) — antes, cada pergunta ao Panteão
 * também era isolada, sem lembrar da conversa.
 */
rotas.post('/miriel', async (requisicao, resposta) => {
  const { conversaId, texto } = requisicao.body ?? {};

  if (!texto || typeof texto !== 'string') {
    return resposta.status(400).json({ erro: 'Campo "texto" é obrigatório.' });
  }
  if (!conversaId) {
    return resposta.status(400).json({ erro: 'Campo "conversaId" é obrigatório.' });
  }

  try {
    await adicionarMensagem({ conversaId, autor: 'usuario', texto });

    const historico = await historicoParaGemini(conversaId);
    const historicoAnterior = historico.slice(0, -1);   // tira a pergunta de agora, já vai em textoUsuario

    const { texto: textoResposta, uso } = await perguntarGemini(texto, {
      instrucaoSistema: INSTRUCAO_MIRIEL,
      historico: historicoAnterior,
      ferramentas: declaracoesFerramentas,
      executarFerramenta: (nome, args) => executarFerramenta(nome, args, { agenteId: 'hermes' })
    });

    await adicionarMensagem({ conversaId, autor: 'hermes', agenteId: 'hermes', texto: textoResposta });

    resposta.json({ texto: textoResposta, uso });
  } catch (erro) {
    console.error('[panteão/miriel]', erro.message);
    resposta.status(502).json({ erro: 'Não foi possível obter resposta da Miriel agora.' });
  }
});

/* ------------------------------------------------------------------
   AUDITORIA — pra quando existir uma tela em Configuração (ou outro
   módulo) que liste as ações que os agentes já executaram de verdade.
------------------------------------------------------------------ */

/** GET /api/panteao/acoes?limite=50 */
rotas.get('/acoes', async (requisicao, resposta) => {
  const limite = Number(requisicao.query.limite) || 50;
  try {
    const acoes = await listarAcoesAgentes({ limite });
    resposta.json({ acoes });
  } catch (erro) {
    console.error('[panteão] GET /acoes', erro.message);
    resposta.status(500).json({ erro: erro.message });
  }
});

export default rotas;
