/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
	return knex.schema.createTable("session", tb=>{
		tb.string("id").primary();
		tb.binary("key").notNullable();
		tb.timestamp("created").notNullable();
		tb.bigInteger("user").references("user.id").unique();
	})
	.createTable("user", tb=>{
		tb.bigIncrements("id").primary();
		tb.string("discordId").notNullable().unique();
		tb.string("discordUsername").notNullable();
	});
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema
		.dropTable("user")
		.dropTable("session");
};
