'use strict';

const path = require('path');
const { createClient } = require('redis');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => {
  console.error('[redis-client] Redis client error:', err);
});

redisClient.connect()
  .then(() => console.log(`[redis-client] Connected to Redis at ${REDIS_URL}`))
  .catch((err) => console.error('[redis-client] Redis connection failed:', err));

module.exports = redisClient;
