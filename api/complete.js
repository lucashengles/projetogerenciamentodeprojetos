// Função serverless da Vercel — a "portinha" segura que conversa com a IA.
// Usa a API do Google Gemini, que tem NÍVEL GRATUITO. A chave fica guardada aqui no
// servidor (variável de ambiente) e NUNCA chega ao navegador do usuário.
//
// Rota pública: POST /api/complete   body: { "prompt": "..." }   ->   { "text": "..." }
//
// Variáveis de ambiente (configuradas na Vercel):
//   GEMINI_API_KEY    (obrigatória)  sua chave do Google AI Studio (aistudio.google.com)
//   GEMINI_MODEL      (opcional)     modelo. Padrão: gemini-2.0-flash (rápido e no nível grátis).
//   MAX_TOKENS        (opcional)     tamanho máximo de cada resposta. Padrão: 500.
//   DAILY_CALL_LIMIT  (opcional)     teto GLOBAL de chamadas por dia. Padrão: 800.
//   IP_HOURLY_LIMIT   (opcional)     teto de chamadas por pessoa (IP) por hora. Padrão: 60.
//
// GARANTIA DE CUSTO ZERO: se você NÃO ativar faturamento no Google Cloud/AI Studio,
// a chave só funciona no nível gratuito — ao atingir os limites do Google, as chamadas
// falham e o app cai automaticamente nos textos de reserva. Nunca há cobrança.

const buckets = { day: { date: '', count: 0 }, ips: new Map() };
function today() { return new Date().toISOString().slice(0, 10); }

function rateLimited(ip, dailyLimit, ipHourlyLimit) {
  const d = today();
  if (buckets.day.date !== d) buckets.day = { date: d, count: 0 };
  if (buckets.day.count >= dailyLimit) return 'O limite diário de uso foi atingido. Tente novamente amanhã.';
  const now = Date.now();
  const rec = buckets.ips.get(ip) || { start: now, count: 0 };
  if (now - rec.start > 3600 * 1000) { rec.start = now; rec.count = 0; }
  if (rec.count >= ipHourlyLimit) return 'Você atingiu o limite de uso por hora. Aguarde um pouco e tente de novo.';
  rec.count++; buckets.ips.set(ip, rec);
  buckets.day.count++;
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(500).json({ error: 'GEMINI_API_KEY não configurada na Vercel.' }); return; }

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const maxTokens = parseInt(process.env.MAX_TOKENS || '500', 10);
  const dailyLimit = parseInt(process.env.DAILY_CALL_LIMIT || '800', 10);
  const ipHourlyLimit = parseInt(process.env.IP_HOURLY_LIMIT || '60', 10);

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  const blocked = rateLimited(ip, dailyLimit, ipHourlyLimit);
  if (blocked) { res.status(429).json({ error: blocked }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const prompt = body && body.prompt;
  if (!prompt || typeof prompt !== 'string' || prompt.length > 6000) {
    res.status(400).json({ error: 'Prompt inválido.' }); return;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
      })
    });
    if (!r.ok) {
      const detail = await r.text();
      res.status(502).json({ error: 'Falha na IA', detail: detail.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts && parts.map(function (p) { return p.text || ''; }).join('')) || '';
    res.status(200).json({ text: text });
  } catch (e) {
    res.status(502).json({ error: 'Erro ao chamar a IA', detail: String(e).slice(0, 300) });
  }
};
