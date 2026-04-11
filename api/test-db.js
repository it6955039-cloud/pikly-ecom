/**
 * test-db.js — Quick connectivity test for your Neon database.
 * Run: node api/test-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const { Pool } = require('pg')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('❌  DATABASE_URL not set. Copy .env.example → .env and fill it in.')
  process.exit(1)
}

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 })

pool.query('SELECT NOW() AS ts, current_database() AS db', (err, res) => {
  if (err) {
    console.error('❌  Connection failed:', err.message)
    console.error('    Check DATABASE_URL and that your IP is allowlisted in Neon.')
  } else {
    console.log('✅  Connected to:', res.rows[0].db, '— server time:', res.rows[0].ts)
  }
  pool.end()
})
