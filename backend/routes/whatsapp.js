/**
 * SAN & CO. — backend/routes/whatsapp.js
 * Recebe os eventos que a Evolution API manda por webhook e responde as
 * mensagens de texto simples através da Gemini (Miriel).
 *
 * SEM separação cliente/pessoal por AGENTE ainda — decisão explícita:
 * toda mensagem cai na Miriel (Gemini), não existe uma segunda instância
 * (Lux) respondendo ainda. O que já existe é o reconhecimento de QUEM
 * está falando (dono vs. resto), via services/identidade.js — o prompt
 * muda de registro consoante isso, mesmo sendo sempre a Miriel quem
 * responde por enquanto. O roteamento por AGENTE (decidido, ainda não
 * construído):
 *   - mensagem de CLIENTE  -> Miriel (Gemini) — já é o que acontece hoje
 *   - mensagem do PESSOAL  -> Lux (GPT) — só quando o billing dela existir
 *
 * Formato do payload confirmado num teste real em 27/08/2026. Só sabe ler
 * mensagem de texto simples (ver extrairMensagem) — outros tipos (imagem,
 * áudio, mensagem citada) ainda não têm um exemplo real de payload.
 */

import { Router } from 'express';
import { perguntarGemini } from '../services/geminiService.js';
import { declaracoesFerramentas, executarFerramenta } from '../services/ferramentasAgentes.js';
import { ehDono } from '../services/identidade.js';
import { construirPromptMiriel } from '../prompts/miriel-whatsapp.js';

const router = Router();

/**
 * Configuração da instância — a chave é a mesma AUTHENTICATION_API_KEY do
 * Docker Compose da Evolution. O backend roda FORA do Docker, então fala
 * com a Evolution pela porta publicada no host — usando 127.0.0.1, não
 * "localhost": neste Windows, "localhost" resolve primeiro por IPv6
 * (::1), e a porta publicada pelo Docker Desktop nesse Windows não
 * respondeu direito por IPv6 no teste que já fizemos com curl mais cedo
 * — só depois de forçar IPv4 (-4) é que funcionou. Mesmo problema, mesma
 * solução, aqui dentro do Node.
 */
const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

/**
 * Histórico de conversa por número — em memória, some se o backend
 * reiniciar (mesma honestidade de sempre: nada de fingir persistência
 * que não existe; Rotina e Panteão também ainda vivem só em memória).
 * Guarda só as últimas HISTORICO_MAX mensagens de cada lado pra não
 * crescer sem limite numa conversa longa.
 */
const historicoPorNumero = new Map();   // numero -> [{ autor: 'usuario'|'agente', texto }]
const HISTORICO_MAX = 20;

/**
 * Manda uma mensagem de texto pelo WhatsApp, através da própria Evolution
 * API. A instância vem do próprio evento recebido, não de uma constante
 * fixa — quando existir uma segunda instância (a futura Lux), cada uma
 * responde pela que recebeu, sem precisar mexer aqui.
 *
 * @param {string} instancia — nome da instância (ex.: 'Miriel')
 * @param {string} numero — só dígitos, com DDI (ex.: '5516993444337')
 * @param {string} texto
 */
async function enviarMensagemWhatsapp(instancia, numero, texto) {
  if (!EVOLUTION_KEY) {
    throw new Error('EVOLUTION_API_KEY não encontrada no .env do backend — sem ela não dá pra mandar mensagem.');
  }

  const resposta = await fetch(`${EVOLUTION_URL}/message/sendText/${instancia}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
    body: JSON.stringify({ number: numero, text: texto })
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    throw new Error(`Evolution API respondeu ${resposta.status} ao tentar mandar mensagem: ${corpo}`);
  }
}

/**
 * Puxa remetente/nome/texto de um evento messages.upsert. Só sabe ler
 * mensagem de texto simples (message.conversation) por enquanto — outros
 * tipos (imagem, áudio, mensagem citada etc.) vêm com formato próprio que
 * ainda não vimos um exemplo real, então preferimos devolver null e logar
 * o tipo bruto a chutar um campo errado.
 *
 * @param {object} data — o campo "data" do payload da Evolution
 */
function extrairMensagem(data) {
  const remoteJid = data.key?.remoteJid ?? '';
  const numero = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '') || null;
  const ehGrupo = remoteJid.endsWith('@g.us');
  const nome = data.pushName ?? null;
  const deMim = data.key?.fromMe ?? null;
  const tipo = data.messageType ?? null;

  let texto = null;
  if (tipo === 'conversation') {
    texto = data.message?.conversation ?? null;
  } else if (tipo === 'extendedTextMessage') {
    texto = data.message?.extendedTextMessage?.text ?? null;
  }

  return { numero, ehGrupo, nome, deMim, tipo, texto };
}

/**
 * A Evolution manda POST aqui pra cada evento que a instância assinar
 * (mensagem recebida, atualização de status, etc. — o que estiver
 * marcado na tela Events > Webhook da instância no Manager).
 */
router.post('/webhook', (req, res) => {
  const corpo = req.body ?? {};

  // Responde rápido e 200 sempre, ANTES de processar — a Evolution pode
  // reenviar o evento se não receber confirmação a tempo, e chamar a
  // Gemini + mandar a resposta pode levar alguns segundos.
  res.status(200).json({ recebido: true });

  if (corpo.event !== 'messages.upsert') {
    console.log(`[whatsapp] evento "${corpo.event}" recebido, sem tratamento ainda.`);
    return;
  }

  const msg = extrairMensagem(corpo.data ?? {});

  if (msg.deMim) {
    console.log(`[whatsapp] eco de mensagem própria (${corpo.instance}) — ignorando.`);
    return;
  }
  if (msg.ehGrupo) {
    console.log(`[whatsapp] mensagem de grupo (${msg.numero}) — Miriel não responde em grupo por enquanto.`);
    return;
  }
  if (!msg.texto) {
    console.log(`[whatsapp] mensagem de tipo "${msg.tipo}" ainda não sei ler — payload bruto:`);
    console.log(JSON.stringify(corpo.data, null, 2));
    return;
  }

  console.log(`[whatsapp] ${corpo.instance} recebeu de ${msg.nome ?? msg.numero} (${msg.numero}): "${msg.texto}"`);

  responderComMiriel(corpo.instance, msg).catch((erro) => {
    console.error(`[whatsapp] falha ao responder para ${msg.numero}:`, erro.message);
  });
});

/**
 * Pergunta pra Gemini (já com o histórico da conversa desse número) e
 * manda a resposta de volta pelo mesmo número, na mesma instância que
 * recebeu. Nenhuma separação cliente/pessoal por agente ainda — toda
 * mensagem cai aqui, decisão explícita do usuário pra fechar esta etapa
 * hoje.
 *
 * As duas chamadas ficam em try/catch separados de propósito: "fetch
 * failed" sozinho não diz qual das duas quebrou — com isso, o log deixa
 * claro se foi ao perguntar pra Gemini ou ao mandar pelo WhatsApp.
 */
async function responderComMiriel(instancia, msg) {
  const historico = historicoPorNumero.get(msg.numero) ?? [];

  let resposta;
  try {
    const instrucaoSistema = construirPromptMiriel({ ehDono: ehDono(msg.numero) });
    ({ texto: resposta } = await perguntarGemini(msg.texto, {
      instrucaoSistema,
      historico,
      ferramentas: declaracoesFerramentas,
      executarFerramenta: (nome, args) => executarFerramenta(nome, args, { agenteId: 'hermes' })
    }));
  } catch (erro) {
    throw new Error(`ao perguntar pra Gemini: ${erro.message}${erro.cause ? ` — causa: ${erro.cause}` : ''}`);
  }

  try {
    await enviarMensagemWhatsapp(instancia, msg.numero, resposta);
  } catch (erro) {
    throw new Error(`ao mandar pelo WhatsApp: ${erro.message}${erro.cause ? ` — causa: ${erro.cause}` : ''}`);
  }

  const atualizado = [
    ...historico,
    { autor: 'usuario', texto: msg.texto },
    { autor: 'agente', texto: resposta }
  ].slice(-HISTORICO_MAX);
  historicoPorNumero.set(msg.numero, atualizado);

  console.log(`[whatsapp] Miriel respondeu para ${msg.numero}: "${resposta}"`);
}

export default router;
