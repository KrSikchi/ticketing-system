// Builds and exports the Express application (JSON parsing, routes, 404, error handler).
// It does NOT listen - server.js owns the lifecycle so the same app can be wrapped by an http
// server with Socket.IO attached, or imported by tests.
'use strict';

const express = require('express');
const config = require('./config');
const healthRoutes = require('./routes/health');
const seatsRoutes = require('./routes/seats');
const reserveRoutes = require('./routes/reserve');
const payRoutes = require('./routes/pay');
const bookRoutes = require('./routes/book');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.disable('x-powered-by');
app.set('etag', false); // tiny saving per response; nothing here is cacheable anyway
app.set('trust proxy', config.TRUST_PROXY);
app.use(express.json({ limit: '16kb' }));

app.use(healthRoutes);
app.use(seatsRoutes);
app.use(reserveRoutes);
app.use(payRoutes);
app.use(bookRoutes);

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use(errorHandler);

module.exports = app;
