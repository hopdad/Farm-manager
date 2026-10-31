-- fleet-faults (slice 1f, docs/contracts-1f.md §5.3, Oct 31): Samsara lists OBD-II codes per
-- control module (`txId`) and doesn't promise that one faultCodes reading carries every module,
-- so a module a reading doesn't name is "no change" for that module's codes. Clearing per module
-- needs to remember which module reported each open OBD-II code, and migration 0007 has no
-- column for it (machine_faults.source_address is J1939-only by its CHECK, 0-255; Samsara's
-- OBD-II txIds are CAN ids such as 2024 = 0x7E8). A side table rather than a column, so the
-- Drizzle mirror test (src/db/schema.db.test.ts, every column of a mirrored table) stays green
-- until the integrator folds this into a migration (suggested: a `module text` column on
-- farm.machine_faults instead, with its Drizzle mirror, and src/db/queries/machine-faults.ts
-- reading it there).
--
-- Written and read only by src/db/queries/machine-faults.ts. One row per OPEN OBD-II fault that a
-- module named (the module that reported it last); rows go with their fault (cascade).
-- Idempotent (db/pending/README.md).

create table if not exists farm.machine_fault_modules (
  fault_id uuid primary key references farm.machine_faults (id) on delete cascade,
  module text not null,
  updated_at timestamp with time zone default now() not null,
  constraint machine_fault_modules_module_check check (length(module) between 1 and 64)
);

comment on table farm.machine_fault_modules is
  'fleet-faults (db/pending): the control module (Samsara OBD-II txId) that reported an open OBD-II fault, so a reading that leaves a module out leaves its codes alone.';
