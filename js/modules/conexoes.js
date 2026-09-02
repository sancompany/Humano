/**
 * SAN & CO. — sub-tela Conexões (dentro do módulo Finanças)
 *
 * Extraída do config.js — a lógica é a mesma que já existia e estava
 * testada; só mudou de casa. Conexão bancária é assunto de Finanças, não
 * de Configuração geral, então é aqui que ela mora agora.
 *
 * NÃO É UMA ABA própria da barra inferior. Quem monta é o financeiro.js,
 * na rota #/financas/conexoes — mesmo contrato reduzido das outras
 * sub-telas (render/mount/unmount, sem cabeçalho nem seletor PF/PJ).
 */

import { estado, observar } from '../state.js';
import { corDoBanco } from '../bancos.js';
import { AGENTES } from './panteao.js';

/**
 * Bancos oferecidos no fluxo de "+ Nova conexão". Lista curada à mão —
 * não reaproveita as chaves de js/bancos.js porque aquele arquivo mistura
 * bancos com corretoras e custodiantes (Binance, Tesouro Direto, XP...),
 * que não são "bancos para conectar Open Finance" no mesmo sentido.
 */
const BANCOS_SUPORTADOS = [
  'Nubank', 'Itaú', 'Bradesco', 'Banco Inter', 'Santander',
  'Banco do Brasil', 'Caixa', 'C6 Bank', 'BTG Pactual', 'Sicoob', 'Safra'
];

/* ------------------------------------------------------------------
   1. DADOS E CONSENTIMENTO
------------------------------------------------------------------ */

/** Prazo do consentimento de Open Finance, em dias. */
export const PRAZO_CONSENTIMENTO = 365;

/** Faixas do contador: acima de 90 dias tranquilo, abaixo de 30 urgente. */
const ALERTA_CONSENTIMENTO = { tranquilo: 90, atencao: 30 };

/**
 * Contas conectadas pela Pluggy. `perfil` é o override manual: a
 * classificação automática pelo documento do titular erra em conta PJ
 * aberta no CPF, então o valor final é sempre o que está aqui.
 *
 * TODO: ler e gravar no Supabase.
 */
const conexoes = [];   // preenchido pelo Supabase; sem mock

/**
 * Uma conexão pelo id, para a tela dedicada de "Ver detalhes"
 * (#/financas/detalhe/conexao/<id>). Sem Supabase ainda, `conexoes` está
 * vazio — a tela mostra o estado de "não encontrada" até o backend existir.
 * @param {string} id
 */
export function conexaoPorId(id) {
  return conexoes.find((c) => String(c.id) === String(id)) ?? null;
}

/**
 * Dias restantes do consentimento, contados sobre PRAZO_CONSENTIMENTO.
 * Nunca devolve negativo: consentimento vencido é zero.
 * @param {string} consentidoEm data ISO (AAAA-MM-DD)
 */
function diasRestantes(consentidoEm) {
  const [ano, mes, dia] = consentidoEm.split('-').map(Number);
  const inicio = new Date(ano, mes - 1, dia);
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const decorridos = Math.floor((hoje - inicio) / 86_400_000);
  return Math.max(0, PRAZO_CONSENTIMENTO - decorridos);
}

/**
 * Situação do consentimento de uma conexão.
 *
 * Nem todo banco trabalha com prazo anual — Bradesco e alguns outros dão
 * consentimento por prazo indeterminado, e forçar uma contagem regressiva
 * ali seria inventar um vencimento que não existe.
 *
 * @returns {{ tipo: 'indeterminado'|'contagem', faixa: string, dias: number|null, texto: string }}
 */
export function situacaoConsentimento(conexao) {
  if (conexao.prazo === 'indeterminado') {
    return {
      tipo: 'indeterminado',
      faixa: 'continuo',
      dias: null,
      texto: 'Indeterminado · ativo contínuo'
    };
  }

  const dias = diasRestantes(conexao.consentidoEm);
  if (dias === 0) {
    return { tipo: 'contagem', faixa: 'urgente', dias: 0, texto: 'Consentimento expirado' };
  }

  const faixa = dias > ALERTA_CONSENTIMENTO.tranquilo ? 'ok'
              : dias > ALERTA_CONSENTIMENTO.atencao ? 'atencao'
              : 'urgente';

  const sufixo = faixa === 'urgente' ? ' (Renovar)' : '';
  return {
    tipo: 'contagem',
    faixa,
    dias,
    texto: `${dias} ${dias === 1 ? 'dia restante' : 'dias restantes'}${sufixo}`
  };
}

/** '2026-08-16T09:12:00' -> '16/08 às 09:12' */
export function momentoCurto(iso) {
  const d = new Date(iso);
  const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${data} às ${hora}`;
}

/* ------------------------------------------------------------------
   2. FRAGMENTOS — cards por conexão, não linha
------------------------------------------------------------------ */

/** Um card de conexão: logo, nome, status e o contador de consentimento. */
function htmlConexao(conexao) {
  const situacao = situacaoConsentimento(conexao);
  const proporcao = situacao.tipo === 'indeterminado'
    ? 100
    : (situacao.dias / PRAZO_CONSENTIMENTO) * 100;

  return `
    <article class="conexao-card">
      <header class="conexao-card__topo">
        <span class="conexao-card__logo" aria-hidden="true"
              style="background: ${corDoBanco(conexao.instituicao)}"></span>
        <span class="conexao-card__status conexao-card__status--${situacao.faixa === 'urgente' ? 'alerta' : 'ok'}"
              aria-hidden="true"></span>
      </header>

      <p class="conexao-card__nome">${conexao.instituicao}</p>
      <p class="conexao-card__momento">
        ${conexao.ultimaSync ? `Sincronizado ${momentoCurto(conexao.ultimaSync)}` : 'Aguardando 1ª sincronização'}
      </p>

      <div class="consentimento consentimento--${situacao.faixa}">
        <div class="consentimento__barra" role="img" aria-label="Consentimento: ${situacao.texto}">
          <span class="consentimento__preenchido" style="width: ${proporcao.toFixed(1)}%"></span>
        </div>
        <p class="consentimento__texto">${situacao.texto}</p>
      </div>

      <button class="conexao-card__link" type="button" data-conexao-id="${conexao.id}">
        Ver detalhes <span aria-hidden="true">&rsaquo;</span>
      </button>
    </article>
  `;
}

/** Um bloco de conexões por perfil. Vazio some em vez de mostrar título solto. */
function htmlBlocoConexoes(perfil, titulo) {
  const doPerfil = conexoes.filter((c) => c.perfil === perfil);
  if (!doPerfil.length) return '';

  return `
    <section class="section">
      <p class="section__label">${titulo}</p>
      <div class="conexoes-grade">${doPerfil.map(htmlConexao).join('')}</div>
    </section>
  `;
}

/**
 * Permissão de leitura financeira por agente. Em memória por enquanto —
 * TODO: persistir no Supabase. É a mesma regra em qualquer plano: dono usa
 * os três, cliente usa o agente que escolheu (nome dele é dado no cadastro,
 * não fixado aqui) — a tela não precisa saber qual dos dois casos é.
 */
const acessoAgentes = { hermes: true, prometeu: true, hefesto: true };

/**
 * Um agente por linha, com um interruptor real — não uma descrição de
 * texto do que ele faz. Ligar/desligar aqui é o que decide se ele lê o
 * financeiro, e já é a peça que o MCP (backend/services/mcpTools.js) vai
 * consultar antes de responder qualquer pergunta sobre dinheiro.
 */
function htmlAgentesComAcesso() {
  return `
    <section class="section">
      <p class="section__label">Acesso dos agentes</p>
      <ul class="agentes-acesso">
        ${AGENTES.map((a) => `
          <li class="agentes-acesso__item">
            <span class="agentes-acesso__ponto" aria-hidden="true" style="background:${a.cor}"></span>
            <span class="agentes-acesso__nome">${a.nome}</span>
            <button class="switch" type="button" role="switch"
                    aria-checked="${acessoAgentes[a.id]}"
                    aria-label="Leitura do financeiro por ${a.nome}"
                    data-agente-toggle="${a.id}"></button>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

/**
 * Gaveta de "+ Nova conexão": escolher o banco para iniciar o pareamento.
 * Sem backend ainda, escolher um banco não conecta nada de verdade — só
 * confirma a intenção, com aviso honesto na própria gaveta.
 */
function htmlGavetaNovaConexao() {
  return `
    <div class="anexo-sheet" data-regiao="nova-conexao-sheet" ${gavetaNovaAberta ? '' : 'hidden'}>
      <div class="anexo-sheet__fundo" data-nova-conexao-fechar aria-hidden="true"></div>
      <div class="anexo-sheet__painel" role="dialog" aria-modal="true" aria-label="Conectar novo banco"
           style="max-width: 360px; border-radius: 18px;">
        <p class="modelo-popover__titulo" style="color:var(--gold)">Nova conexão</p>
        <p class="section__nota" style="margin-top:-2px;">
          Escolha o banco para iniciar o pareamento com a Pluggy.
        </p>

        <ul class="banco-lista">
          ${BANCOS_SUPORTADOS.map((nome) => `
            <li class="banco-lista__item" data-clickable="true" role="button" tabindex="0"
                data-conectar-banco="${escapar(nome)}" style="--marca: ${corDoBanco(nome)}">
              <span class="banco-lista__logo" aria-hidden="true"></span>
              <span class="banco-lista__nome">${escapar(nome)}</span>
              <span class="banco-lista__seta" aria-hidden="true">&rsaquo;</span>
            </li>
          `).join('')}
        </ul>

        <p class="dropzone__retorno" data-regiao="nova-conexao-retorno" role="status" hidden></p>
      </div>
    </div>
  `;
}

/** Escapa texto que vai para innerHTML. */
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------
   3. MÓDULO
------------------------------------------------------------------ */
let raiz = null;
let aoClicar = null;
let aoTeclar = null;
let cancelarObservador = null;
let gavetaNovaAberta = false;

/** Só reescreve a gaveta — o resto da tela fica no lugar. */
function redesenharGaveta() {
  const gaveta = raiz?.querySelector('[data-regiao="nova-conexao-sheet"]');
  if (gaveta) gaveta.outerHTML = htmlGavetaNovaConexao();
}

const conexoesModulo = {
  id: 'conexoes',
  titulo: 'Conexões',

  render() {
    const bloco = document.createElement('div');
    bloco.dataset.subtela = this.id;

    const doPerfil = conexoes.filter((c) => c.perfil === estado.perfil);

    bloco.innerHTML = `
      <div class="conexoes-cabecalho">
        <p class="conexoes-cabecalho__titulo">Conexões bancárias</p>
        <button class="btn btn--gold" type="button" data-acao="nova-conexao">+ Nova conexão</button>
      </div>

      ${doPerfil.length ? '' : `
        <div class="slot">
          <span class="slot__mark" aria-hidden="true"></span>
          <p class="slot__text">Nenhum banco conectado neste perfil ainda.</p>
        </div>
      `}

      <div data-regiao="conexoes-lista">${htmlBlocoConexoes(estado.perfil, 'Conexões ativas')}</div>

      ${htmlAgentesComAcesso()}

      ${htmlGavetaNovaConexao()}
    `;

    return bloco;
  },

  mount(view) {
    raiz = view;

    aoClicar = (evento) => {
      if (evento.target.closest('[data-acao="nova-conexao"]')) {
        gavetaNovaAberta = true;
        return redesenharGaveta();
      }
      if (evento.target.closest('[data-nova-conexao-fechar]')) {
        gavetaNovaAberta = false;
        return redesenharGaveta();
      }

      const banco = evento.target.closest('[data-conectar-banco]');
      if (banco) {
        const retorno = raiz?.querySelector('[data-regiao="nova-conexao-retorno"]');
        if (retorno) {
          retorno.textContent =
            `Pareamento com ${banco.dataset.conectarBanco} ainda depende do backend da Pluggy — nada foi conectado agora.`;
          retorno.dataset.tom = 'neutro';
          retorno.hidden = false;
        }
        console.info('[conexões] início de pareamento solicitado para', banco.dataset.conectarBanco, '— sem backend ainda.');
        return;
      }

      const detalhe = evento.target.closest('[data-conexao-id]');
      if (detalhe) {
        window.location.hash = `#/financas/detalhe/conexao/${encodeURIComponent(detalhe.dataset.conexaoId)}`;
        return;
      }

      const toggle = evento.target.closest('[data-agente-toggle]');
      if (toggle) {
        const id = toggle.dataset.agenteToggle;
        const ligado = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(ligado));
        acessoAgentes[id] = ligado;
        // TODO: persistir no Supabase e refletir no MCP (mcpTools.js) —
        // hoje o agente não consulta esta flag antes de ler o financeiro.
      }
    };

    // os itens da gaveta têm tabindex mas não são <button>: idem para o teclado
    aoTeclar = (evento) => {
      if (evento.key !== 'Enter' && evento.key !== ' ') return;
      const banco = evento.target.closest('[data-conectar-banco]');
      if (!banco) return;
      evento.preventDefault();

      const retorno = raiz?.querySelector('[data-regiao="nova-conexao-retorno"]');
      if (retorno) {
        retorno.textContent =
          `Pareamento com ${banco.dataset.conectarBanco} ainda depende do backend da Pluggy — nada foi conectado agora.`;
        retorno.dataset.tom = 'neutro';
        retorno.hidden = false;
      }
      console.info('[conexões] início de pareamento solicitado para', banco.dataset.conectarBanco, '— sem backend ainda.');
    };

    view.addEventListener('click', aoClicar);
    view.addEventListener('keydown', aoTeclar);

    cancelarObservador = observar('perfil', () => {
      const area = raiz?.querySelector('[data-regiao="conexoes-lista"]');
      if (area) area.innerHTML = htmlBlocoConexoes(estado.perfil, 'Conexões ativas');
    });
  },

  unmount() {
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('keydown', aoTeclar);
    }
    cancelarObservador?.();
    cancelarObservador = null;
    aoClicar = null;
    aoTeclar = null;
    raiz = null;
    gavetaNovaAberta = false;
  }
};

export default conexoesModulo;
