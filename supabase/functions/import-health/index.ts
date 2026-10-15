import {createRuntimeHandler} from './runtime.mjs';
// Only the existing Iron Ledger project is accepted. Fixed-owner token mappings
// live in health_private, readable solely through the trusted server credentials.
Deno.serve(createRuntimeHandler(Deno.env));
