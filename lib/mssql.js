/*! Module dependencies */
var mssql = require("mssql");
var SqlConnector = require('loopback-connector').SqlConnector;
var ParameterizedSQL = SqlConnector.ParameterizedSQL;
var util = require("util");
var debug = require('debug')('loopback:connector:mssql');

var name = "mssql";

exports.name = name;
exports.initialize = function initializeSchema(dataSource, callback) {

  var settings = dataSource.settings || {};
  debug('Settings: %j', settings);
  var driver = new MsSQL(settings);
  dataSource.connector = driver;
  driver.connect(function(err, connection) {
    dataSource.client = connection;
    dataSource.connector.dataSource = dataSource;
    dataSource.connector.tableNameID = dataSource.settings.tableNameID;
    callback && callback(err, connection);
  });
};

function MsSQL(settings) {
  MsSQL.super_.call(this, name, settings);
  // this.name = name;
  // this.settings = settings || {};
  this.settings.server = this.settings.host || this.settings.hostname;
  this.settings.user = this.settings.user || this.settings.username;
  this._models = {};
  this._idxNames = {};
}

util.inherits(MsSQL, SqlConnector);

MsSQL.newline = "\r\n";

/*!
 * This is a workaround to the limitation that 'msssql' driver doesn't support
 * parameterized SQL execution
 * @param {String} sql The SQL string with parameters as (?)
 * @param {*[]) params An array of parameter values
 * @returns {*} The fulfilled SQL string
 */
function format(sql, params) {
  if (Array.isArray(params)) {
    var count = 0;
    var index = -1;
    while (count < params.length) {
      index = sql.indexOf('(?)');
      if (index === -1) {
        return sql;
      }
      sql = sql.substring(0, index) + escape(params[count]) +
        sql.substring(index + 3);
      count++;
    }
  }
  return sql;
}

MsSQL.prototype.connect = function(callback) {
  var self = this;
  if (self.client) {
    return process.nextTick(callback);
  }
  var connection = new mssql.Connection(this.settings, function(err) {
    if (err) {
      debug('Connection error: ', err);
      return callback(err);
    }
    debug('Connection established: ', self.settings.server);
    self.client = connection;
    callback(err, connection);
  });
};

MsSQL.prototype.executeSQL = function(sql, params, options, callback) {
  debug('SQL: %s Parameters: %j', sql, params);
  if (Array.isArray(params) && params.length > 0) {
    sql = format(sql, params);
    debug('Formatted SQL: %s', sql);
  }

  var connection = this.client;

  var transaction = options.transaction;
  if (transaction && transaction.connector === this && transaction.connection) {
    debug('Execute SQL in a transaction');
    connection = transaction.connection;
  }
  var innerCB = function(err, data) {
    debug('Result: %j %j', err, data);
    callback && callback(err, data);
  };

  var request = new mssql.Request(connection);
  // request.verbose = true;
  request.query(sql, innerCB);
};

MsSQL.prototype.disconnect = function disconnect(cb) {
  this.client.close(cb);
};

// MsSQL.prototype.command = function (sql, callback) {
//     return this.execute(sql, callback);
// };

//params
// descr = {
//   model: ...
//   properties: ...
//   settings: ...
// }
MsSQL.prototype.define = function(modelDefinition) {
  if (!modelDefinition.settings) {
    modelDefinition.settings = {};
  }

  this._models[modelDefinition.model.modelName] = modelDefinition;

  //track database index names for this model
  this._idxNames[modelDefinition.model.modelName] = [];
};

MsSQL.prototype.getPlaceholderForValue = function(key) {
  return '(?)';
};

MsSQL.prototype.buildInsertDefaultValues = function(model, data, options) {
  return 'DEFAULT VALUES';
};

MsSQL.prototype.buildInsertInto = function(model, fields, options) {
  var stmt = this.invokeSuper('buildInsertInto', model, fields, options);
  var idName = this.idName(model);
  stmt.merge(MsSQL.newline + 'OUTPUT INSERTED.' +
    this.columnEscaped(model, idName) + ' AS insertId');
  return stmt;
};

MsSQL.prototype.buildInsert = function(model, data, options) {
  var idName = this.idName(model);
  var prop = this.getPropertyDefinition(model, idName);
  var isIdentity = (prop.type === Number && prop.generated !== false);
  if (isIdentity && data[idName] == null) {
    //remove the pkid column if it's in the data, since we're going to insert a
    // new record, not update an existing one.
    delete data[idName];
    //delete the hardcoded id property that jugglindb automatically creates
    // delete data.id;
  }

  var stmt = this.invokeSuper('buildInsert', model, data, options);
  var tblName = this.tableEscaped(model);

  if (isIdentity && data[idName] != null) {
    stmt.sql = 'SET IDENTITY_INSERT ' + tblName + ' ON;' + MsSQL.newline +
      stmt.sql;
  }
  if (isIdentity && data[idName] != null) {
    stmt.sql += MsSQL.newline + 'SET IDENTITY_INSERT ' + tblName + ' OFF;' +
      MsSQL.newline;
  }
  return stmt;
};

MsSQL.prototype.getInsertedId = function(model, info) {
  return info && info.length > 0 && info[0].insertId;
};

MsSQL.prototype.buildDelete = function(model, where, options) {
  var stmt = this.invokeSuper('buildDelete', model, where, options);
  stmt.merge(';SELECT @@ROWCOUNT as count', '');
  return stmt;
};

MsSQL.prototype.getCountForAffectedRows = function(model, info) {
  var affectedCountQueryResult = info && info[0];
  if (!affectedCountQueryResult) {
    return undefined;
  }
  var affectedCount = typeof affectedCountQueryResult.count === 'number' ?
    affectedCountQueryResult.count : undefined;
  return affectedCount;
};

MsSQL.prototype.buildUpdate = function(model, where, data, options) {
  var stmt = this.invokeSuper('buildUpdate', model, where, data, options);
  stmt.merge(';SELECT @@ROWCOUNT as count', '');
  return stmt;
};

// Convert to ISO8601 format YYYY-MM-DDThh:mm:ss[.mmm]
function dateToMsSql(val) {

  var dateStr = val.getUTCFullYear() + '-'
    + fillZeros(val.getUTCMonth() + 1) + '-'
    + fillZeros(val.getUTCDate())
    + 'T' + fillZeros(val.getUTCHours()) + ':' +
    fillZeros(val.getUTCMinutes()) + ':' +
    fillZeros(val.getUTCSeconds()) + '.';

  var ms = val.getUTCMilliseconds();
  if (ms < 10) {
    ms = '00' + ms;
  } else if (ms < 100) {
    ms = '0' + ms;
  } else {
    ms = '' + ms;
  }
  return dateStr + ms;

  function fillZeros(v) {
    return v < 10 ? '0' + v : v;
  }
}

function escape(val) {
  if (val === undefined || val === null) {
    return 'NULL';
  }

  switch (typeof val) {
    case 'boolean':
      return (val) ? 1 : 0;
    case 'number':
      return val + '';
  }

  if (typeof val === 'object') {
    val = (typeof val.toISOString === 'function')
      ? val.toISOString()
      : val.toString();
  }

  val = val.replace(/[\0\n\r\b\t\\\'\"\x1a]/g, function(s) {
    switch (s) {
      case "\0":
        return "\\0";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\b":
        return "\\b";
      case "\t":
        return "\\t";
      case "\x1a":
        return "\\Z";
      case "\'":
        return "''"; // For sql server, double quote
      case "\"":
        return s; // For oracle
      default:
        return "\\" + s;
    }
  });
  // return "q'#"+val+"#'";
  return "'" + val + "'";
}

MsSQL.prototype.toColumnValue = function(prop, val) {
  if (val == null) {
    return null;
  }
  if (prop.type === String) {
    return String(val);
  }
  if (prop.type === Number) {
    if (isNaN(val)) {
      // Map NaN to NULL
      return val;
    }
    return val;
  }

  if (prop.type === Date || prop.type.name === 'Timestamp') {
    if (!val.toUTCString) {
      val = new Date(val);
    }
    val = dateToMsSql(val);
    return val;
  }

  if (prop.type === Boolean) {
    if (val) {
      return true;
    } else {
      return false;
    }
  }

  return this.serializeObject(val);
}

MsSQL.prototype.fromColumnValue = function(prop, val) {
  if (val == null) {
    return val;
  }
  var type = prop && prop.type;
  if (type === Boolean) {
    val = !!val; //convert to a boolean type from number
  }
  if (type === Date) {
    if (!(val instanceof Date)) {
      val = new Date(val.toString());
    }
  }
  return val;
};

MsSQL.prototype.escapeName = function(name) {
  return '[' + name.replace(/\./g, '_') + ']';
};

MsSQL.prototype.getDefaultSchemaName = function() {
  return 'dbo';
};

MsSQL.prototype.tableEscaped = function(model) {
  return this.escapeName(this.schema(model)) + '.' +
    this.escapeName(this.table(model));
};

function buildLimit(limit, offset) {
  if (isNaN(offset)) {
    offset = 0;
  }
  var sql = 'OFFSET ' + offset + ' ROWS';
  if (limit >= 0) {
    sql += ' FETCH NEXT ' + limit + ' ROWS ONLY';
  }
  return sql;
}

MsSQL.prototype.buildColumnNames = function(model, filter) {
  var columnNames = this.invokeSuper('buildColumnNames', model, filter);
  if (filter.limit || filter.offset || filter.skip) {
    var orderBy = this.buildOrderBy(model, filter.order);
    columnNames += ',ROW_NUMBER() OVER' + ' (' + orderBy + ') AS RowNum';
  }
  return columnNames;
};

MsSQL.prototype.buildSelect = function(model, filter, options) {
  if (!filter.order) {
    var idNames = this.idNames(model);
    if (idNames && idNames.length) {
      filter.order = idNames;
    }
  }

  var selectStmt = new ParameterizedSQL('SELECT ' +
    this.buildColumnNames(model, filter) +
    ' FROM ' + this.tableEscaped(model)
  );

  if (filter) {

    if (filter.where) {
      var whereStmt = this.buildWhere(model, filter.where);
      selectStmt.merge(whereStmt);
    }

    if (filter.limit || filter.skip || filter.offset) {
      selectStmt = this.applyPagination(
        model, selectStmt, filter);
    } else {
      if (filter.order) {
        selectStmt.merge(this.buildOrderBy(model, filter.order));
      }
    }

  }
  return this.parameterize(selectStmt);
};

MsSQL.prototype.applyPagination =
  function(model, stmt, filter) {
    var offset = filter.offset || filter.skip || 0;
    if (this.settings.supportsOffsetFetch) {
      // SQL 2012 or later
      // http://technet.microsoft.com/en-us/library/gg699618.aspx
      var limitClause = buildLimit(filter.limit, filter.offset || filter.skip);
      return stmt.merge(limitClause);
    } else {
      // SQL 2005/2008
      // http://blog.sqlauthority.com/2013/04/14/sql-server-tricks-for-row-offset-and-paging-in-various-versions-of-sql-server/
      var paginatedSQL = 'SELECT * FROM (' + stmt.sql + MsSQL.newline +
        ') AS S' + MsSQL.newline + ' WHERE S.RowNum > ' + offset;

      if (filter.limit !== -1) {
        paginatedSQL += ' AND S.RowNum <= ' + (offset + filter.limit);
      }

      stmt.sql = paginatedSQL + MsSQL.newline;
      return stmt;
    }
  };

MsSQL.prototype.buildExpression = function(columnName, operator, operatorValue,
    propertyDefinition) {
  switch (operator) {
    case 'like':
      return new ParameterizedSQL(columnName + " LIKE ? ESCAPE '\\'",
          [operatorValue]);
    case 'nlike':
      return new ParameterizedSQL(columnName + " NOT LIKE ? ESCAPE '\\'",
          [operatorValue]);
    case 'regexp':
      console.warn('Microsoft SQL Server doe not support the regular ' +
          'expression operator');
    default:
      // invoke the base implementation of `buildExpression`
      return this.invokeSuper('buildExpression', columnName, operator,
          operatorValue, propertyDefinition);
  }
};

MsSQL.prototype.ping = function(cb) {
  this.execute('SELECT 1 AS result', cb);
};

require('./discovery')(MsSQL, mssql);
require('./migration')(MsSQL, mssql);
require('./transaction')(MsSQL, mssql);
