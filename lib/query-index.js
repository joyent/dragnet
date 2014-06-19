/*
 * lib/query-index.js: execute a query using an index
 */

var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_krill = require('krill');
var mod_semver = require('semver');
var mod_skinner = require('skinner');
var mod_sqlite3 = require('sqlite3');
var mod_util = require('util');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_dragnet = require('./dragnet'); /* XXX */
var mod_dragnet_impl = require('./dragnet-impl');

module.exports = QueryIndex;

var DB_VERSION = '~1';

/*
 * Arguments include:
 *
 *     log		bunyan-style logger
 *
 *     filename		index file name
 */
function QueryIndex(args)
{
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.string(args.filename, 'args.filename');

	this.qi_log = args.log;
	this.qi_dbfilename = args.filename;
	this.qi_allowed_versions = DB_VERSION;

	this.qi_config = null;
	this.qi_columns = null;

	this.qi_db = new mod_sqlite3.Database(
	    this.qi_dbfilename, mod_sqlite3.OPEN_READONLY);
	this.qi_db.on('open', function () {
		self.qi_log.info('opened database "%s"', self.qi_dbfilename);
		self.loadConfig();
	});

	this.qi_db.on('error', function (err) {
		self.qi_log.error(err, 'fatal database error');
		self.emit('error', new VError(err, 'database error'));
	});
}

mod_util.inherits(QueryIndex, mod_events.EventEmitter);

QueryIndex.prototype.loadConfig = function ()
{
	var self = this;
	var error = null;
	var barrier;

	barrier = mod_vasync.barrier();
	barrier.start('dragnet_config');
	this.qi_db.all('SELECT * FROM dragnet_config', function (err, rows) {
		barrier.done('dragnet_config');

		if (err) {
			error = err;
			return;
		}

		self.qi_config = {};
		rows.forEach(function (r) {
			self.qi_config[r.key] = r.value;
		});

		if (!self.qi_config.hasOwnProperty('version')) {
			error = new VError('index missing dragnet "version"');
		} else if (!mod_semver.satisfies(self.qi_config['version'],
		    self.qi_allowed_versions)) {
			error = new VError('unsupported index version: "%s"',
			    self.qi_config['version']);
		}
	});

	barrier.start('dragnet_columns');
	this.qi_db.all('SELECT * FROM dragnet_columns', function (err, rows) {
		barrier.done('dragnet_columns');

		if (error !== null)
			return;

		if (err) {
			error = err;
			return;
		}

		self.qi_columns = {};
		rows.forEach(function (r) {
			self.qi_columns[r.name] = r;
		});
	});

	barrier.on('drain', function () {
		if (error !== null) {
			self.emit('error', error);
		} else {
			self.emit('ready');
		}
	});
};

QueryIndex.prototype.run = function (query, callback)
{
	var self = this;
	var filter, columns, groupby, stmt, sql, rows, stream;

	mod_assertplus.ok(this.qi_config !== null && this.qi_columns !== null,
	    'QueryIndex is not initialized');

	/*
	 * Set up an aggregator for the results.  It's kind of annoying that we
	 * have to do this, since the results will usually be properly
	 * aggregated already.  The problem is that the database will return a
	 * separate rows for each entry in a numeric distribution, while our
	 * caller expects these to be aggregated together.
	 */
	stream = mod_dragnet_impl.queryAggrStream({ 'query': query });

	/* Build WHERE clause. */
	filter = mod_jsprim.deepCopy(query.qc_filter || {});
	this.escapeFilter(filter);

	if (query.qc_breakdowns) {
		groupby = query.qc_breakdowns.map(function (b) {
			return (self.sqlite3Escape(b.name));
		});
		columns = query.qc_breakdowns.map(function (b) {
			return (self.sqlite3Escape(b.name));
		});
	} else {
		groupby = [];
		columns = [];
	}

	columns.push('SUM(value) as value');

	sql = 'SELECT ';
	sql += (columns.join(','));
	sql += ' from dragnet_index ';
	sql += this.filterWhere(filter);
	if (groupby.length > 0)
		sql += 'GROUP BY ' + (groupby.join(','));

	mod_vasync.waterfall([
	    function (stepcb) {
		self.qi_log.trace('prepare SQL', sql);
		stmt = self.qi_db.prepare(sql, stepcb);
	    },
	    function (stepcb) {
		self.qi_log.trace('execute SQL', sql);
		stmt.all(stepcb);
	    },
	    function (results, stepcb) {
		self.qi_log.trace('query results', results.length);
		results.forEach(function (r) {
			stream.write(self.deserializeRow(query, r));
		});
		stmt.finalize(stepcb);
	    },
	    function (stepcb) {
		self.qi_log.trace('statement finalized');
		stream.on('data', function (chunk) {
			/* There should be only one datum. */
			rows = chunk;
		});
		stream.on('end', stepcb);
		stream.end();
	    }
	], function (err) {
		if (err)
			err = new VError(err, 'executing query "%s"', sql);
		callback(err, rows);
	});
};

QueryIndex.prototype.deserializeRow = function (query, row)
{
	var breakdowns = query.qc_breakdowns;
	var point = {
	    'fields': {},
	    'value': row.value
	};
	var self = this;

	breakdowns.forEach(function (field, i) {
		var val = row[self.sqlite3Escape(field.field)];
		point['fields'][field.field] = val;
	});

	return (point);
};

/* XXX commonize with index-scan.js */
QueryIndex.prototype.sqlite3Escape = function (str)
{
	return (str.replace(/\./g, '_'));
};

/* XXX internal knowledge */
QueryIndex.prototype.escapeFilter = function (filter)
{
	if (mod_jsprim.isEmpty(filter))
		return;

	if (filter['and']) {
		filter['and'].forEach(this.escapeFilter.bind(this));
		return;
	}

	if (filter['or']) {
		filter['or'].forEach(this.escapeFilter.bind(this));
		return;
	}

	var key = Object.keys(filter)[0];
	filter[key][0] = this.sqlite3Escape(filter[key][0]);
};

QueryIndex.prototype.filterWhere = function (filter)
{
	var pred = mod_krill.createPredicate(filter);
	if (pred.trivial())
		return ('');

	return ('WHERE ' + pred.toCStyleString() + ' ');
};