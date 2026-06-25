var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var jsonToCSVRouter = require('./routes/jsonToCSV');
var csvToJSONRouter = require('./routes/CSVtoJson');

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/api/json-to-csv', jsonToCSVRouter);
app.use('/api/csv-to-json', csvToJSONRouter);

module.exports = app;