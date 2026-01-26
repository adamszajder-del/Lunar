// Public ID Generator
const db = require('../database');

// Generate unique public ID for database entities
const generatePublicId = async (table, prefix = 'ID') => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let publicId;
  let exists = true;
  
  while (exists) {
    let id = prefix + '_';
    for (let i = 0; i < 8; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    publicId = id;
    
    // Check if exists
    const result = await db.query(
      `SELECT 1 FROM ${table} WHERE public_id = $1`,
      [publicId]
    );
    exists = result.rows.length > 0;
  }
  
  return publicId;
};

module.exports = { generatePublicId };
