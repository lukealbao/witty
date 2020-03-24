'use strict';

import * as fs from 'fs';
import * as path from 'path';
import Form from 'form-data';
import axios from 'axios';
import SQLite from 'better-sqlite3';
import { RTMClient } from '@slack/rtm-api';
import { WebAPICallResult } from '@slack/web-api';
import dotenv from 'dotenv';

import { Store } from '../src/lib/store';
const SCHEMA = path.resolve(__dirname, '../sql/schema.sql');

interface Env {
  TEAMNAME: string;
  BOTHOME: string;
  BOTTOKEN: string;
  ADMINTOKEN: string;
}

function validateEnv(env: dotenv.DotenvParseOutput) {
  const requiredVars = ['TEAMNAME', 'BOTHOME', 'BOTTOKEN', 'ADMINTOKEN'];

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

  main(providedEnv.parsed || {})
    .then(() => {
      console.error(`Wittybot ready for ${process.env.TEAMNAME}`);
      process.exit(0);
    })
    .catch(error => {
      console.error(`Fatal error: ${error.stack}`);
      process.exit(1);
    });
}

async function main(opts: dotenv.DotenvParseOutput) {
  validateEnv(opts);
  const env: Env = (opts as unknown) as Env;

  const dbFile = `/cfg/witty-${env.TEAMNAME}.sqlite3`;

  if (fs.existsSync(dbFile)) {
    const err = `
  FATAL: Database already exists at ${dbFile}

  This command is for initializing a new workspace, and your workspace appears to
  already be initialized. Running this command would overwrite your local
  ownership data.

  If you're sure you want to do this, remove the database file
  first. (Note, the path refers to the docker container's location. You should
  know where the real file is on your host.)
`;
    console.error(err);
    process.exit(1);
  }
  const db = new SQLite(dbFile);

  await initDB(db, env.TEAMNAME, env.BOTHOME, env.BOTTOKEN);
  await seedDB(db, env.TEAMNAME, env.ADMINTOKEN);
}

// initDB: Load schema, initialize metadata row for app.
async function initDB(db: SQLite.Database, team: string, channel: string, token: string) {
  interface StartResponse extends WebAPICallResult {
    self: { id: string; name: string };
  }
  const rtm = new RTMClient(token);
  const { self } = (await rtm.start()) as StartResponse;
  const channelId = await getChannelId(channel, token);

  const schema = fs.readFileSync(SCHEMA, 'utf8');
  db.exec(schema);

  const init = db.prepare(`
insert into wittymeta (team, homechannelid, botid, adminid, createdat, updatedat)
values (:team, :homechannelid, :botid, :adminid, current_timestamp, current_timestamp)
`);
  init.run({
    team,
    homechannelid: channelId,
    botid: self.id,
    adminid: null,
  });
}

// seedDB: Load all existing emoji already in the workspace.
async function seedDB(db: SQLite.Database, team: string, admintoken: string) {
  const store = new Store(db.name);
  interface EmojiListEntry {
    name: string;
    // 0 if original; any aliases are 0.
    is_alias: number;
    // Epoch time
    created: number;
    // user_display_name is also present, but not used here.
    user_id: string;
    user_display_name: string;
  }

  interface ListResponse {
    data: {
      ok: boolean;
      error?: string;
      emoji: EmojiListEntry[];
      paging: {
        page: number;
        pages: number;
      };
    };
  }

  const list: EmojiListEntry[] = [];
  let page = 1;
  let pages: number;
  do {
    const form = new Form();
    form.append('page', page);
    form.append('count', 1000);
    form.append('token', admintoken);

    const res: ListResponse = await axios({
      url: `https://${team}.slack.com/api/emoji.adminList`,
      method: 'post',
      data: form,
      headers: form.getHeaders(),
    });

    const { data } = res;
    if (!data.ok) {
      throw new Error(`Could not seed database: ${data.error}`);
    } else {
      list.push(...res.data.emoji);
      page = res.data.paging.page;
      pages = res.data.paging.pages;
    }
  } while (page < pages);

  process.stdout.write(`Loading ${list.length} existing emoji from slack... `);
  for (const emoji of list) {
    store.addEmoji(emoji.user_id, emoji.name, emoji.created);
  }
  console.log('done.');
}

async function getChannelId(name: string, token: string): Promise<string> {
  interface ChanResponse {
    data: {
      ok: boolean;
      error?: string;
      channels: {
        id: string;
        name: string;
        creator: string;
        num_members: number;
        previous_names: string[];
      }[];
      response_metadata: {
        next_cursor: string;
      };
    };
  }

  interface Chan {
    id: string;
    name: string;
    num_members: number;
    previous_names: string[];
  }
  let cursor: string | void;
  do {
    const res: ChanResponse = await axios({
      url: `https://slack.com/api/conversations.list`,
      method: 'get',
      params: {
        token,
        exclude_archived: true,
        exclude_members: true,
        cursor,
      },
    });

    if (!res.data.ok) {
      throw new Error(`Could not load channel: ${res.data.error}`);
    } else {
      cursor = res.data.response_metadata.next_cursor;
      const home = res.data.channels.find(c => c.name === name || c.previous_names.includes(name));
      if (home) {
        return home.id;
      }
    }
  } while (cursor);

  throw new Error(`Could not find channel id for ${name}`);
}
