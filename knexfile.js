import 'dotenv/config';

export default {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_NAME ?? 'warehouse_db',
    user: process.env.DB_USER ?? 'warehouse_user',
    password: process.env.DB_PASSWORD ?? 'change_me'
  },
  migrations: {
    directory: './migrations',
    extension: 'js'
  }
};
