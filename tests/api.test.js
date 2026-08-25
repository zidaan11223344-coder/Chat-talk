const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SKIP_LISTEN = 'true';
process.env.JWT_SECRET = 'test-secret';
const { app, createToken, publicUser } = require('../src/server');

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('API index advertises the v1 contract', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'v1');
    assert.match(body.endpoints.rooms, /rooms/);
  });
});

test('health reports degraded mode without DATABASE_URL', async () => {
  delete process.env.DATABASE_URL;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(['not_configured', 'error', 'connected'].includes(body.database));
  });
});

test('unknown routes return a JSON 404', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, 'not_found');
  });
});

test('user serialization removes password hashes and token can be created', () => {
  const user = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'tester',
    display_name: 'Tester',
    avatar_url: null,
    bio: null,
    points: '250',
    created_at: new Date().toISOString(),
    password_hash: 'must-not-leak',
  };
  const serialized = publicUser(user);
  assert.equal(serialized.points, 250);
  assert.equal(serialized.password_hash, undefined);
  assert.match(createToken(user), /^ey[A-Za-z0-9_-]+\./);
});
