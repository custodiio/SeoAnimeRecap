const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados SQLite:', err.message);
  } else {
    console.log('✅ Conectado ao banco de dados SQLite (users.db).');
    
    // Criação da tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )`, (err) => {
      if (err) {
        console.error('Erro ao criar tabela users:', err.message);
      }
    });
  }
});

function registerUser(username, password) {
  return new Promise(async (resolve, reject) => {
    try {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return reject(new Error('Usuário já existe.'));
          }
          return reject(err);
        }
        resolve({ id: this.lastID, username });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function verifyUser(username, password) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new Error('Usuário não encontrado.'));
      
      const isMatch = await bcrypt.compare(password, row.password);
      if (!isMatch) return reject(new Error('Senha incorreta.'));
      
      resolve({ id: row.id, username: row.username });
    });
  });
}

module.exports = {
  db,
  registerUser,
  verifyUser
};
