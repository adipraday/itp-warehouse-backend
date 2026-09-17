export async function create(connection, { consumption_mutation_id, cost_layer_id, quantity, unit_cost }) {
  await connection.execute(
    `INSERT INTO inventory_cost_allocations (consumption_mutation_id, cost_layer_id, quantity, unit_cost)
     VALUES (?, ?, ?, ?)`,
    [consumption_mutation_id, cost_layer_id, quantity, unit_cost]
  );
}
