'use strict';

import WittyService, { Config } from '../src/lib/service';
import dotenv from 'dotenv';

interface Env {
  BOTTOKEN: string;
  ADMINTOKEN: string;
  TEAMNAME: string;
}

function validateEnv(env: dotenv.DotenvParseOutput) {
  const requiredVars = ['TEAMNAME', 'BOTTOKEN', 'ADMINTOKEN'];

  const missing = requiredVars.filter(v => !env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing .env variables: (${missing})`);
  }
}

if (require.main === module) {
  const providedEnv = dotenv.config({ path: '/cfg/.env' });
  if (providedEnv.error) {
    throw providedEnv.error;
  }

  main(providedEnv.parsed || {}).catch(error => {
    process.stderr.write(`Process ended abnormally: ${error.stack}\n`);
    process.exit(1);
  });
}

async function main(opts: dotenv.DotenvParseOutput) {
  validateEnv(opts);
  const env: Env = (opts as unknown) as Env;

  const config: Config = {
    bottoken: env.BOTTOKEN,
    admintoken: env.ADMINTOKEN,
    dbfile: `/cfg/witty-${env.TEAMNAME}.sqlite3`,
  };

  const rtm = new WittyService(config);
  await rtm.start();
}
