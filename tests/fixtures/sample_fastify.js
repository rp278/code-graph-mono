import Fastify from 'fastify';

const fastify = Fastify({ logger: false });

async function listWidgets(request, reply) {
  return reply.send([{ id: 1 }]);
}

// named handler reference
fastify.get('/api/widgets', listWidgets);
fastify.post('/api/widgets', async (request, reply) => {
  return reply.code(201).send({ ok: true });
});
fastify.get('/api/widgets/:id', async (request, reply) => {
  return { id: request.params.id };
});

db.exec(`
  CREATE TABLE IF NOT EXISTS widgets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )
`);
const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(1);
const rows = db.prepare('SELECT * FROM widgets').all();
db.prepare('INSERT INTO widgets (name) VALUES (?)').run('x');
