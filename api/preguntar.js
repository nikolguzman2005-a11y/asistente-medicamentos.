// Función de servidor (Vercel). Guarda la clave de la IA fuera de la página.
// Variables de entorno (usa UNA de las dos):
//   GEMINI_API_KEY     -> IA de Google con nivel gratuito (recomendado para pruebas)
//   ANTHROPIC_API_KEY  -> IA de Anthropic (de pago por uso)
//
// Para diagnosticar: abre en el navegador  /api/preguntar?pregunta=hola
// Si algo falla, el campo "detalle" dice el motivo.

function construirPrompt(medicamento, pregunta) {
  return [
    "Eres el asistente de voz de una etiqueta accesible para envases de medicamentos en España. Lo usan personas ciegas, mayores o que no leen bien, así que tus respuestas se leen en voz alta.",
    "Medicamento de la etiqueta: " + medicamento + ".",
    "Pregunta de la persona: " + pregunta,
    "",
    "Reglas:",
    "1. Responde solo a preguntas relacionadas con medicamentos (el de la etiqueta u otros). Si la pregunta no tiene que ver con medicamentos, marca relacionada=false y en respuesta di con amabilidad que solo puedes ayudar con medicamentos.",
    "2. Si es sobre medicamentos, explica con la información habitual de su prospecto: para qué sirve, cómo se toma de forma general, contraindicaciones, efectos adversos, interacciones, conservación.",
    "3. Nunca pautes una dosis personalizada ni diagnostiques. En dudas de dosis para una persona concreta, niños, embarazo, lactancia, enfermedades previas o síntomas que preocupan, indica que lo consulte con su farmacéutico o su médico. Si parece una urgencia o una sobredosis, indica llamar al 112.",
    "4. Si no estás seguro de un dato, dilo y remite al prospecto o al farmacéutico. No inventes.",
    "5. Habla en español sencillo, con frases cortas, en un máximo de 90 palabras, sin listas, sin símbolos, sin abreviaturas y sin markdown, porque se leerá en voz alta.",
    "6. En buscar_vademecum pon el nombre del medicamento por el que se pregunta (principio activo o marca), sin más texto. Si no hay medicamento, déjalo vacío.",
    "",
    "Devuelve solo un objeto JSON con esta forma exacta:",
    '{"relacionada": true, "respuesta": "texto para leer en voz alta", "buscar_vademecum": "nombre del medicamento"}'
  ].join("\n");
}

const esperar = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };

// Llama a Gemini y reintenta si Google está saturado (503, 429 o 500).
async function pedirGemini(modelo, prompt, key, intentos) {
  let r;
  intentos = intentos || 2;
  for (let intento = 0; intento < intentos; intento++) {
    const control = new AbortController();
    const reloj = setTimeout(function () { control.abort(); }, 9000);
    try {
      r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + modelo + ":generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          signal: control.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              maxOutputTokens: 800
            }
          })
        }
      );
    } catch (e) {
      clearTimeout(reloj);
      if (intento === intentos - 1) throw new Error("Google no responde (tiempo de espera agotado). Prueba otra vez en un momento.");
      await esperar(500);
      continue;
    }
    clearTimeout(reloj);
    if (r.status !== 503 && r.status !== 429 && r.status !== 500) return r;
    await esperar(800);
  }
  return r;
}

// Pregunta a Google qué modelos "flash" puede usar esta clave (así no hay que adivinar nombres).
async function modelosDisponibles(key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": key }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1; })
    .map(function (m) { return String(m.name || "").replace(/^models\//, ""); })
    .filter(function (n) { return /flash/i.test(n) && !/(image|tts|audio|live|embed|robotics|thinking)/i.test(n); });
}

async function conGemini(prompt, key) {
  const modelo = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const alternativo = (process.env.GEMINI_MODEL_RESPALDO || "").trim();
  const probados = [modelo];
  let r = await pedirGemini(modelo, prompt, key, 2);
  if (!r.ok && alternativo && alternativo !== modelo) {
    probados.push(alternativo);
    r = await pedirGemini(alternativo, prompt, key, 1);
  }
  if (!r.ok) {
    // Último recurso: probar hasta 3 modelos flash que tenga la cuenta
    let lista = [];
    try { lista = await modelosDisponibles(key); } catch (e) { lista = []; }
    lista = lista.filter(function (n) { return probados.indexOf(n) === -1; }).slice(0, 3);
    for (const n of lista) {
      probados.push(n);
      try { r = await pedirGemini(n, prompt, key, 1); } catch (e) { continue; }
      if (r.ok) break;
    }
  }
  if (!r.ok) {
    const detalle = (await r.text()).slice(0, 400);
    throw new Error("Gemini respondió " + r.status + " (modelos probados: " + probados.join(", ") + "): " + detalle);
  }
  const data = await r.json();
  const partes = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const texto = partes.map(function (p) { return p.text || ""; }).join("");
  if (!texto) throw new Error("Gemini no devolvió texto: " + JSON.stringify(data).slice(0, 400));
  return texto;
}

async function conAnthropic(prompt, key) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) {
    const detalle = (await r.text()).slice(0, 400);
    throw new Error("Anthropic respondió " + r.status + ": " + detalle);
  }
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  // Un GET sin pregunta mantiene el mensaje de comprobación de que la función está subida.
  if (req.method === "GET" && !(req.query && req.query.pregunta)) {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
  const anthropicKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!geminiKey && !anthropicKey) {
    res.status(500).json({ error: "Falta GEMINI_API_KEY o ANTHROPIC_API_KEY en el servidor" });
    return;
  }

  let body;
  if (req.method === "GET") {
    body = req.query || {};
  } else {
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    } catch (e) {
      body = {};
    }
  }
  const pregunta = String(body.pregunta || "").trim().slice(0, 300);
  const medicamento = String(body.medicamento || "").trim().slice(0, 60) || "no indicado";
  if (!pregunta) {
    res.status(400).json({ error: "Falta la pregunta" });
    return;
  }

  try {
    const prompt = construirPrompt(medicamento, pregunta);
    const texto = geminiKey ? await conGemini(prompt, geminiKey) : await conAnthropic(prompt, anthropicKey);
    let salida;
    try {
      const m = texto.match(/\{[\s\S]*\}/);
      salida = JSON.parse(m ? m[0] : texto);
    } catch (e) {
      salida = { relacionada: true, respuesta: texto, buscar_vademecum: medicamento };
    }
    res.status(200).json(salida);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "La IA no ha respondido", detalle: String((e && e.message) || e) });
  }
};
