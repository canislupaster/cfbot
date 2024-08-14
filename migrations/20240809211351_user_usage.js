/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.alterTable("user", tb=>{
		//-_-
		if (!knex.schema.hasColumn("user", "cost"))
			tb.double("cost").defaultTo(0).notNullable();
		if (!knex.schema.hasColumn("user", "costStart"))
			tb.timestamp("costStart");
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
