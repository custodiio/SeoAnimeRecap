# Usa uma imagem oficial do Node.js (versão 20)
FROM node:20-slim

# Instala o FFmpeg (necessário para extrair os frames dos vídeos)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de configuração do Node
COPY package*.json ./

# Instala as dependências (omite as devDependencies)
RUN npm install --omit=dev

# Copia todo o código do projeto para o container
COPY . .

# Expõe a porta que a aplicação vai rodar
EXPOSE 3333

# Comando para iniciar o servidor
CMD ["node", "server.js"]
