/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.alterTable("user", tb=>{
		tb.double("cost").defaultTo(0).notNullable();
	});
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.alterTable("user", tb=>{
		//not supported by sqlite...
		// tb.dropColumn("cost");
		// tb.dropColumn("costStart");
	});
};
