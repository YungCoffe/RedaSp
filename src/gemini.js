'use strict';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT = 180_000;
const TENTATIVAS = 3;
const MIN_PADRAO = 1200;
const MAX_PADRAO = 3000;

const modelo = require('./modelo');

const SCHEMA = {
  type: 'OBJECT',
  properties: { titulo: { type: 'STRING' }, texto: { type: 'STRING' } },
  required: ['titulo', 'texto'],
};

const SYSTEM = 'Você escreve redações escolares em português do Brasil, no padrão ' +
  'dissertativo-argumentativo do ENEM: introdução com tese, dois desenvolvimentos com ' +
  'repertório legitimado e conclusão com proposta de intervenção. Norma culta, coesão, ' +
  'sem clichês e sem primeira pessoa. Devolva somente JSON com as chaves titulo e texto. ' +
  'O titulo deve ter no máximo 60 caracteres. O texto é o corpo completo, sem o título repetido.';

class GeminiError extends Error {}

function chave() {
  const valor = (process.env.GEMINI_API_KEY || '').trim();
  if (!valor) throw new GeminiError('GEMINI_API_KEY não configurada.');
  return valor;
}

function faixa(minimo, maximo) {
  let min = minimo || MIN_PADRAO;
  let max = maximo || MAX_PADRAO;
  if (min >= max) max = min + Math.max(200, Math.floor(min / 5));
  return [min, max, Boolean(minimo && maximo)];
}

function prompt(tema, min, max, instrucoes) {
  const partes = [
    `Tema da redação: ${tema}`,
    `O corpo deve ter entre ${min} e ${max} caracteres, contando espaços.`,
  ];
  if (instrucoes.trim()) partes.push(`Orientações do autor: ${instrucoes.trim()}`);
  partes.push('Escreva agora a redação completa.');
  return partes.join('\n\n');
}

const dentro = (t, min, max) => t.length >= min && t.length <= max;

function distancia(t, min, max) {
  if (t.length < min) return min - t.length;
  if (t.length > max) return t.length - max;
  return 0;
}

const url = (nome) => `${BASE}/${encodeURIComponent(nome)}:generateContent?key=${encodeURIComponent(chave())}`;

async function chamar(textoPrompt) {
  const config = {
    temperature: 0.85, maxOutputTokens: 8192,
    responseMimeType: 'application/json', responseSchema: SCHEMA,
  };
  const budget = (process.env.GEMINI_THINKING_BUDGET || '').trim();
  if (/^\d+$/.test(budget)) config.thinkingConfig = { thinkingBudget: Number(budget) };

  let nome = await modelo.get();
  for (let tentativa = 0; ; tentativa += 1) {
    let res;
    try {
      res = await fetch(url(nome), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: textoPrompt }] }],
          generationConfig: config,
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new GeminiError('Falha de conexão com o Gemini.');
    }

    if ([400, 404, 429].includes(res.status) && tentativa === 0) {
      modelo.invalidar();
      nome = await modelo.get(true);
      continue;
    }
    if (res.status === 429) throw new GeminiError('Cota do Gemini esgotada; tente em alguns minutos.');
    if (!res.ok) throw new GeminiError(`Gemini recusou a chamada (HTTP ${res.status}).`);

    let dados;
    try {
      const corpo = await res.json();
      const bruto = corpo.candidates[0].content.parts[0].text;
      dados = JSON.parse(bruto);
    } catch {
      throw new GeminiError('Resposta do Gemini não reconhecida.');
    }
    const titulo = String(dados.titulo || '').trim().slice(0, 200);
    const texto = String(dados.texto || '').trim();
    if (!titulo || !texto) throw new GeminiError('O Gemini devolveu texto vazio.');
    return { titulo, texto, modelo: nome };
  }
}

async function generate(tema, minimo, maximo, instrucoes = '') {
  if (!String(tema).trim()) throw new GeminiError('Tema vazio; não é possível gerar.');
  const [alvoMin, alvoMax, informado] = faixa(minimo, maximo);
  let atual = prompt(tema, alvoMin, alvoMax, instrucoes);
  let melhor = null;

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    const dados = await chamar(atual);
    const ok = dentro(dados.texto, alvoMin, alvoMax);
    const atualMelhor = melhor ? distancia(melhor.texto, alvoMin, alvoMax) : Infinity;
    if (distancia(dados.texto, alvoMin, alvoMax) < atualMelhor) {
      melhor = { ...dados, tentativas: tentativa, dentro: ok };
    }
    if (ok) break;
    const ajuste = dados.texto.length > alvoMax
      ? `O texto anterior tem ${dados.texto.length} caracteres e passou do máximo de ${alvoMax}. Corte o excesso sem perder a estrutura.`
      : `O texto anterior tem ${dados.texto.length} caracteres e ficou abaixo do mínimo de ${alvoMin}. Amplie a argumentação.`;
    atual = `${ajuste}\n\nTema: ${tema}\n\nEntre ${alvoMin} e ${alvoMax} caracteres. ` +
      `Reescreva o JSON completo.\n\nTexto anterior:\n${dados.texto}`;
  }

  return { ...melhor, minimo: alvoMin, maximo: alvoMax, limitesInformados: informado };
}

module.exports = { generate, GeminiError };
