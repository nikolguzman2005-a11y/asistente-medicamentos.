// Función de servidor (Vercel). Guarda la clave de la IA fuera de la página.
// Variables de entorno (usa UNA de las dos):
//   GEMINI_API_KEY     -> IA de Google con nivel gratuito (recomendado para pruebas)
//   ANTHROPIC_API_KEY  -> IA de Anthropic (de pago por uso)
//
// Para diagnosticar: abre en el navegador  /api/preguntar?pregunta=hola
// Si algo falla, el campo "detalle" dice el motivo.

// ---------------------------------------------------------------------------
// Referencia oficial: el prospecto (hoja interior) de cada medicamento, tomado
// en directo de CIMA, el catálogo de la AEMPS. Así sirve para cualquier medicamento.
// No se incluyen los datos obligatorios de la caja (nombre y dosis, composición,
// forma, vía, contenido, lote, caducidad, titular, código nacional): van en la etiqueta.
//
// Para ver qué ha encontrado la función:
//   /api/preguntar?diagnostico=1&medicamento=ibuprofeno
// La etiqueta puede llevar el nombre (#paracetamol) o el número de registro de CIMA (#70310)
// si se quiere señalar una marca y una dosis concretas.
// ---------------------------------------------------------------------------
const CIMA = "https://cima.aemps.es/cima/rest";
const HORAS_CACHE = 6;
const cache = new Map();

async function pedirTexto(url, ms) {
  const control = new AbortController();
  const reloj = setTimeout(function () { control.abort(); }, ms || 5000);
  try {
    const r = await fetch(url, { signal: control.signal });
    if (!r.ok) throw new Error("CIMA respondió " + r.status);
    return await r.text();
  } finally {
    clearTimeout(reloj);
  }
}
async function pedirJSON(url, ms) {
  return JSON.parse(await pedirTexto(url, ms));
}

function htmlATexto(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&amp;/g, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Los prospectos tienen 6 apartados. Se usan del 1 al 5 y se deja fuera el 6
// (composición, aspecto, envases y titular), que es información de la caja.
const TITULO_APARTADO = /^\s*([1-6])\s*\.\s*(Qu[eé]|C[oó]mo|Posibles|Conservaci[oó]n|Contenido)/i;
function apartados(texto) {
  const lineas = texto.split("\n");
  const ultima = {};
  lineas.forEach(function (l, i) {
    const m = l.match(TITULO_APARTADO);
    if (m) ultima[Number(m[1])] = i; // el índice del principio repite los títulos: vale la última aparición
  });
  const orden = Object.keys(ultima).map(Number).sort(function (a, b) { return ultima[a] - ultima[b]; });
  const out = {};
  orden.forEach(function (n, k) {
    const fin = k + 1 < orden.length ? ultima[orden[k + 1]] : lineas.length;
    out[n] = lineas.slice(ultima[n], fin).join("\n").trim();
  });
  return out;
}

function datosSecundarios(m) {
  const l = [];
  if (m.cpresc) l.push("Condiciones de prescripción: " + m.cpresc + ".");
  if (/\bEFG\b/i.test(m.nombre || "")) l.push("Es un medicamento genérico (EFG).");
  if (m.triangulo) l.push("Lleva el triángulo negro: está sometido a seguimiento adicional, así que conviene comunicar cualquier efecto adverso.");
  if (m.conduc) l.push("Puede afectar a la capacidad de conducir: el envase lleva el pictograma de conducción.");
  if (m.huerfano) l.push("Es un medicamento huérfano, para una enfermedad poco frecuente.");
  if (m.biosimilar) l.push("Es un medicamento biosimilar.");
  if (m.psum) l.push("Tiene problemas de suministro: puede costar encontrarlo en la farmacia.");
  l.push("Los envases vacíos y los restos de medicación se entregan en el punto SIGRE de la farmacia.");
  return l.join("\n");
}

function esProspecto(d) {
  const u = (d && (d.urlHtml || d.url)) || "";
  return d && (d.tipo === 2 || /\/(dochtml|pdfs\/es)\/p\//.test(u));
}

async function cargarReferencia(medicamento) {
  const clave = medicamento.toLowerCase();
  const guardado = cache.get(clave);
  if (guardado && Date.now() - guardado.cuando < HORAS_CACHE * 3600000) return guardado.datos;

  let datos;
  try {
    let ficha;
    if (/^\d{4,8}$/.test(medicamento)) {
      ficha = await pedirJSON(CIMA + "/medicamento?nregistro=" + medicamento, 4000);
    } else {
      const lista = await pedirJSON(
        CIMA + "/medicamentos?nombre=" + encodeURIComponent(medicamento) + "&comerc=1&tamanioPagina=10", 4000
      );
      const r = lista.resultados || [];
      ficha = r.find(function (m) { return (m.docs || []).some(function (d) { return esProspecto(d) && d.urlHtml; }); }) || r[0];
      if (!ficha) throw new Error("CIMA no encontró «" + medicamento + "»");
      if (!(ficha.docs || []).length) ficha = await pedirJSON(CIMA + "/medicamento?nregistro=" + ficha.nregistro, 4000);
    }
    const doc = (ficha.docs || []).find(function (d) { return esProspecto(d) && d.urlHtml; });
    if (!doc) throw new Error("CIMA no ofrece el prospecto en HTML de «" + (ficha.nombre || medicamento) + "»");

    const texto = htmlATexto(await pedirTexto(doc.urlHtml, 6000));
    const partes = apartados(texto);
    const numeros = [1, 2, 3, 4, 5].filter(function (n) { return partes[n]; });
    let referencia;
    if (numeros.length >= 3) {
      referencia = numeros.map(function (n) { return partes[n].slice(0, 7000); }).join("\n\n");
    } else {
      // No se han podido separar los apartados: se usa el texto entero, sin el apartado 6 si se localiza
      const cortes = [];
      const re = /Contenido del envase e informaci[oó]n adicional/gi;
      let m;
      while ((m = re.exec(texto))) cortes.push(m.index);
      const corte = cortes.length ? cortes[cortes.length - 1] : texto.length;
      referencia = texto.slice(0, corte).slice(0, 24000);
    }
    datos = {
      nombre: ficha.nombre,
      nregistro: ficha.nregistro,
      url: doc.urlHtml,
      apartados: numeros,
      texto: referencia,
      secundarios: datosSecundarios(ficha)
    };
    cache.set(clave, { cuando: Date.now(), datos: datos });
  } catch (e) {
    datos = { error: String((e && e.message) || e) };
  }
  return datos;
}

// Resumen del prospecto de paracetamol 1 g (Cinfa, revisión de febrero de 2025), solo como respaldo
// si CIMA no responde. Sin los datos de la caja.
const FICHA_RESPALDO_PARACETAMOL = [
  "Para qué sirve: dolor leve o moderado y fiebre, en adultos y adolescentes de más de 15 años que pesan más de 50 kg.",
  "Quién no debe tomarlo: quien tenga alergia al paracetamol o a cualquier componente. No debe usarse en menores de 15 años ni en quienes pesen menos de 50 kg.",
  "Cómo se toma: un comprimido entero (1 g) o medio (500 mg) según necesidad, con agua. Puede partirse por la mitad. Tomarlo con alimentos no cambia su eficacia. Esperar al menos 4 horas entre tomas. Máximo 4 comprimidos (4 g) en 24 horas.",
  "Cuánto tiempo: solo mientras haya dolor o fiebre. Consultar al médico si el dolor dura más de 5 días, la fiebre más de 3 días, o si empeoran o aparecen otros síntomas.",
  "Si se olvida una dosis: tomarla al acordarse, nunca el doble, y esperar al menos 4 horas hasta la siguiente.",
  "Si se toma de más: consultar enseguida al médico o al farmacéutico o llamar al Servicio de Información Toxicológica, teléfono 91 562 04 20, aunque no haya síntomas, porque pueden tardar hasta 3 días en aparecer. En una urgencia, llamar al 112.",
  "Precauciones: no tomar a la vez otros medicamentos que lleven paracetamol, como algunos para la gripe y el resfriado, por el riesgo de daño en el hígado. Beber tres o más bebidas alcohólicas al día puede dañar el hígado, y los alcohólicos crónicos no deben pasar de 2 g en 24 horas. Consultar al médico antes si hay enfermedad del hígado, del riñón, del corazón o del pulmón, anemia, epilepsia o asma sensible a la aspirina. En enfermedad del hígado o del riñón la dosis la decide el médico.",
  "Reacción grave: ante una erupción en la piel u otra señal de alergia, dejar de tomarlo y acudir al médico.",
  "Otros medicamentos: avisar al médico o al farmacéutico si se toman anticoagulantes orales (acenocumarol, warfarina), antiepilépticos, isoniazida, rifampicina, barbitúricos, colestiramina, furosemida, probenecid, sulfinpirazona, metoclopramida, domperidona, propranolol o flucloxacilina.",
  "Análisis: avisar antes de análisis de sangre u orina, porque puede alterar los resultados de ácido úrico y glucosa.",
  "Embarazo y lactancia: consultar antes. En el embarazo puede usarse si es necesario, con la dosis más baja posible y el menor tiempo posible. Pasa a la leche materna.",
  "Conducir y manejar máquinas: influencia nula o insignificante.",
  "Efectos adversos: raros, malestar, bajada de la tensión y aumento de transaminasas; muy raros, problemas de riñón, orina turbia, alergia en la piel, ictericia, alteraciones de la sangre y bajada del azúcar. Con dosis altas o tratamientos largos puede dañar el hígado. Se pueden comunicar en la web notificaram.es.",
  "Conservación: sin condiciones especiales. Fuera del alcance de los niños. No tirarlo a la basura ni por el desagüe: entregarlo en el punto SIGRE de la farmacia."
].join("\n");

// Lo que dice la caja del paracetamol. EDÍTALO si tu caja dice otra cosa.
const CAJA_PARACETAMOL = [
  "Nombre: Paracetamol 1 g comprimidos EFG (medicamento genérico).",
  "Vía oral.",
  "Indicación impresa en la caja: tratamiento sintomático del dolor de intensidad leve o moderada, como dolor muscular o de espalda, dolor de cabeza, dolor dental o dolor menstrual, y estados febriles.",
  "El nombre también está en braille en la parte delantera de la caja."
].join(" ");

async function referenciaPara(medicamento) {
  if (!medicamento || medicamento === "no indicado") return null;
  // Paracetamol: prospecto de 1 g incluido en el código (no depende de CIMA) más lo que dice la caja
  if (/^paracetamol$/i.test(String(medicamento).trim())) {
    return { nombre: "Paracetamol 1 g", texto: FICHA_RESPALDO_PARACETAMOL, secundarios: "", caja: CAJA_PARACETAMOL };
  }
  const r = await cargarReferencia(medicamento);
  if (r && r.texto) return r;
  if (/paracetamol/i.test(medicamento)) {
    return { nombre: "Paracetamol 1 g", texto: FICHA_RESPALDO_PARACETAMOL, secundarios: "", caja: CAJA_PARACETAMOL, respaldo: true };
  }
  return null;
}

function construirPrompt(medicamento, pregunta, ref) {
  const bloque = ref && ref.texto
    ? [
        "DATOS OFICIALES DE REFERENCIA de " + (ref.nombre ? "«" + ref.nombre + "»" : medicamento) + " (prospecto autorizado por la AEMPS):",
        ref.texto,
        ref.secundarios ? "Datos secundarios del envase:\n" + ref.secundarios : "",
        ref.caja ? "LO QUE DICE LA CAJA:\n" + ref.caja : "",
        "Responde con estos datos. Si lo que preguntan no aparece aquí, dilo con claridad y remite al prospecto o al farmacéutico. No lo completes con otros datos.",
        ""
      ].filter(function (x) { return x !== ""; }).join("\n") + "\n"
    : "No dispones del prospecto oficial de este medicamento: responde solo con información general y prudente, y remite al prospecto o al farmacéutico.\n";
  return [
    "Eres Oco, el asistente de voz de una etiqueta accesible para envases de medicamentos en España. Lo usan personas ciegas, mayores o que no leen bien, así que tus respuestas se leen en voz alta.",
    "Si preguntan quién eres, di que eres Oco, el asistente de la etiqueta. Medicamento de la etiqueta: " + medicamento + ".",
    "Pregunta de la persona: " + pregunta,
    "",
    bloque,
    "Reglas:",
    "1. Responde solo a preguntas relacionadas con medicamentos (el de la etiqueta u otros). Si la pregunta no tiene que ver con medicamentos, marca relacionada=false y en respuesta di con amabilidad que solo puedes ayudar con medicamentos.",
    "2. Si es sobre medicamentos, explica con el prospecto de referencia: para qué sirve, cómo se toma, contraindicaciones, precauciones, efectos adversos, interacciones, embarazo, conservación.",
    "3. Nunca pautes una dosis personalizada ni diagnostiques. En dudas de dosis para una persona concreta, niños, embarazo, lactancia, enfermedades previas o síntomas que preocupan, indica que lo consulte con su farmacéutico o su médico. Si parece una urgencia o una sobredosis, indica llamar al 112.",
    "4. Si no estás seguro de un dato, dilo y remite al prospecto o al farmacéutico. No inventes.",
    "5. Habla en español sencillo, con frases cortas, en un máximo de 50 palabras y con lo más importante primero, sin listas, sin símbolos, sin abreviaturas y sin markdown, porque se leerá en voz alta.",
    "6. En buscar_vademecum pon el nombre del medicamento por el que se pregunta (principio activo o marca), sin más texto. Si no hay medicamento, déjalo vacío.",
    "7. Puedes dar los datos de la caja que aparezcan en el bloque LO QUE DICE LA CAJA. Los datos de la caja que no aparezcan ahí (composición, contenido del envase, lote, fecha de caducidad, titular, código nacional) no los des: di que están impresos en la caja.",
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
              maxOutputTokens: 500
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
  // Diagnóstico: muestra qué prospecto ha encontrado la función para un medicamento.
  if (req.method === "GET" && req.query && req.query.diagnostico) {
    const med = String(req.query.medicamento || "paracetamol").trim().slice(0, 60);
    const r = await cargarReferencia(med);
    res.status(200).json({
      medicamento: med,
      nombre: r.nombre,
      nregistro: r.nregistro,
      prospecto: r.url,
      apartados_usados: r.apartados,
      caracteres: r.texto ? r.texto.length : 0,
      datos_secundarios: r.secundarios,
      inicio_del_texto: r.texto ? r.texto.slice(0, 300) : undefined,
      error: r.error
    });
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
    let ref = null;
    try { ref = await referenciaPara(medicamento); } catch (e) { ref = null; }
    const prompt = construirPrompt(medicamento, pregunta, ref);
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
