// GET /seats - public snapshot of the whole seat map (free / held / sold) with counts.
// Served straight from Redis (one pipeline), never from Postgres.
'use strict';

const express = require('express');
const config = require('../config');
const { getSeatMap } = require('../services/inventory');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/seats', asyncHandler(async (req, res) => {
  const seats = await getSeatMap();
  const counts = { free: 0, held: 0, sold: 0 };
  for (const seat of seats) counts[seat.state] += 1;
  res.json({ event: config.EVENT_ID, total: config.TOTAL_UNITS, seats, counts });
}));

module.exports = router;
