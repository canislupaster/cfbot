// Update with your config settings.

/**
 * @type { import("knex").Knex.Config }
 */
module.exports = {
  client: 'better-sqlite3',
  connection: { filename: './db.sqlite' },
  useNullAsDefault: false
};
