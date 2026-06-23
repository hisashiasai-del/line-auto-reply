require('dotenv').config();
const express = require('express');
const path = require('path');
const webhookRouter = require('./webhook');
const apiRouter = require('./api');
const { startScheduler } = require('./scheduler');

const app = express();

app.use('/webhook', webhookRouter);

app.use(express.json());
app.use('/api', apiRouter);
app.use('/admin', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  startScheduler();
});
