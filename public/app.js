// ─── Estado Global ────────────────────────────────────────────────────────────
const State = {
  roteiro: null,
  identificacao: null,
  analiseRoteiro: null,
  templateSelecionado: null,
  sessaoExtracao: null,
  framesExtraidos: [],       // resultados por papel
  framesSelecionados: {},    // { papel_id: { url, path, timestamp } }
  visionResultados: {},      // { papel_id: analise }
  specFinal: null,
  guiaGerado: null,          // Armazena o guia
  thumbnailGerada: null,     // Armazena info da img
  
  // Auth e Settings
  token: localStorage.getItem('auth_token') || null,
  models: JSON.parse(localStorage.getItem('ai_models')) || {
    text: { provider: 'deepseek', model: 'deepseek-chat' },
    vision: { provider: 'google', model: 'gemini-3.1-pro-preview' },
    spec: { provider: 'deepseek', model: 'deepseek-chat' },
    image: { provider: 'google', model: 'gemini-3-pro-image-preview' }
  }
};

const API = 'api';

// A constante AVAILABLE_MODELS agora está em config_modelos.js

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  setupAuth();
  setupSettings();
  
  setupTabs();
  setupFileInputs();
  setupGuide();
  setupThumb();
  setupCopyButtons();
  checkHealth();
});

// ─── Wrapper de Fetch para Auth ───────────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
  if (!options.headers) options.headers = {};
  if (State.token) {
    options.headers['Authorization'] = `Bearer ${State.token}`;
  }
  
  const response = await fetch(`${API}${endpoint}`, options);
  
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('auth_token');
    State.token = null;
    if (firebaseAuth) {
      firebaseAuth.signOut();
    } else {
      showAuth();
    }
    throw new Error("Sessão expirada ou não aprovada pelo administrador.");
  }
  return response;
}

// ─── Health ───────────────────────────────────────────────────────────────────
async function checkHealth() {
  const dot = document.querySelector('.status-dot');
  const txt = dot?.nextElementSibling;
  try {
    await fetch(`${API}/health`);
    dot?.classList.add('ok');
    if (txt) txt.textContent = 'Servidor online';
  } catch {
    dot?.classList.add('err');
    if (txt) txt.textContent = 'Servidor offline';
  }
}

// ─── Auth e Settings Setup ────────────────────────────────────────────────────
function showAuth() {
  document.getElementById('authSection').classList.remove('hidden');
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('mainContent').classList.add('hidden');
  document.getElementById('approvalSection').classList.add('hidden');
}

function showMainApp() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('sidebar').classList.remove('hidden');
  document.getElementById('mainContent').classList.remove('hidden');
  document.getElementById('approvalSection').classList.add('hidden');
}

function showApprovalScreen(userName, userEmail) {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('mainContent').classList.add('hidden');
  document.getElementById('approvalSection').classList.remove('hidden');
  
  document.getElementById('approvalUserName').textContent = `Nome: ${userName || 'Não informado'}`;
  document.getElementById('approvalUserEmail').textContent = `E-mail: ${userEmail || 'Não informado'}`;
}

let firebaseAuth = null;
let firebaseFirestore = null;

async function initFirebase() {
  try {
    const res = await fetch(`${API}/firebase-config`);
    if (!res.ok) throw new Error("Não foi possível obter a configuração do Firebase.");
    const firebaseConfig = await res.json();
    
    // Inicializar Firebase
    firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firebaseFirestore = firebase.firestore();
    
    console.log("🔥 Firebase Client inicializado com sucesso.");
    
    // Ouvinte reativo de login
    firebaseAuth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          const idToken = await user.getIdToken(true);
          
          // Verificar aprovação com o backend
          const loginRes = await fetch(`${API}/firebase-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: idToken })
          });
          
          const loginData = await loginRes.json();
          
          if (!loginRes.ok) {
            toast(loginData.error || "Erro ao validar permissões no servidor.", "error");
            showApprovalScreen(user.displayName || user.email.split('@')[0], user.email);
            return;
          }
          
          State.token = idToken;
          localStorage.setItem('auth_token', idToken);
          
          if (loginData.approved) {
            showMainApp();
          } else {
            showApprovalScreen(user.displayName || user.email.split('@')[0], user.email);
          }
        } catch (err) {
          console.error("Erro na verificação de aprovação:", err);
          toast("Erro de conexão ao verificar aprovação.", "error");
          showApprovalScreen(user.displayName || user.email, user.email);
        }
      } else {
        State.token = null;
        localStorage.removeItem('auth_token');
        showAuth();
      }
    });
    
    // Botões da tela de aprovação
    document.getElementById('btnCheckApproval').addEventListener('click', async () => {
      showLoading("Verificando aprovação...");
      const currentUser = firebaseAuth.currentUser;
      if (currentUser) {
        try {
          const idToken = await currentUser.getIdToken(true);
          const loginRes = await fetch(`${API}/firebase-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: idToken })
          });
          const loginData = await loginRes.json();
          if (loginRes.ok && loginData.approved) {
            State.token = idToken;
            localStorage.setItem('auth_token', idToken);
            showMainApp();
            toast("Acesso aprovado! Bem-vindo.", "success");
          } else {
            toast(loginData.message || "Seu acesso ainda está pendente de aprovação.", "info");
          }
        } catch (err) {
          toast("Erro ao verificar. Tente novamente.", "error");
        }
      }
      hideLoading();
    });
    
    document.getElementById('btnApprovalLogout').addEventListener('click', () => {
      if (firebaseAuth) firebaseAuth.signOut();
    });
    
  } catch (err) {
    console.error("Erro ao inicializar Firebase no frontend:", err.message);
    toast("Falha crítica ao conectar com o Firebase. Verifique o console.", "error");
  }
}

function setupAuth() {
  let authMode = 'login'; // 'login', 'register', 'forgot'
  const toggleBtn = document.getElementById('authToggle');
  const forgotBtn = document.getElementById('authForgotToggle');
  const form = document.getElementById('authForm');
  const title = document.getElementById('authTitle');
  const subtitle = document.getElementById('authSubtitle');
  const btn = document.getElementById('btnAuthSubmit');
  
  const nameInput = document.getElementById('authName');
  const phoneInput = document.getElementById('authPhone');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  
  const googleBtn = document.getElementById('btnGoogleAuth');
  const authDivider = document.getElementById('authDivider');

  function updateAuthUI() {
    nameInput.classList.add('hidden');
    nameInput.required = false;
    phoneInput.classList.add('hidden');
    phoneInput.required = false;
    emailInput.classList.remove('hidden');
    emailInput.placeholder = 'E-mail';
    emailInput.required = true;
    passwordInput.classList.remove('hidden');
    passwordInput.required = true;
    
    googleBtn.classList.remove('hidden');
    authDivider.classList.remove('hidden');
    
    if (authMode === 'login') {
      title.textContent = 'Acesso Restrito';
      subtitle.textContent = 'Faça login para utilizar a ferramenta';
      btn.textContent = 'Entrar';
      passwordInput.placeholder = 'Senha';
      toggleBtn.textContent = 'Não tem conta? Cadastre-se';
      forgotBtn.classList.remove('hidden');
      forgotBtn.textContent = 'Esqueceu a senha?';
    } else if (authMode === 'register') {
      title.textContent = 'Cadastro de Acesso';
      subtitle.textContent = 'Preencha os dados abaixo para criar sua conta.';
      btn.textContent = 'Cadastrar';
      passwordInput.placeholder = 'Senha';
      
      nameInput.classList.remove('hidden');
      nameInput.required = true;
      phoneInput.classList.remove('hidden');
      phoneInput.required = true;
      
      toggleBtn.textContent = 'Já tem conta? Entrar';
      forgotBtn.classList.add('hidden');
    } else if (authMode === 'forgot') {
      title.textContent = 'Recuperar Senha';
      subtitle.textContent = 'Digite seu e-mail para enviar as instruções de redefinição.';
      btn.textContent = 'Enviar E-mail de Recuperação';
      passwordInput.classList.add('hidden');
      passwordInput.required = false;
      
      googleBtn.classList.add('hidden');
      authDivider.classList.add('hidden');
      
      toggleBtn.textContent = 'Voltar para Entrar';
      forgotBtn.classList.add('hidden');
    }
  }

  toggleBtn.addEventListener('click', () => {
    if (authMode === 'login') {
      authMode = 'register';
    } else {
      authMode = 'login';
    }
    updateAuthUI();
  });
  
  forgotBtn.addEventListener('click', () => {
    authMode = 'forgot';
    updateAuthUI();
  });
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!firebaseAuth) {
      toast("Firebase não inicializado. Verifique a conexão.", "error");
      return;
    }
    
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    
    let loadingMsg = 'Entrando...';
    if (authMode === 'register') loadingMsg = 'Criando conta...';
    if (authMode === 'forgot') loadingMsg = 'Enviando e-mail...';
    
    showLoading(loadingMsg);
    try {
      if (authMode === 'login') {
        await firebaseAuth.signInWithEmailAndPassword(email, password);
      } else if (authMode === 'register') {
        const userCredential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        await user.updateProfile({ displayName: name });
        
        if (firebaseFirestore) {
          await firebaseFirestore.collection("users").doc(user.uid).set({
            uid: user.uid,
            name: name,
            phone: phone,
            email: email,
            approved: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
        
        toast('Cadastro realizado! Aguarde a aprovação do administrador.', 'success');
      } else if (authMode === 'forgot') {
        await firebaseAuth.sendPasswordResetEmail(email);
        toast('E-mail de recuperação enviado com sucesso!', 'success');
        authMode = 'login';
        updateAuthUI();
      }
    } catch (err) {
      console.error(err);
      let errorMsg = err.message;
      if (err.code === 'auth/user-not-found') errorMsg = "Usuário não encontrado.";
      if (err.code === 'auth/wrong-password') errorMsg = "Senha incorreta.";
      if (err.code === 'auth/email-already-in-use') errorMsg = "Este e-mail já está em uso.";
      if (err.code === 'auth/weak-password') errorMsg = "A senha deve ter pelo menos 6 caracteres.";
      if (err.code === 'auth/invalid-email') errorMsg = "Formato de e-mail inválido.";
      toast(errorMsg, 'error');
    } finally {
      hideLoading();
    }
  });

  googleBtn.addEventListener('click', async () => {
    if (!firebaseAuth) {
      toast("Firebase não inicializado. Verifique a conexão.", "error");
      return;
    }
    showLoading("Conectando com o Google...");
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebaseAuth.signInWithPopup(provider);
    } catch (err) {
      console.error(err);
      toast(err.message, 'error');
    } finally {
      hideLoading();
    }
  });

  updateAuthUI();
}

function setupSettings() {
  const modal = document.getElementById('settingsModal');
  
  document.getElementById('btnSettings').addEventListener('click', () => {
    // Preencher valores atuais
    Object.keys(State.models).forEach(k => {
      document.getElementById(`selProv_${k}`).value = State.models[k].provider;
      window.updateModels(k);
      document.getElementById(`selMod_${k}`).value = State.models[k].model;
    });
    modal.classList.remove('hidden');
  });
  
  document.getElementById('btnCloseSettings').addEventListener('click', () => modal.classList.add('hidden'));
  
  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    State.models = {
      text: { provider: document.getElementById('selProv_text').value, model: document.getElementById('selMod_text').value },
      vision: { provider: document.getElementById('selProv_vision').value, model: document.getElementById('selMod_vision').value },
      spec: { provider: document.getElementById('selProv_spec').value, model: document.getElementById('selMod_spec').value },
      image: { provider: document.getElementById('selProv_image').value, model: document.getElementById('selMod_image').value }
    };
    localStorage.setItem('ai_models', JSON.stringify(State.models));
    modal.classList.add('hidden');
    toast('Configurações salvas!', 'success');
  });
}

window.updateModels = function(type) {
  const prov = document.getElementById(`selProv_${type}`).value;
  const modSel = document.getElementById(`selMod_${type}`);
  modSel.innerHTML = AVAILABLE_MODELS[type][prov].map(m => `<option value="${m}">${m}</option>`).join('');
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
      const titles = { guide: '📋 Guia de Postagem', thumb: '🖼️ Gerador de Capa' };
      document.getElementById('pageTitle').textContent = titles[tab] || '';
    });
  });
}

// ─── Botões de Copiar ──────────────────────────────────────────────────────────
function setupCopyButtons() {
  document.querySelectorAll('.btn-copy[data-copy]').forEach(btn => {
    // Remove listeners antigos se houver (substituindo clone)
    const newBtn = btn.cloneNode(true);
    btn.replaceWith(newBtn);
    
    newBtn.addEventListener('click', () => {
      const targetId = newBtn.getAttribute('data-copy');
      const targetEl = document.getElementById(targetId);
      if (!targetEl) return;
      
      let textToCopy = "";
      if (targetId === "tagsYT" || targetId === "hashtagsYT" || targetId === "instagramHashtags") {
        const separator = targetId === "instagramHashtags" ? " " : ", ";
        const tags = Array.from(targetEl.children).map(child => child.textContent.trim());
        textToCopy = tags.join(separator);
      } else {
        textToCopy = targetEl.innerText || targetEl.textContent;
      }
      
      navigator.clipboard.writeText(textToCopy).then(() => {
        toast('Copiado com sucesso!', 'success');
      }).catch(err => {
        toast('Erro ao copiar', 'error');
      });
    });
  });
}

// ─── File Inputs e Sync Drive ──────────────────────────────────────────────────
function setupFileInputs() {
  document.getElementById('btnSyncDrive').addEventListener('click', async () => {
    showLoading('Sincronizando com Google Drive...', 'Baixando roteiro, identificação e vídeo original (pode levar alguns minutos dependendo do vídeo)');
    try {
      const r = await apiFetch('/sync-drive', { method: 'POST' });
      const data = await r.json();
      if (!data.success) throw new Error(data.error);

      State.roteiro = data.traducao;
      State.identificacao = data.identificacao;
      State.videoPath = data.video_path; // guardando o caminho local no server
      
      updateChips();
      if (State.identificacao.title) {
        document.querySelector('.page-sub').textContent = State.identificacao.title;
      }
      
      // Atualizar a interface do video para mostrar que já foi vinculado
      document.getElementById('videoUploadZone').classList.add('hidden');
      const info = document.getElementById('videoInfo');
      info.classList.remove('hidden');
      document.getElementById('videoName').textContent = '✅ Vinculado via Drive (video_original.mp4)';
      document.getElementById('videoSize').textContent = 'Pronto no Servidor';
      document.getElementById('btnExtrairFrames').disabled = false;

      toast('Sincronização com o Drive concluída!', 'success');
    } catch (err) {
      toast(`Erro ao sincronizar: ${err.message}`, 'error');
    } finally {
      hideLoading();
    }
  });

  document.getElementById('inputRoteiro').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      State.roteiro = JSON.parse(await file.text());
      updateChips();
      toast('Roteiro carregado ✓', 'success');
    } catch { toast('Roteiro inválido', 'error'); }
  });

  document.getElementById('inputIdentificacao').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      State.identificacao = JSON.parse(await file.text());
      updateChips();
      if (State.identificacao.title) {
        document.querySelector('.page-sub').textContent = State.identificacao.title;
      }
      toast('Identificação carregada ✓', 'success');
    } catch { toast('Identificação inválida', 'error'); }
  });
}

function updateChips() {
  const loaded = (id, ok) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('loaded', ok);
    el.querySelector('.chip-status').textContent = ok ? '✓ ok' : 'não carregado';
  };

  const rOk = !!State.roteiro;
  const iOk = !!State.identificacao;

  loaded('chipRoteiro', rOk);
  loaded('chipIdentificacao', iOk);
  loaded('chipRoteiroThumb', rOk);
  loaded('chipIdentificacaoThumb', iOk);

  const both = rOk && iOk;
  const btnG = document.getElementById('btnGerarGuia');
  const btnA = document.getElementById('btnAnalisarRoteiro');
  if (btnG) btnG.disabled = !both;
  if (btnA) btnA.disabled = !both;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 3500) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function showLoading(msg, sub = '') {
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingSub').textContent = sub;
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO 1 — GUIA DE POSTAGEM
// ═══════════════════════════════════════════════════════════════════════════════
function setupGuide() {
  document.getElementById('btnGerarGuia').addEventListener('click', gerarGuia);
  
  const btnDownloadGuide = document.getElementById('btnDownloadGuideJson');
  if (btnDownloadGuide) {
    btnDownloadGuide.addEventListener('click', () => {
      if (!State.guiaGerado) return;
      const blob = new Blob([JSON.stringify(State.guiaGerado, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `guia_postagem_${Date.now()}.json`;
      a.click();
    });
  }

}

async function gerarGuia() {
  if (!State.roteiro || !State.identificacao) return;
  showLoading('Gerando guia com DeepSeek V3...', 'Analisando roteiro e criando conteúdo viral');

  try {
    const r = await apiFetch('/generate-guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        roteiro: State.roteiro, 
        identificacao: State.identificacao,
        modelConfig: State.models.text
      })
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error);
    State.guiaGerado = data.guia;
    renderGuia(data.guia);
    toast('Guia gerado com sucesso!', 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderGuia(g) {
  document.getElementById('guideResult').classList.remove('hidden');

  // Título principal
  document.getElementById('tituloPrincipal').textContent = g.titulo_principal || '';

  // Títulos alternativos
  const altEl = document.getElementById('titulosAlternativos');
  altEl.innerHTML = (g.titulos_alternativos || []).map((t, i) => `
    <div class="titulo-alt-item">
      <span>${t}</span>
      <button class="btn-copy" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('span').textContent).then(()=>toast('Copiado!','success'))">Copiar</button>
    </div>`).join('');

  // Score viral
  const score = g.score_viral || 0;
  document.getElementById('scoreNumber').textContent = score;
  const offset = 283 - (283 * score / 100);
  document.getElementById('ringFill').style.strokeDashoffset = offset;
  document.getElementById('scoreDetail').textContent =
    score >= 85 ? '🔥 Alta viralização esperada' :
    score >= 70 ? '✅ Bom potencial' : '⚠️ Potencial moderado';

  // Info
  document.getElementById('analiseEmocional').textContent = g.analise_emocional || '';
  document.getElementById('melhorHorario').textContent = g.melhor_horario_postagem || '';
  document.getElementById('audienciaAlvo').textContent = g.audiencia_alvo || '';

  // Descrição
  document.getElementById('descricaoYT').textContent = g.descricao || '';

  // Tags
  const tags = typeof g.tags_youtube === 'string'
    ? g.tags_youtube.split(',').map(t => t.trim()).filter(Boolean)
    : g.tags_youtube || [];
  document.getElementById('tagsYT').innerHTML = tags.map(t =>
    `<span class="tag-chip">${t}</span>`).join('');

  // Hashtags
  document.getElementById('hashtagsYT').innerHTML = (g.hashtags_youtube || []).map(h =>
    `<span class="hashtag-chip">${h}</span>`).join('');

  // Capítulos
  document.getElementById('capitulosList').innerHTML = (g.capitulos || []).map(c =>
    `<div class="chapter-item"><span class="chapter-time">${c.tempo}</span><span>${c.titulo}</span></div>`).join('');

  // Cards
  document.getElementById('cardsList').innerHTML = (g.cards_sugeridos || []).map(c =>
    `<div class="chapter-item"><span class="chapter-time">${c.tempo}</span><span>${c.texto}</span></div>`).join('');

  // CTAs
  document.getElementById('ctaVideo').textContent = g.call_to_action_video || '';
  document.getElementById('ctaDescricao').textContent = g.call_to_action_descricao || '';

  // TikTok & Instagram fields
  const tGuia = document.getElementById('tiktokGuia');
  if (tGuia) tGuia.textContent = g.tiktok_guia || '';

  const iHashtags = document.getElementById('instagramHashtags');
  if (iHashtags) {
    iHashtags.innerHTML = (g.instagram_hashtags || []).map(h => `<span class="hashtag-chip" style="background:rgba(225,48,108,0.1);border-color:rgba(225,48,108,0.3);color:#e1306c">${h}</span>`).join('');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO 2 — GERADOR DE CAPA (STEPPER)
// ═══════════════════════════════════════════════════════════════════════════════
function setupThumb() {
  document.getElementById('btnAnalisarRoteiro').addEventListener('click', analisarRoteiro);

  // Drag & drop vídeo
  const zone = document.getElementById('videoUploadZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) setVideoFile(file);
  });

  document.getElementById('inputVideo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) setVideoFile(file);
  });

  document.getElementById('btnClearVideo').addEventListener('click', () => {
    document.getElementById('inputVideo').value = '';
    document.getElementById('videoInfo').classList.add('hidden');
    document.getElementById('videoUploadZone').classList.remove('hidden');
    State._videoFile = null;
    State.videoPath = null;
    document.getElementById('btnExtrairFrames').disabled = true;
  });

  document.getElementById('btnExtrairFrames').addEventListener('click', extrairFrames);
  document.getElementById('btnConfirmarFrames').addEventListener('click', analisarFramesSelecionados);
  document.getElementById('btnGerarSpec').addEventListener('click', gerarSpec);
  document.getElementById('btnGerarSpecTikTok')?.addEventListener('click', gerarSpecTikTok);
  document.getElementById('btnGerarSpecTikTokEtapa3')?.addEventListener('click', gerarSpecTikTok);
  document.getElementById('btnDownloadSpec').addEventListener('click', downloadSpec);
  document.getElementById('btnRenderThumbnail').addEventListener('click', gerarThumbnailFinalIA);
  document.getElementById('btnRenderThumbnailTikTok')?.addEventListener('click', gerarThumbnailFinalIA);
  document.getElementById('btnNovaIteracao').addEventListener('click', () => goToStep(3));
  document.getElementById('btnVoltarTemplates').addEventListener('click', () => goToStep(2));
  document.getElementById('btnFinalizarLimpar').addEventListener('click', finalizarELimpar);
}

async function finalizarELimpar() {
  if (!confirm("Tem certeza que deseja apagar os arquivos temporários e encerrar este projeto?")) return;
  
  showLoading('Limpando Sessão...', 'Apagando vídeos e imagens do servidor');
  try {
    // 1. Chamar o backend para apagar tudo
    const r = await apiFetch('/cleanup-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessao_id: State.sessaoExtracao,
        video_path: State.videoPath || State._videoFile?.path,
        spec_file: State.specFinal?.arquivo_local, // precisamos saber se guardamos.
        images: State.thumbnailGerada ? [State.thumbnailGerada] : []
      })
    });
    
    // 2. Limpar a Interface
    document.getElementById('inputVideo').value = '';
    document.getElementById('videoInfo').classList.add('hidden');
    document.getElementById('videoUploadZone').classList.remove('hidden');
    document.getElementById('framesExtraidosContainer').classList.add('hidden');
    document.getElementById('visionAnaliseContainer').classList.add('hidden');
    document.getElementById('renderResultContainer').classList.add('hidden');
    
    // Resetar State (exceto roteiro e id)
    State.templateSelecionado = null;
    State.sessaoExtracao = null;
    State.framesExtraidos = [];
    State.framesSelecionados = {};
    State.visionResultados = {};
    State.specFinal = null;
    State.thumbnailGerada = null;
    State._videoFile = null;
    State.videoPath = null;
    
    goToStep(1);
    toast('Sessão finalizada e arquivos limpos!', 'success');
  } catch(err) {
    toast(`Erro ao limpar: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function setVideoFile(file) {
  State._videoFile = file;
  document.getElementById('videoUploadZone').classList.add('hidden');
  const info = document.getElementById('videoInfo');
  info.classList.remove('hidden');
  document.getElementById('videoName').textContent = file.name;
  document.getElementById('videoSize').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  document.getElementById('btnExtrairFrames').disabled = false;
}

// ─── Stepper ──────────────────────────────────────────────────────────────────
function goToStep(n) {
  for (let i = 1; i <= 4; i++) {
    const step = document.getElementById(`thumbStep${i}`);
    const ind = document.getElementById(`step${i}-indicator`);
    step?.classList.toggle('active', i === n);
    step?.classList.toggle('hidden', i !== n);
    if (ind) {
      ind.classList.toggle('active', i === n);
      ind.classList.toggle('done', i < n);
    }
  }
}

// ─── Etapa 1: Analisar Roteiro ────────────────────────────────────────────────
async function analisarRoteiro() {
  if (!State.roteiro || !State.identificacao) return;
  showLoading('Analisando roteiro...', 'DeepSeek V3 identificando momentos-chave e templates ideais');

  try {
    const r = await apiFetch('/analyze-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        roteiro: State.roteiro, 
        identificacao: State.identificacao,
        modelConfig: State.models.text
      })
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error);
    State.analiseRoteiro = data.analise;
    renderTemplates(data.analise);
    goToStep(2);
    toast('Análise concluída!', 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// ─── Etapa 2: Renderizar Templates ───────────────────────────────────────────
const TEMPLATE_COLORS = {
  HEROI_REACAO: '#7c6af7', TENSAO_DUAL: '#ef4444',
  OVER_POWERED: '#f97316', STRIP_REACOES: '#22c55e', VIRADA_NARRATIVA: '#f5c518'
};

function renderTemplates(analise) {
  document.getElementById('resumoRoteiro').innerHTML = `
    <strong>💫 Emoção dominante:</strong> ${analise.emocao_dominante}<br/>
    <strong>📖 Resumo:</strong> ${analise.resumo_para_thumbnail}`;

  const grid = document.getElementById('templatesGrid');
  grid.innerHTML = (analise.templates_recomendados || []).map((t, i) => {
    const cor = TEMPLATE_COLORS[t.template] || '#7c6af7';
    const framesHtml = (t.frames_necessarios || []).map(f => {
      const tempos = (f.janelas_tempo || [{inicio: f.timestamp_inicio, fim: f.timestamp_fim}])
        .map(j => `[${j.inicio}s–${j.fim}s]`).join(' | ');
      return `<div class="frame-needed-chip">📍 ${f.papel_id}: ${f.personagem} ${tempos}</div>`;
    }).join('');
    return `
      <div class="template-card" data-idx="${i}" onclick="selecionarTemplate(${i})">
        <span class="template-score">${t.score}/100</span>
        <div class="template-badge" style="background:${cor}22;color:${cor};border:1px solid ${cor}44">${t.template.replace('_', ' ')}</div>
        <div class="template-name">${t.texto_capa}</div>
        <div class="template-desc">${t.justificativa}</div>
        <div class="template-texto">🎨 Paleta: ${t.paleta}</div>
        <div class="template-frames-needed">${framesHtml}</div>
      </div>`;
  }).join('');
}

function selecionarTemplate(idx) {
  document.querySelectorAll('.template-card').forEach((c, i) => c.classList.toggle('selected', i === idx));
  State.templateSelecionado = State.analiseRoteiro.templates_recomendados[idx];

  // Mostrar frames necessários na etapa 3
  renderFramesInfo(State.templateSelecionado.frames_necessarios);
  goToStep(3);
  toast(`Template "${State.templateSelecionado.template}" selecionado`, 'success');
}

// ─── Etapa 3: Info dos Frames necessários ────────────────────────────────────
function renderFramesInfo(frames) {
  const container = document.getElementById('framesNecessariosInfo');
  container.innerHTML = `
    <h4 style="font-size:14px;color:var(--text2);margin-bottom:10px;">Frames que serão extraídos do vídeo:</h4>
    <div class="frames-info-grid">
      ${frames.map(f => {
        const tempos = (f.janelas_tempo || [{inicio: f.timestamp_inicio, fim: f.timestamp_fim}])
          .map(j => `${j.inicio}s → ${j.fim}s`).join(' / ');
        return `
        <div class="frame-info-card">
          <div class="frame-info-papel">${f.papel_id.toUpperCase()}</div>
          <div class="frame-info-personagem">👤 ${f.personagem}</div>
          <div class="frame-info-time">⏱ ${tempos}</div>
          <div class="frame-info-emocao">${f.emocao_buscada}</div>
        </div>`;
      }).join('')}
    </div>`;
}

// ─── Etapa 3: Extrair Frames ──────────────────────────────────────────────────
async function extrairFrames() {
  if ((!State._videoFile && !State.videoPath) || !State.templateSelecionado) return;

  const frames = State.templateSelecionado.frames_necessarios;
  showLoading('Extraindo frames do vídeo...', `Processando ${frames.length} janelas de tempo com ffmpeg`);

  try {
    let r;
    if (State.videoPath) {
      // Uso de vídeo baixado do Drive via backend
      r = await apiFetch('/extract-frames', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frames_config: JSON.stringify(frames),
          video_path: State.videoPath
        })
      });
    } else {
      // Uso de vídeo upado via Input File local
      const fd = new FormData();
      fd.append('video', State._videoFile);
      fd.append('frames_config', JSON.stringify(frames));
      r = await apiFetch('/extract-frames', { method: 'POST', body: fd });
    }
    
    
    if (!r.ok) {
      if (r.status === 413) throw new Error("Vídeo muito grande! O limite de requisição padrão do Cloud Run é 32MB. Mude para a Gen 2 do Cloud Run.");
      const errText = await r.text();
      try {
        const errJson = JSON.parse(errText);
        throw new Error(errJson.error || `Erro HTTP ${r.status}`);
      } catch {
        throw new Error(`Erro Servidor (${r.status}): O Cloud Run bloqueou a requisição.`);
      }
    }
    
    const data = await r.json();
    if (!data.success) throw new Error(data.error);

    State.sessaoExtracao = data.sessao_id;
    State.framesExtraidos = data.resultados;
    State.framesSelecionados = {};

    renderFramesExtraidos(data.resultados);
    document.getElementById('framesExtraidosContainer').classList.remove('hidden');
    toast(`${data.resultados.reduce((a,r) => a + r.total, 0)} frames extraídos!`, 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// ─── Renderizar Grid de Frames ────────────────────────────────────────────────
function renderFramesExtraidos(resultados) {
  const container = document.getElementById('framesPorPapel');
  container.innerHTML = resultados.map(papel => `
    <div class="papel-section">
      <div class="papel-header">
        <span class="papel-badge">${papel.papel_id}</span>
        <span class="papel-title">${papel.papel_descricao}</span>
        <span class="papel-time">⏱ ${(papel.janelas_tempo || [{inicio: papel.timestamp_inicio, fim: papel.timestamp_fim}]).map(j => `${j.inicio}s – ${j.fim}s`).join(' / ')}</span>
        <span class="papel-desc">👤 ${papel.personagem}</span>
      </div>
      <div class="frames-grid" id="grid-${papel.papel_id}">
        ${(papel.frames_extraidos || []).map(f => `
          <div class="frame-card" data-papel="${papel.papel_id}" data-url="${f.url}" data-ts="${f.timestamp}"
               onclick="selecionarFrame('${papel.papel_id}', '${f.url}', ${f.timestamp}, this)">
            <img src="${f.url.startsWith('/') ? f.url.substring(1) : f.url}" alt="t=${f.timestamp}s" loading="lazy" />
            <div class="frame-timestamp">${f.timestamp}s</div>
            <div class="frame-selected-badge">✓ Selecionado</div>
          </div>`).join('')}
      </div>
    </div>`).join('');

  atualizarSelecaoResumo();
}

function selecionarFrame(papelId, url, ts, el) {
  // Desmarcar outros do mesmo papel
  document.querySelectorAll(`.frame-card[data-papel="${papelId}"]`).forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  State.framesSelecionados[papelId] = { url, timestamp: ts, path: url.replace('/extracted', 'public/extracted') };
  atualizarSelecaoResumo();
}

function atualizarSelecaoResumo() {
  const necessarios = State.templateSelecionado?.frames_necessarios || [];
  const resumo = document.getElementById('selecaoResumo');
  const btn = document.getElementById('btnConfirmarFrames');

  resumo.innerHTML = necessarios.map(f => {
    const sel = State.framesSelecionados[f.papel_id];
    return `<div class="selecao-item ${sel ? 'ok' : 'pending'}">
      ${sel ? '✓' : '○'} <strong>${f.papel_id}</strong> ${sel ? `(${sel.timestamp}s)` : '— aguardando'}
    </div>`;
  }).join('');

  const todos = necessarios.every(f => State.framesSelecionados[f.papel_id]);
  btn.disabled = !todos;

  const status = document.getElementById('selecaoStatus');
  const selecionados = necessarios.filter(f => State.framesSelecionados[f.papel_id]).length;
  status.textContent = todos
    ? `✅ Todos os ${necessarios.length} frames selecionados! Pronto para análise.`
    : `Selecione ${necessarios.length - selecionados} frame(s) ainda pendente(s).`;
}

// ─── Análise Vision dos Frames Selecionados ───────────────────────────────────
async function analisarFramesSelecionados() {
  const necessarios = State.templateSelecionado.frames_necessarios;
  showLoading('Analisando frames com Gemini Vision...', 'Avaliando qualidade visual e composição de cada frame');

  try {
    const resultados = {};
    for (const f of necessarios) {
      const sel = State.framesSelecionados[f.papel_id];
      if (!sel) continue;

      const r = await apiFetch('/analyze-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frame_path: sel.url,
          papel_id: f.papel_id,
          papel_descricao: f.papel_descricao,
          template: State.templateSelecionado.template,
          emocao_buscada: f.emocao_buscada,
          modelConfig: State.models.vision
        })
      });
      const data = await r.json();
      if (data.success) resultados[f.papel_id] = { frame: sel, analise: data.analise };
    }

    State.visionResultados = resultados;
    renderVisionResultados(resultados);
    document.getElementById('visionAnaliseContainer').classList.remove('hidden');
    toast('Análise visual concluída!', 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderVisionResultados(resultados) {
  const container = document.getElementById('visionResultados');
  container.innerHTML = Object.entries(resultados).map(([papelId, { frame, analise: a }]) => `
    <div class="vision-card">
      <div class="vision-thumb"><img src="${frame.url.startsWith('/') ? frame.url.substring(1) : frame.url}" alt="${papelId}" /></div>
      <div>
        <div style="font-size:14px;font-weight:700;margin-bottom:8px;color:var(--accent)">${papelId.toUpperCase()} — t=${frame.timestamp}s</div>
        <div class="vision-score-row">
          <span class="vision-score-chip">🎨 Visual: ${a.score_visual}/10</span>
          <span class="vision-score-chip">💫 Emoção: ${a.score_emocao}/10</span>
          <span class="vision-score-chip" style="background:rgba(34,197,94,0.1);border-color:rgba(34,197,94,0.3);color:var(--green)">⭐ Geral: ${a.score_geral}/100</span>
        </div>
        <div class="vision-list">
          ${(a.pontos_fortes || []).map(p => `<span class="vision-tag" style="color:var(--green)">✓ ${p}</span>`).join('')}
          ${(a.pontos_fracos || []).map(p => `<span class="vision-tag" style="color:var(--red)">✗ ${p}</span>`).join('')}
        </div>
        <div class="vision-rec">${a.recomendacao || ''}</div>
      </div>
    </div>`).join('');
}

// ─── Etapa 4: Gerar Spec JSON ─────────────────────────────────────────────────
async function gerarSpec() {
  showLoading('Gerando Spec JSON...', 'DeepSeek V3 montando o blueprint da thumbnail');

  try {
    const framesSelecionados = Object.entries(State.framesSelecionados).map(([papelId, frame]) => ({
      papel_id: papelId,
      url: frame.url,
      timestamp: frame.timestamp,
      analise: State.visionResultados[papelId]?.analise || {}
    }));

    const r = await apiFetch('/generate-thumbnail-spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: State.templateSelecionado.template,
        template_obj: State.templateSelecionado,
        frames_selecionados: framesSelecionados,
        analise_roteiro: State.analiseRoteiro,
        identificacao: State.identificacao,
        modelConfig: State.models.spec
      })
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error);

    State.specFinal = data.spec;
    renderSpec(data.spec);
    updateStep4Buttons('youtube');
    goToStep(4);
    toast('Spec JSON gerado!', 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function gerarSpecTikTok() {
  showLoading('Gerando Spec JSON TikTok...', 'DeepSeek montando o blueprint da thumbnail 3:4');

  try {
    const framesSelecionados = Object.entries(State.framesSelecionados).map(([papelId, frame]) => ({
      papel_id: papelId,
      url: frame.url,
      timestamp: frame.timestamp,
      analise: State.visionResultados[papelId]?.analise || {}
    }));

    const r = await apiFetch('/generate-tiktok-spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: State.templateSelecionado.template,
        template_obj: State.templateSelecionado,
        frames_selecionados: framesSelecionados,
        analise_roteiro: State.analiseRoteiro,
        identificacao: State.identificacao,
        modelConfig: State.models.spec
      })
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error);

    State.specFinal = data.spec;
    renderSpec(data.spec);
    updateStep4Buttons('tiktok');
    goToStep(4);
    toast('Spec JSON TikTok gerado!', 'success');
  } catch (err) {
    toast(`Erro: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderSpec(spec) {
  document.getElementById('specJson').textContent = JSON.stringify(spec, null, 2);

  document.getElementById('specSummary').innerHTML = `
    <span class="spec-chip">📐 ${spec.template}</span>
    <span class="spec-chip">🎨 ${spec.paleta?.nome || ''}</span>
    <span class="spec-chip">📏 ${spec.canvas?.width}×${spec.canvas?.height}</span>
    <span class="spec-chip">🗂 ${(spec.camadas || []).length} camadas</span>
    <span class="spec-chip">🎬 ${State.identificacao?.title || ''}</span>`;

}

function downloadSpec() {
  if (!State.specFinal) return;
  const blob = new Blob([JSON.stringify(State.specFinal, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `thumbnail_spec_${Date.now()}.json`;
  a.click();
}

async function gerarThumbnailFinalIA() {
  if (!State.specFinal) return;
  showLoading('Gerando arte final da Thumbnail...', 'A IA (Gemini 3 Pro Image) está criando a imagem baseada nos frames e no JSON.');

  try {
    const framesSelecionados = Object.entries(State.framesSelecionados).map(([papelId, frame]) => ({
      papel_id: papelId,
      url: frame.url,
      path: frame.path,
      timestamp: frame.timestamp
    }));

    const r = await apiFetch('/generate-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: State.specFinal,
        frames_selecionados: framesSelecionados,
        modelConfig: State.models.image
      })
    });
    
    const data = await r.json();
    if (!data.success) throw new Error(data.error);

    if (data.images && data.images.length > 0) {
      const resultContainer = document.getElementById('renderResultContainer');
      const resultImage = document.getElementById('renderedThumbnailImage');
      const btnDownload = document.getElementById('btnDownloadThumbnail');
      
      const imgInfo = data.images[0];
      State.thumbnailGerada = imgInfo;
      resultImage.src = imgInfo.url.startsWith('/') ? imgInfo.url.substring(1) : imgInfo.url;
      resultContainer.classList.remove('hidden');
      
      btnDownload.onclick = () => {
        const a = document.createElement('a');
        a.href = imgInfo.url.startsWith('/') ? imgInfo.url.substring(1) : imgInfo.url;
        a.download = imgInfo.url.includes('tiktok') ? `tiktok_thumbnail_${Date.now()}.png` : `youtube_thumbnail_${Date.now()}.png`;
        a.click();
      };
      
      toast('Arte final gerada com sucesso!', 'success');
      // Scroll to image
      setTimeout(() => resultContainer.scrollIntoView({ behavior: 'smooth' }), 200);
    } else {
      throw new Error("Nenhuma imagem retornada pela API.");
    }
  } catch (err) {
    toast(`Erro ao gerar thumbnail: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function updateStep4Buttons(mode) {
  const btnRender169 = document.getElementById('btnRenderThumbnail');
  const btnSpecTikTok = document.getElementById('btnGerarSpecTikTok');
  const btnRenderTikTok = document.getElementById('btnRenderThumbnailTikTok');

  if (mode === 'youtube') {
    if (btnRender169) btnRender169.classList.remove('hidden');
    if (btnSpecTikTok) btnSpecTikTok.classList.remove('hidden');
    if (btnRenderTikTok) btnRenderTikTok.classList.add('hidden');
  } else if (mode === 'tiktok') {
    if (btnRender169) btnRender169.classList.add('hidden');
    if (btnSpecTikTok) btnSpecTikTok.classList.add('hidden');
    if (btnRenderTikTok) btnRenderTikTok.classList.remove('hidden');
  }
}

