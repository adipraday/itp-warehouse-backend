import mysql from 'mysql2/promise';

export function createPool(env) {
  return mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    queueLimit: 0,
    decimalNumbers: false,
    dateStrings: true,
    // MariaDB 10.5+ sends extended column metadata, and mysql2 then returns JSON
    // columns already parsed; 10.4 (local XAMPP) sends LONGTEXT strings. Force
    // strings everywhere so readers see one shape on every MariaDB version.
    jsonStrings: true
  });
}
