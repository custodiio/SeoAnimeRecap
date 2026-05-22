const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class DriveManager {
  constructor() {
    this.refreshToken = process.env.DRIVE_REFRESH_TOKEN;
    this.clientId = process.env.DRIVE_CLIENT_ID;
    this.clientSecret = process.env.DRIVE_CLIENT_SECRET;
    this.drive = null;
    this.authenticate();
  }

  authenticate() {
    try {
      if (!this.refreshToken || !this.clientId || !this.clientSecret) {
        console.log('⚠️  Aviso: Credenciais do Drive ausentes no .env');
        return;
      }
      
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        'https://developers.google.com/oauthplayground'
      );

      oauth2Client.setCredentials({
        refresh_token: this.refreshToken
      });

      this.drive = google.drive({ version: 'v3', auth: oauth2Client });
      console.log('✅ Google Drive autenticado com sucesso!');
    } catch (error) {
      console.error('❌ Erro na autenticação do Drive:', error.message);
      this.drive = null;
    }
  }

  escapeQuery(name) {
    return name.replace(/'/g, "\\'");
  }

  async findIdByPath(drivePath) {
    if (!this.drive) return null;
    
    const parts = drivePath.replace(/^\/+|\/+$/g, '').split('/');
    let parentId = 'root';

    for (const part of parts) {
      const query = `name='${this.escapeQuery(part)}' and '${parentId}' in parents and trashed=false`;
      try {
        const res = await this.drive.files.list({
          q: query,
          fields: 'files(id, mimeType)',
          spaces: 'drive'
        });
        
        const files = res.data.files;
        if (!files || files.length === 0) {
          return null; // Não encontrou a pasta/arquivo atual do caminho
        }
        parentId = files[0].id;
      } catch (err) {
        console.error(`Erro buscando parte do caminho '${part}':`, err.message);
        return null;
      }
    }
    return parentId;
  }

  /**
   * Faz o download de um arquivo do Drive e salva localmente.
   * Se for um JSON (ou arquivo pequeno de texto), você pode usar o return para parsear diretamente
   * Mas como regra de design o método salva o buffer no destino.
   */
  async downloadFile(drivePath, localDest) {
    if (!this.drive) throw new Error('Drive não autenticado.');

    const fileId = await this.findIdByPath(drivePath);
    if (!fileId) {
      throw new Error(`Arquivo não encontrado no Drive: ${drivePath}`);
    }

    console.log(`Baixando: ${drivePath} -> ${localDest}`);
    
    // Garantir que a pasta de destino exista
    fs.mkdirSync(path.dirname(localDest), { recursive: true });

    return new Promise(async (resolve, reject) => {
      try {
        const dest = fs.createWriteStream(localDest);
        const res = await this.drive.files.get(
          { fileId: fileId, alt: 'media' },
          { responseType: 'stream' }
        );

        res.data
          .on('end', () => {
            console.log(`✅ Download concluído: ${drivePath}`);
            resolve(localDest);
          })
          .on('error', err => {
            console.error(`❌ Erro no download do stream:`, err);
            reject(err);
          })
          .pipe(dest);
      } catch (error) {
        console.error(`❌ Erro requisitando arquivo ${drivePath}:`, error.message);
        reject(error);
      }
    });
  }

  /**
   * Faz o upload de um arquivo local para o Drive. Cria se não existir, atualiza se já existir.
   */
  async uploadFileToPath(localPath, driveFolderPath, fileName, mimeType = 'application/octet-stream') {
    if (!this.drive) throw new Error('Drive não autenticado.');

    const folderId = await this.findIdByPath(driveFolderPath);
    if (!folderId) {
      console.log(`⚠️ Pasta não encontrada no Drive para upload: ${driveFolderPath}`);
      return null;
    }

    const query = `name='${this.escapeQuery(fileName)}' and '${folderId}' in parents and trashed=false`;
    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id)',
      spaces: 'drive'
    });

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(localPath)
    };

    if (res.data.files && res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      console.log(`📤 Upload (Update): ${fileName} -> ${driveFolderPath}`);
      await this.drive.files.update({
        fileId: fileId,
        media: media
      });
      return fileId;
    } else {
      console.log(`📤 Upload (Create): ${fileName} -> ${driveFolderPath}`);
      const fileMetadata = {
        name: fileName,
        parents: [folderId]
      };
      const result = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id'
      });
      return result.data.id;
    }
  }
}

// Singleton
const driveManager = new DriveManager();
module.exports = driveManager;
