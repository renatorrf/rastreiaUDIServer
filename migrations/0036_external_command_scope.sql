SET LOCAL search_path TO rastreia,public;
-- Qualify the outer field: external_orders also has a provider external_order_id.
DROP POLICY integration_commands_scope ON integration_commands;
CREATE POLICY integration_commands_scope ON integration_commands
 USING(EXISTS(SELECT 1 FROM external_orders o WHERE o.id=integration_commands.external_order_id))
 WITH CHECK(EXISTS(SELECT 1 FROM external_orders o WHERE o.id=integration_commands.external_order_id));
