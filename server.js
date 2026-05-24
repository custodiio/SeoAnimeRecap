require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const OpenAI = require("openai");
const { toFile } = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require("child_process");
const jwt = require("jsonwebtoken");
const { registerUser, verifyUser, resetPassword } = require("./database");
const driveManager = require("./drive_manager");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERRO CRÍTICO: JWT_SECRET não foi configurado no arquivo .env!");
  process.exit(1);
}
const app = express();
const PORT = process.env.PORT || 3333;

// ─── Clientes de IA ───────────────────────────────────────────────────────────
// DeepSeek V3 — melhor custo-benefício para geração de texto
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "missing",
  baseURL: "https://api.deepseek.com",
});

// OpenAI GPT-4.1 — vision de frames
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing" });

// Google Gemini 2.0 Flash — vision de frames (barato e capaz)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "missing");
const geminiFlash = genAI.getGenerativeModel({
  model: "gemini-3.1-pro-preview",
});
// Google Imagen 3 — geração da thumbnail final
const imagen3 = genAI.getGenerativeModel({
  model: "gemini-3-pro-image-preview",
});

// ─── Diretórios ───────────────────────────────────────────────────────────────
["uploads", "output", "output/specs", "public/extracted"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));
app.use(express.static("public"));
app.use("/extracted", express.static("public/extracted"));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function limparJson(raw) {
  return raw
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
}

function buildDallePrompt(spec) {
  let prompt = "An anime-style thumbnail. ";
  
  if (spec.metadata && spec.metadata.anime) {
    prompt += `Subject: anime "${spec.metadata.anime}". `;
  }
  
  if (spec.template) {
    prompt += `Layout style: ${spec.template}. `;
  }
  
  if (spec.paleta) {
    const paletaNome = typeof spec.paleta === 'object' ? spec.paleta.nome : spec.paleta;
    prompt += `Color palette: ${paletaNome}. `;
  }

  // Extract texts
  if (spec.camadas && spec.camadas.length > 0) {
    const textLayers = spec.camadas.filter(l => l.tipo === 'texto');
    if (textLayers.length > 0) {
      prompt += "Include bold text: " + textLayers.map(l => `"${l.conteudo}"`).join(", ") + ". ";
    }
  }

  prompt += "High quality anime key visual, dramatic lighting, clean composition, vivid colors, viral YouTube thumbnail style, no watermarks.";
  return prompt;
}

function extrairFrames(
  videoPath,
  start,
  end,
  sessaoId,
  papelId,
  numFrames = 6,
  duracaoMaxima = 999999,
) {
  return new Promise(async (resolve) => {
    // Garantir que não vamos tentar buscar além do fim do vídeo
    const s = Math.min(start, Math.max(0, duracaoMaxima - 2));
    const e = Math.min(end, Math.max(0.5, duracaoMaxima - 0.5));

    const duracao = Math.max(e - s, 0.5);
    const intervalo = duracao / (numFrames + 1);
    const timestamps = Array.from(
      { length: numFrames },
      (_, i) => parseFloat((s + intervalo * (i + i)).toFixed(2)), // Fix: spread the interval
    );

    // Recalcular certinho pra evitar timestamps duplicados
    const tsList = [];
    for (let i = 1; i <= numFrames; i++) {
      tsList.push(parseFloat((s + intervalo * i).toFixed(2)));
    }

    const dir = `public/extracted/${sessaoId}/${papelId}`;
    fs.mkdirSync(dir, { recursive: true });

    const extraidos = [];

    if (!tsList.length) return resolve([]);

    // Processar sequencialmente para evitar sobrecarga (15 ffmpegs simultâneos derruba o processo)
    for (let idx = 0; idx < tsList.length; idx++) {
      const ts = tsList[idx];
      const filename = `frame_${String(idx + 1).padStart(2, "0")}_t${ts.toFixed(1)}s.jpg`;
      const outputPath = path.join(dir, filename);
      const urlPath = `/extracted/${sessaoId}/${papelId}/${filename}`;

      await new Promise((res) => {
        ffmpeg(videoPath)
          .seekInput(ts)
          .frames(1)
          .size("1280x720")
          .output(outputPath)
          .on("end", () => {
            extraidos.push({
              idx: idx + 1,
              timestamp: ts,
              url: urlPath,
              path: outputPath,
            });
            res();
          })
          .on("error", (err) => {
            console.error(`❌ Ffmpeg erro ao extrair t=${ts}:`, err.message);
            res(); // Continua pro próximo mesmo se der erro num frame
          })
          .run();
      });
    }

    resolve(extraidos.sort((a, b) => a.idx - b.idx));
  });
}

// ─── Autenticação ─────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "Usuário, E-mail e senha são obrigatórios" });
    
    const approvedUser = process.env.APPROVED_USERS;
    if (approvedUser && username !== approvedUser) {
      return res.status(403).json({ error: "Você não tem permissão para se cadastrar neste sistema." });
    }

    const user = await registerUser(username, email, password);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Usuário, E-mail e Nova Senha são obrigatórios" });
    }
    
    const result = await resetPassword(username, email, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await verifyUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Acesso negado. Token não fornecido." });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido ou expirado." });
    req.user = user;
    next();
  });
}

// ─── Dispatcher de Modelos ──────────────────────────────────────────────────
async function callAI(prompt, config, imageBase64 = null) {
  const provider = config?.provider || "deepseek";
  // O fallback abaixo é para os nomes de modelo de cada provedor
  let defaultModelStr = "deepseek-chat";
  if (provider === "google") defaultModelStr = "gemini-3.1-pro-preview";
  if (provider === "openai") defaultModelStr = "gpt-4o";
  const modelStr = config?.model || defaultModelStr;
  
  if (provider === "deepseek") {
    const completion = await deepseek.chat.completions.create({
      model: modelStr,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 8192,
    });
    return completion.choices[0].message?.content || completion.choices[0].message?.reasoning_content || "";
  }
  
  if (provider === "openai") {
    const messages = [{ role: "user", content: prompt }];
    if (imageBase64) {
      messages[0] = {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      };
    }
    const completion = await openai.chat.completions.create({
      model: modelStr,
      messages: messages,
      temperature: 0.7
    });
    return completion.choices[0].message.content || "";
  }
  
  if (provider === "google") {
    const model = genAI.getGenerativeModel({ model: modelStr });
    let result;
    if (imageBase64) {
      result = await model.generateContent([
        { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
        prompt
      ]);
    } else {
      result = await model.generateContent(prompt);
    }
    return result.response.text();
  }
  
  throw new Error(`Provedor desconhecido: ${provider}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 0 — Sincronizar Arquivos do Google Drive
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/sync-drive", authMiddleware, async (req, res) => {
  try {
    console.log("☁️ Iniciando sincronização do Google Drive...");
    
    // Caminhos padrão no Drive
    const pathIdAnime = "KAGGLE/AUDIO_DUB/identificacao_anime.json";
    const pathTraducao = "KAGGLE/AUDIO_DUB/traducao_simplificada.json";
    const pathVideo = "KAGGLE/PIPELINE/ATIVO/video_original.mp4";

    // Caminhos locais
    const localIdAnime = path.join(__dirname, "uploads", "identificacao_anime.json");
    const localTraducao = path.join(__dirname, "uploads", "traducao_simplificada.json");
    
    // Para o vídeo, usamos um UUID no nome para evitar colisões
    const videoFileName = `${uuidv4()}_video_original.mp4`;
    const localVideo = path.join(__dirname, "uploads", videoFileName);

    // Downloads simultâneos (ou sequenciais se preferir segurança)
    await driveManager.downloadFile(pathIdAnime, localIdAnime);
    await driveManager.downloadFile(pathTraducao, localTraducao);
    await driveManager.downloadFile(pathVideo, localVideo);

    // Ler os arquivos JSON salvos
    const identificacaoStr = fs.readFileSync(localIdAnime, "utf-8");
    const traducaoStr = fs.readFileSync(localTraducao, "utf-8");

    let identificacao, traducao;
    try { identificacao = JSON.parse(identificacaoStr); } catch(e) { throw new Error("identificacao_anime.json inválido no Drive"); }
    try { traducao = JSON.parse(traducaoStr); } catch(e) { throw new Error("traducao_simplificada.json inválido no Drive"); }

    res.json({
      success: true,
      identificacao,
      traducao,
      video_path: localVideo
    });

  } catch (err) {
    console.error("❌ sync-drive:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 1 — Guia de Postagem
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/generate-guide", authMiddleware, async (req, res) => {
  try {
    const { roteiro, identificacao } = req.body;
    if (!roteiro || !identificacao)
      return res
        .status(400)
        .json({ error: "roteiro e identificacao são obrigatórios" });

    const narrativa = roteiro
      .filter((s) => s.tipo === "NARRACAO" && s.translated_text)
      .map((s) => s.translated_text)
      .join(" ");

    const prompt = `Você é o Kuma, dono do canal "Kuma Recap" no YouTube. Você cria roteiros e descrições para resumos de animes de forma carismática, engajante e focada em instigar o público a interagir nos comentários e deixar o like.
Seu estilo é dinâmico, direto, e você sempre conversa com sua "alcateia" ou "família Kuma".

ANIME: ${identificacao.title} (${identificacao.title_jp})
PROTAGONISTA: ${identificacao.protagonist}
PERSONAGENS: ${identificacao.characters.join(", ")}
SINOPSE: ${identificacao.synopsis}
NARRAÇÃO: ${narrativa}

Retorne SOMENTE JSON válido, sem markdown, sem explicações, com a seguinte estrutura:
{
  "titulo_principal": "título hook MÁXIMO — drama, curiosidade, spoiler velado. Se tiver o título do anime, inclua. Ex: ELE ESTAVA MORTO... MAS VOLTOU COM TUDO! | ${identificacao.title} EP X",
  "titulos_alternativos": ["alt 1", "alt 2", "alt 3"],
  "descricao": "NÃO resuma o vídeo. Crie algo instigante. Comece com uma pergunta provocativa sobre o episódio para gerar comentários. Formato Kuma Recap:\\n1. Hook/Pergunta bombástica envolvendo o episódio!\\n2. Call to Action forte para a Família Kuma se inscrever no canal e deixar o like.\\n3. Breve comentário pessoal (como o Kuma) sobre o momento épico.\\n4. Timestamps.",
  "hashtags_youtube": ["#KumaRecap", "#${identificacao.title.replace(/\\s+/g, "")}", "INCLUIR EXATAMENTE 15 HASHTAGS RELEVANTES AO ANIME E AO CANAL"],
  "tags_youtube": "kuma recap, ${identificacao.title}, anime recap, resumo de anime, ...",
  "capitulos": [{"tempo": "0:00", "titulo": "🔥 Intro"}, {"tempo": "0:45", "titulo": "..."}],
  "cards_sugeridos": [{"tempo": "1:30", "texto": "Veja o episódio anterior!"}],
  "momento_gancho_thumbnail": "descrição do momento mais explosivo com timestamp",
  "call_to_action_video": "CTA estilo Kuma Recap para pedir no vídeo: like, inscrição e um comentário para a alcateia",
  "call_to_action_descricao": "CTA para a descrição focada em inscrição",
  "categoria": "Entretenimento",
  "audiencia_alvo": "fãs de anime 15-28 anos que acompanham resumos do canal Kuma Recap",
  "melhor_horario_postagem": "Sexta 18h ou Sábado 14h (horário de Brasília)",
  "analise_emocional": "3 linhas sobre os picos emocionais do episódio",
  "score_viral": 87,
  "tiktok_guia": "[Crie um título hook curto e chamativo instigando a comentar, ex: 'Você aceitaria esse pacto? 😳']\\n\\nTitulo: ${identificacao.title}\\n\\nSinopse: [Traduza a sinopse '${identificacao.synopsis.replace(/"/g, '\\"')}' para português de forma super envolvente]\\n\\n#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5",
  "instagram_hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"]
}`;

    const content = await callAI(prompt, req.body.modelConfig);
    if (!content.trim())
      throw new Error("A API retornou um conteúdo vazio mesmo após aguardar.");

    const guia = JSON.parse(limparJson(content));

    const specFile = `output/guia_postagem_${Date.now()}.json`;
    if (!fs.existsSync("output")) fs.mkdirSync("output", { recursive: true });
    fs.writeFileSync(specFile, JSON.stringify(guia, null, 2));

    // Upload pro Drive assíncrono para o kaggle/pipeline/final
    driveManager.uploadFileToPath(specFile, 'kaggle/pipeline/final', 'guia_postagem.json', 'application/json')
      .catch(e => console.error("Erro no upload do guia pro Drive:", e));

    res.json({ success: true, guia });
  } catch (err) {
    console.error("❌ generate-guide:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 2 — Análise do Roteiro + Templates
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/analyze-script", authMiddleware, async (req, res) => {
  try {
    const { roteiro, identificacao } = req.body;

    const narrativa = roteiro
      .filter((s) => s.translated_text && s.translated_text.trim())
      .map(
        (s) =>
          `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.translated_text}`,
      )
      .join("\n");

    const prompt = `Você é diretor criativo de thumbnails virais de YouTube para anime.
Analise o roteiro e escolha os TOP 3 templates de capa, identificando janelas de frames a extrair.

ANIME: ${identificacao.title} | PROTAGONISTA: ${identificacao.protagonist}
PERSONAGENS: ${identificacao.characters.join(", ")}

REGRAS OBRIGATÓRIAS PARA EXTRAÇÃO DE CENA:
- Para cada "papel_id" necessário, você DEVE fornecer exatamente 2 janelas de tempo DISTINTAS.
- Exemplo: Se o personagem é o Herói, ache a cena X dele no começo (ex: 1s-5s) e a cena Y dele no final (ex: 120s-130s).
- Isso garante que se um frame estiver ruim na primeira cena, teremos a segunda cena como backup.

ROTEIRO (timestamps em segundos):
${narrativa}

TEMPLATES DISPONÍVEIS:
- HEROI_REACAO: herói em pose épica + personagem reagindo chocado + texto de impacto
- TENSAO_DUAL: dois personagens em confronto lado a lado (A vs B)
- OVER_POWERED: personagem com poder máximo + texto "MODO DEUS" / "NV +999"
- STRIP_REACOES: 3 expressões faciais diferentes lado a lado
- VIRADA_NARRATIVA: frame do twist + rosto surpreso + texto dramático

Retorne SOMENTE JSON válido:
{
  "templates_recomendados": [
    {
      "template": "HEROI_REACAO",
      "score": 95,
      "justificativa": "2 linhas explicando por que este template é ideal para este episódio",
      "texto_capa": "ELE CONSEGUIU!",
      "subtexto": "O sem magia que venceu o impossível",
      "paleta": "dark_gold",
      "frames_necessarios": [
        {
          "papel_id": "hero",
          "papel_descricao": "Herói em momento de triunfo ou determinação",
          "personagem": "Will Serfort",
          "janelas_tempo": [
            {"inicio": 4.0, "fim": 9.0},
            {"inicio": 120.0, "fim": 130.0}
          ],
          "emocao_buscada": "determinação épica, olhar intenso",
          "dica_frame": "buscar expressão com olhar determinado, enquadramento próximo do rosto"
        },
        {
          "papel_id": "reaction",
          "papel_descricao": "Personagem reagindo com choque",
          "personagem": "Edward / Plateia",
          "janelas_tempo": [
            {"inicio": 45.0, "fim": 50.0},
            {"inicio": 165.0, "fim": 178.0}
          ],
          "emocao_buscada": "choque, boca aberta, olhos arregalados",
          "dica_frame": "expressão exagerada de surpresa"
        }
      ]
    }
  ],
  "pico_narrativo": {
    "timestamp_inicio": 164.0,
    "timestamp_fim": 178.0,
    "descricao": "Anúncio épico do diretor que Will pode entrar na torre",
    "emocao": "virada total"
  },
  "emocao_dominante": "superação épica",
  "resumo_para_thumbnail": "2-3 linhas do arco emocional do episódio"
}`;

    const content = await callAI(prompt, req.body.modelConfig);
    if (!content.trim())
      throw new Error("A API retornou um conteúdo vazio mesmo após aguardar.");

    const analise = JSON.parse(limparJson(content));
    res.json({ success: true, analise });
  } catch (err) {
    console.error("❌ analyze-script:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 3 — Extração de Frames do Vídeo (ffmpeg)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/extract-frames", authMiddleware, upload.single("video"), async (req, res) => {
  try {
    const videoPath = req.file ? req.file.path : req.body.video_path;
    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(400).json({ error: "Vídeo obrigatório. Envie o arquivo ou o video_path do Drive." });
    }

    const { frames_config } = req.body;
    if (!frames_config)
      return res.status(400).json({ error: "frames_config é obrigatório." });

    const config = JSON.parse(frames_config);
    const sessaoId = uuidv4();

    // Descobrir a duração real do vídeo para evitar buscar frames que não existem
    let duracaoTotal = 999999;
    await new Promise((resolveProbe) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (!err && metadata && metadata.format && metadata.format.duration) {
          duracaoTotal = metadata.format.duration;
        }
        resolveProbe();
      });
    });

    console.log(
      `🎬 Extraindo frames — sessão ${sessaoId} — Vídeo de ${duracaoTotal}s`,
    );

    const resultados = [];
    for (const papel of config) {
      console.log(
        `  → [${papel.papel_id}] Extraindo de ${(papel.janelas_tempo || []).length} janelas de tempo`,
      );

      let allFrames = [];
      const janelas = papel.janelas_tempo || [];

      // Retrocompatibilidade caso o json venha com timestamp antigo
      if (janelas.length === 0 && papel.timestamp_inicio) {
        janelas.push({
          inicio: papel.timestamp_inicio,
          fim: papel.timestamp_fim,
        });
      }

      // Se há múltiplas janelas, queremos extrair 15 frames EXATOS de CADA janela.
      // Ou seja, se a IA indicou 2 janelas, o usuário vai ter 30 frames para escolher!
      const framesPorJanela = 15;

      for (const janela of janelas) {
        const frms = await extrairFrames(
          videoPath,
          janela.inicio,
          janela.fim,
          sessaoId,
          papel.papel_id,
          framesPorJanela,
          duracaoTotal,
        );
        allFrames = allFrames.concat(frms);
      }

      // Ordenar cronologicamente e reajustar IDs
      allFrames.sort((a, b) => a.timestamp - b.timestamp);
      allFrames.forEach((f, idx) => (f.idx = idx + 1));

      resultados.push({
        ...papel,
        frames_extraidos: allFrames,
        total: allFrames.length,
      });
    }

    res.json({
      success: true,
      sessao_id: sessaoId,
      video_path: videoPath,
      resultados,
    });
  } catch (err) {
    console.error("❌ extract-frames:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 4 — Análise Vision de Frame
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/analyze-frame", authMiddleware, async (req, res) => {
  try {
    const { frame_path, papel_id, papel_descricao, template, emocao_buscada } =
      req.body;
    if (!frame_path)
      return res.status(400).json({ error: "frame_path é obrigatório." });

    const resolvedPath = frame_path.startsWith("/")
      ? `public${frame_path}`
      : frame_path;
    if (!fs.existsSync(resolvedPath))
      return res
        .status(404)
        .json({ error: `Frame não encontrado: ${resolvedPath}` });

    const imageData = fs.readFileSync(resolvedPath).toString("base64");

    const prompt = `Você é especialista em composição visual de thumbnails virais de YouTube para anime.
Analise este frame e avalie seu potencial para o papel "${papel_id}" no template "${template}".
Papel: ${papel_descricao} | Emoção buscada: ${emocao_buscada || "qualquer"}

Retorne SOMENTE JSON válido:
{
  "aprovado": true,
  "score_visual": 8,
  "score_emocao": 9,
  "score_geral": 85,
  "personagens_detectados": [{"nome": "Will Serfort", "posicao": "centro", "emocao": "determinação", "expressao": "olhar intenso"}],
  "composicao": {"cores_dominantes": ["#1a2b3c", "#f5c518"], "iluminacao": "dramática", "enquadramento": "plano médio"},
  "crop_recomendado": {"x_pct": 5, "y_pct": 0, "w_pct": 90, "h_pct": 100, "justificativa": "Remove bordas escuras"},
  "ajustes": {"brilho": 1.1, "contraste": 1.25, "saturacao": 1.3, "nitidez": 1.1},
  "pontos_fortes": ["expressão intensa", "iluminação dramática"],
  "pontos_fracos": ["leve desfoque"],
  "recomendacao": "Excelente frame — expressão de triunfo bem definida"
}`;

    const content = await callAI(prompt, req.body.modelConfig, imageData);

    const analise = JSON.parse(limparJson(content));
    res.json({ success: true, frame_path, analise });
  } catch (err) {
    console.error("❌ analyze-frame:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 5 — Gerar Spec JSON da Thumbnail
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/generate-thumbnail-spec", authMiddleware, async (req, res) => {
  try {
    const { template, template_obj, frames_selecionados, analise_roteiro, identificacao } =
      req.body;

    const textoPrincipal = template_obj?.texto_capa || "TEXTO PRINCIPAL";
    const subtexto = template_obj?.subtexto || "";
    const paleta = template_obj?.paleta || "dark_purple";

    const prompt = `Você é diretor de arte de thumbnails virais de YouTube para anime.
Gere o SPEC JSON de composição para renderização com Python/Pillow.

TEMPLATE: ${template} | ANIME: ${identificacao?.title || "Anime"}
TEXTO CAPA: "${textoPrincipal}" | SUBTEXTO: "${subtexto}"
PALETA DE CORES DEFINIDA: "${paleta}"
FRAMES ANALISADOS: ${JSON.stringify(frames_selecionados, null, 2)}
CONTEXTO: ${analise_roteiro?.resumo_para_thumbnail || ""}

Regras por template:
- HEROI_REACAO: hero_frame ocupa 65% esquerda, reaction_frame 35% direita sobreposto
- TENSAO_DUAL: dois frames lado a lado separados por linha de tensão central
- OVER_POWERED: frame central com efeitos de aura e energia irradiando
- STRIP_REACOES: 3 frames em coluna vertical à direita, texto à esquerda
- VIRADA_NARRATIVA: frame grande com texto dramático sobreposto e seta ou relâmpago

Instruções de Inteligência e Adaptação dos Frames:
- A Paleta de Cores deve ser rigorosamente respeitada. Adapte as cores da camada "bg" e os efeitos visuais (ex: cores de borda, textos, gradientes) para utilizar os códigos Hexadecimais corretos que correspondam visualmente à paleta solicitada ("${paleta}").
- Contorne falhas nos frames: se o frame selecionado não tiver o personagem exato, adapte o foco para o elemento principal da cena.
- Remoção de distrações: instrua a IA a remover personagens secundários ou expressões calmas que distoem da dramaticidade.
- Recortes em vez de "quadradões": prefira indicar recortes focados apenas na silhueta/corpo do personagem principal, removendo fundos inúteis.
- Emoções, Poses e Ajustes: instrua a modificação de reações e poses se o frame for apático. Indique a adição de pequenos detalhes nas bordas se o frame estiver levemente cortado.

Retorne SOMENTE JSON válido com esta estrutura:
{
  "spec_version": "2.0",
  "template": "${template}",
  "paleta": "${paleta}",
  "canvas": {"width": 1280, "height": 720},
  "camadas": [
    {"id": "bg", "tipo": "gradiente", "ordem": 1, "cores": ["#COR_HEX1", "#COR_HEX2"], "direcao": "diagonal"},
    {"id": "hero_frame", "tipo": "imagem_frame", "ordem": 2, "papel_id": "hero",
      "posicao_canvas": {"x": 0, "y": 0, "w": 830, "h": 720},
      "crop": {"x_pct": 5, "y_pct": 0, "w_pct": 85, "h_pct": 100},
      "ajustes": {"brilho": 1.1, "contraste": 1.25, "saturacao": 1.3},
      "efeito_borda": "fade_right"},
    {"id": "texto_principal", "tipo": "texto", "ordem": 5,
      "conteudo": "${textoPrincipal}",
      "posicao_canvas": {"x": 820, "y": 60, "w": 430, "h": 160},
      "fonte": {"familia": "Impact", "tamanho": 78, "peso": "black"},
      "cor_texto": "#FFD700",
      "outline": {"cor": "#000000", "espessura": 5},
      "sombra": {"cor": "#000000", "x": 4, "y": 4, "blur": 10}},
    {"id": "subtexto", "tipo": "texto", "ordem": 6,
      "conteudo": "${subtexto}",
      "posicao_canvas": {"x": 820, "y": 230, "w": 430, "h": 90},
      "fonte": {"familia": "Arial Black", "tamanho": 26, "peso": "bold"},
      "cor_texto": "#FFFFFF",
      "outline": {"cor": "#000000", "espessura": 3}}
  ],
  "efeitos_globais": {"vignette": 0.35, "color_grade": "dramatic_dark"},
  "paleta": {"nome": "dark_gold", "primaria": "#FFD700", "secundaria": "#FF6B35", "fundo": "#0a0a1a"},
  "export": {"formato": "PNG", "qualidade": 95, "resolucao": "1280x720"},
  "metadata": {"anime": "${identificacao?.title || ""}", "template": "${template}", "gerado_em": "${new Date().toISOString()}"}
}`;

    const content = await callAI(prompt, req.body.modelConfig);
    if (!content.trim())
      throw new Error("A API retornou um conteúdo vazio mesmo após aguardar.");

    const spec = JSON.parse(limparJson(content));

    const specFile = `output/specs/spec_${Date.now()}.json`;
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));

    res.json({ success: true, spec, spec_file: specFile });
  } catch (err) {
    console.error("❌ generate-thumbnail-spec:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 5.1 — Gerar Spec JSON da Thumbnail (TikTok 3:4)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/generate-tiktok-spec", authMiddleware, async (req, res) => {
  try {
    const { template, template_obj, frames_selecionados, analise_roteiro, identificacao } =
      req.body;

    const textoPrincipal = template_obj?.texto_capa || "TEXTO PRINCIPAL";
    const subtexto = template_obj?.subtexto || "";
    const paleta = template_obj?.paleta || "dark_purple";

    const prompt = `Você é diretor de arte de thumbnails virais para TikTok (formato 3:4) de anime.
Gere o SPEC JSON de composição para renderização com Python/Pillow.

TEMPLATE: ${template} | ANIME: ${identificacao?.title || "Anime"}
TEXTO CAPA: "${textoPrincipal}" | SUBTEXTO: "${subtexto}"
PALETA DE CORES DEFINIDA: "${paleta}"
FRAMES ANALISADOS: ${JSON.stringify(frames_selecionados, null, 2)}
CONTEXTO: ${analise_roteiro?.resumo_para_thumbnail || ""}

Regras por template (ADAPTADAS PARA 3:4 - VERTICAL/QUADRADO ALTO):
- HEROI_REACAO: hero_frame em cima, reaction_frame embaixo, com divisão na diagonal.
- TENSAO_DUAL: dois frames um em cima do outro separados por linha de tensão horizontal.
- OVER_POWERED: frame central grande com efeitos de aura vertical.
- STRIP_REACOES: 3 frames em coluna vertical.
- VIRADA_NARRATIVA: frame grande vertical com texto dramático sobreposto.

Instruções de Inteligência e Adaptação dos Frames:
- A Paleta de Cores deve ser rigorosamente respeitada. Adapte as cores usando os códigos Hexadecimais corretos.
- Contorne falhas nos frames: se o frame não for perfeito, foque no elemento principal da cena.
- Remoção de distrações: instrua a remoção de elementos de fundo inúteis.
- Recortes em vez de "quadradões": prefira recortes focados na silhueta.

Retorne SOMENTE JSON válido com esta estrutura:
{
  "spec_version": "2.0",
  "template": "${template}",
  "paleta": "${paleta}",
  "canvas": {"width": 1080, "height": 1440},
  "camadas": [
    {"id": "bg", "tipo": "gradiente", "ordem": 1, "cores": ["#COR_HEX1", "#COR_HEX2"], "direcao": "vertical"},
    {"id": "hero_frame", "tipo": "imagem_frame", "ordem": 2, "papel_id": "hero",
      "posicao_canvas": {"x": 0, "y": 0, "w": 1080, "h": 800},
      "crop": {"x_pct": 10, "y_pct": 0, "w_pct": 80, "h_pct": 100},
      "ajustes": {"brilho": 1.1, "contraste": 1.25, "saturacao": 1.3},
      "efeito_borda": "fade_bottom"},
    {"id": "texto_principal", "tipo": "texto", "ordem": 5,
      "conteudo": "${textoPrincipal}",
      "posicao_canvas": {"x": 50, "y": 900, "w": 980, "h": 200},
      "fonte": {"familia": "Impact", "tamanho": 100, "peso": "black"},
      "cor_texto": "#FFD700",
      "outline": {"cor": "#000000", "espessura": 8},
      "sombra": {"cor": "#000000", "x": 4, "y": 4, "blur": 15}}
  ],
  "efeitos_globais": {"vignette": 0.40, "color_grade": "dramatic_dark"},
  "paleta": {"nome": "dark_gold", "primaria": "#FFD700", "secundaria": "#FF6B35", "fundo": "#0a0a1a"},
  "export": {"formato": "PNG", "qualidade": 95, "resolucao": "1080x1440"},
  "metadata": {"anime": "${identificacao?.title || ""}", "template": "${template}", "gerado_em": "${new Date().toISOString()}"}
}`;

    const content = await callAI(prompt, req.body.modelConfig);
    if (!content.trim())
      throw new Error("A API retornou um conteúdo vazio mesmo após aguardar.");

    const spec = JSON.parse(limparJson(content));

    const specFile = `output/specs/tiktok_spec_${Date.now()}.json`;
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));

    res.json({ success: true, spec, spec_file: specFile });
  } catch (err) {
    console.error("❌ generate-tiktok-spec:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 6 — Gerar Thumbnail Final (IA)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/generate-thumbnail", authMiddleware, async (req, res) => {
  try {
    const { spec, frames_selecionados } = req.body;
    if (!spec) return res.status(400).json({ error: "spec é obrigatório." });

    console.log("📸 [API/generate-thumbnail] Recebido pedido para gerar capa.");
    console.log("   -> Spec template:", spec.template, "canvas:", spec.canvas);
    console.log("   -> Frames selecionados recebidos:", JSON.stringify(frames_selecionados));

    // Lendo os frames como Base64 para enviar pra IA (Gemini) e Uploadable (OpenAI)
    const imageParts = [];
    const imagesForOpenAI = [];
    if (frames_selecionados && frames_selecionados.length > 0) {
      for (const f of frames_selecionados) {
        const p = f.path;
        const exists = p && fs.existsSync(p);
        console.log(`   -> Frame ${f.papel_id} | Path: ${p} | Existe no disco? ${exists}`);
        if (p && exists) {
          const b64 = fs.readFileSync(p).toString("base64");
          imageParts.push({
            inlineData: { data: b64, mimeType: "image/jpeg" },
          });
          
          try {
            const fileStream = fs.createReadStream(p);
            const name = path.basename(p);
            const uploadable = await toFile(fileStream, name, { type: "image/jpeg" });
            imagesForOpenAI.push(uploadable);
          } catch (errOpenAIFile) {
            console.error(`❌ Erro ao converter frame para formato OpenAI toFile:`, errOpenAIFile.message);
          }
        }
      }
    }
    console.log(`   -> Total de imageParts anexados (Gemini): ${imageParts.length}`);
    console.log(`   -> Total de imagesForOpenAI prontos (OpenAI): ${imagesForOpenAI.length}`);

    const promptText = `
Você é um diretor de arte. Gere a arte final da thumbnail do YouTube baseada nos frames fornecidos e neste SPEC JSON de composição:
${JSON.stringify(spec, null, 2)}

**ANÁLISE PRÉVIA DOS FRAMES (USE ISSO PARA SABER O QUE CORRIGIR):**
${JSON.stringify(frames_selecionados.map(f => ({
  papel: f.papel_id,
  analise_vision: f.analise // ou o objeto que contiver os dados no seu frontend
})), null, 2)}

Instruções:
- Utilize os frames fornecidos como base criativa, mas seja muito inteligente na adaptação.
- Contorne falhas nos frames: se o frame não mostrar a imagem perfeita, adapte e use o elemento mais em foco.
- Isole os elementos: não use recortes "quadradões". Faça um recorte inteligente, focando apenas no personagem.
- Remova distrações: se houver personagens de fundo, calmos ou indesejados que distoem da cena dramática, remova-os completamente.
- Adicione detalhes: se o personagem do frame estiver com alguma parte cortada nas bordas, adicione pequenos detalhes para preencher o que falta.
- Emoções e Poses: você tem total liberdade para mudar poses, criar novas reações faciais e alterar emoções para deixá-las dramáticas e impactantes, caso o frame base seja apático.
- Aplique o texto, cores, fontes e estilo exatos definidos no JSON.
- A imagem deve ter qualidade ultra-dramática, estilo anime, proporção 16:9.
- Sem marcas d'água.
`;

    const imgConfig = req.body.modelConfig || { provider: "google", model: "gemini-3-pro-image-preview" };
    
    let saved = [];
    
    const isVertical = spec.canvas && spec.canvas.height > spec.canvas.width;
    const dalleSize = isVertical ? "1024x1792" : "1792x1024";

    // Tenta Google primeiro (se google estiver no config ou for default) ou OpenAI direto
    if (imgConfig.provider === "openai") {
      try {
        const modelName = imgConfig.model || "gpt-image-2";
        const dallePrompt = buildDallePrompt(spec);
        console.log("   -> Prompt enviado para OpenAI:", dallePrompt);

        let response;
        if (modelName === "gpt-image-2" && imagesForOpenAI.length > 0) {
          console.log(`   -> Chamando openai.images.edit com gpt-image-2 e ${imagesForOpenAI.length} referências...`);
          response = await openai.images.edit({
            model: modelName,
            image: imagesForOpenAI.length === 1 ? imagesForOpenAI[0] : imagesForOpenAI,
            prompt: dallePrompt,
            n: 1,
            size: dalleSize
          });
        } else {
          console.log(`   -> Chamando openai.images.generate com modelo ${modelName}...`);
          const reqOpts = {
            model: modelName,
            prompt: dallePrompt,
            n: 1,
            size: dalleSize
          };
          
          if (modelName === "dall-e-3" || modelName === "dall-e-2") {
            reqOpts.response_format = "b64_json";
            if (modelName === "dall-e-3") {
              reqOpts.quality = "hd";
            }
          }
          response = await openai.images.generate(reqOpts);
        }
        
        let buffer;
        if (response.data[0].b64_json) {
          buffer = Buffer.from(response.data[0].b64_json, "base64");
        } else if (response.data[0].url) {
          const imgRes = await fetch(response.data[0].url);
          buffer = Buffer.from(await imgRes.arrayBuffer());
        } else {
          throw new Error("A API não retornou b64_json nem URL.");
        }
        
        const filename = `thumbnail_openai_${Date.now()}.png`;
        const filepath = `output/${filename}`;
        fs.writeFileSync(filepath, buffer);
        saved.push({ url: `/output-img/${filename}`, path: filepath });
      } catch (e) {
        throw new Error("Falha ao gerar imagem com OpenAI: " + e.message);
      }
    } else {
      // Flow padrão com fallback
      const imgModelStr = imgConfig.model || "gemini-3-pro-image-preview";
      const imgModel = genAI.getGenerativeModel({ model: imgModelStr });

      const ensureOutputDir = () => {
        if (!fs.existsSync("output")) fs.mkdirSync("output", { recursive: true });
      };
      ensureOutputDir();

      try {
        const result = await imgModel.generateContent([promptText, ...imageParts]);
        const responsePart = result?.response?.candidates?.[0]?.content?.parts?.[0];

        if (responsePart && responsePart.inlineData) {
          const filename = `thumbnail_ai_${Date.now()}.png`;
          const filepath = `output/${filename}`;
          const base64Data = responsePart.inlineData.data;
          fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
          saved.push({ url: `/output-img/${filename}`, path: filepath });
        } else {
          throw new Error("SDK não retornou bytes binários na resposta do generateContent");
        }
      } catch (imgErr) {
        console.warn("⚠️ Falha na geração com Imagen 3, iniciando Fallback com gpt-image-2 da OpenAI...", imgErr.message);
        const fallbackPrompt = buildDallePrompt(spec);
        console.log("   -> [Fallback OpenAI] Prompt enviado:", fallbackPrompt);

        let response;
        if (imagesForOpenAI.length > 0) {
          console.log(`   -> [Fallback] Chamando openai.images.edit com gpt-image-2 e ${imagesForOpenAI.length} referências...`);
          response = await openai.images.edit({
            model: "gpt-image-2",
            image: imagesForOpenAI.length === 1 ? imagesForOpenAI[0] : imagesForOpenAI,
            prompt: fallbackPrompt,
            n: 1,
            size: dalleSize
          });
        } else {
          console.log(`   -> [Fallback] Chamando openai.images.generate com gpt-image-2...`);
          response = await openai.images.generate({
            model: "gpt-image-2",
            prompt: fallbackPrompt,
            n: 1,
            size: dalleSize
          });
        }
        
        let buffer;
        if (response.data[0].b64_json) {
          buffer = Buffer.from(response.data[0].b64_json, "base64");
        } else if (response.data[0].url) {
          const imgRes = await fetch(response.data[0].url);
          buffer = Buffer.from(await imgRes.arrayBuffer());
        }

        const filename = `thumbnail_fallback_${Date.now()}.png`;
        const filepath = `output/${filename}`;
        fs.writeFileSync(filepath, buffer);
        saved.push({ url: `/output-img/${filename}`, path: filepath });
      }
    }

    // Fazer o upload de cada imagem gerada (YouTube ou TikTok)
    const driveName = isVertical ? 'thumbnail_tiktok.png' : 'thumbnail_youtube.png';
    for (const img of saved) {
      if (img.path) {
        driveManager.uploadFileToPath(img.path, 'kaggle/pipeline/final', driveName, 'image/png')
          .catch(e => console.error("Erro no upload da capa pro Drive:", e));
      }
    }

    return res.json({
      success: true,
      images: saved,
    });
  } catch (err) {
    console.error("❌ generate-thumbnail:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA 7 — Limpar Arquivos da Sessão (Cleanup)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/cleanup-session", authMiddleware, async (req, res) => {
  try {
    const { sessao_id, video_path, spec_file, images } = req.body;
    let removidos = 0;

    // Remover vídeo
    if (video_path && fs.existsSync(video_path)) {
      fs.unlinkSync(video_path);
      removidos++;
    }

    // Remover pasta de extração de frames
    if (sessao_id) {
      const extractDir = path.join("public", "extracted", sessao_id);
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        removidos++;
      }
    }

    // Remover spec file
    if (spec_file && fs.existsSync(spec_file)) {
      fs.unlinkSync(spec_file);
      removidos++;
    }

    // Remover imagens geradas
    if (images && images.length > 0) {
      images.forEach((img) => {
        if (img.path && fs.existsSync(img.path)) {
          fs.unlinkSync(img.path);
          removidos++;
        }
      });
    }

    res.json({ success: true, removidos, message: "Sessão limpa com sucesso!" });
  } catch (err) {
    console.error("❌ cleanup-session:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Servir thumbnails geradas
app.use("/output-img", express.static("output"));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

app.listen(PORT, "0.0.0.0", () =>
  console.log(`\n🚀 SEO AnimeRecap → http://0.0.0.0:${PORT}\n`),
);
