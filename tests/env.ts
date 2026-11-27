/** Las pruebas usan exclusivamente la base de datos de pruebas. */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Define TEST_DATABASE_URL y TEST_DIRECT_URL (ver .env.example)');
process.env.DATABASE_URL = url;
// Las pruebas fijan los modelos de IA: no dependen de .env.local ni llaman a ninguna API.
for (const name of ['AI_MODEL', 'OPENAI_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[name];
// Clave fija de pruebas: no depende de lo que haya en .env.local.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
