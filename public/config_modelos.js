// ============================================================================
// ⚙️ CONFIGURAÇÃO MANUAL DE MODELOS DISPONÍVEIS
// ============================================================================
// Aqui você pode adicionar ou remover os modelos que aparecerão na interface.
//
// FORMATO:
// funcao: {
//   provedor: ["modelo-1", "modelo-2"]
// }
// ============================================================================

const AVAILABLE_MODELS = {

  // 1. GERAR GUIA DE POSTAGEM E ANALISAR ROTEIRO (Textos e Lógica)
  text: {
    deepseek: [
      "deepseek-v4-pro",
      "deepseek-v4-flash"
    ],
    openai: [
      "gpt-5.4",
      "gpt-4.1"
    ],
    google: [
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview"
    ],
    azure: [
      "gpt-5-mini"
    ]
  },

  // 2. ANALISAR FRAME (Visão Computacional)
  vision: {
    google: [
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview"
    ],
    openai: [
      "gpt-4.1",
      "gpt-5.4",
      "gpt-5-mini"
    ],
    azure: [
      "gpt-5-mini"
    ]
  },

  // 3. GERAR SPEC JSON (Blueprint da Thumbnail)
  spec: {
    deepseek: [
      "deepseek-v4-pro",
      "deepseek-v4-flash"
    ],
    openai: [
      "gpt-4.1",
      "gpt-5.4",
      "gpt-5-mini"
    ],
    google: [
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview"
    ],
    azure: [
      "gpt-5-mini"
    ]
  },

  // 4. GERAR IMAGEM FINAL DA THUMBNAIL
  image: {
    google: [
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image-preview",
      "gemini-2.5-flash-image"
    ],
    openai: [
      "gpt-image-2",
      "dall-e-3"
    ]
  }
};
