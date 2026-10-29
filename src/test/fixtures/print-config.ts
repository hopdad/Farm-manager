// Prints the validated config of the current working directory (used by src/config.test.ts).
import { getConfig } from '../../config';

const c = getConfig();
console.log(
  JSON.stringify({
    DATABASE_URL: c.DATABASE_URL,
    DB_PORT: c.DB_PORT,
    SIM_SPEED: c.SIM_SPEED,
    projectDir: c.projectDir,
  }),
);
